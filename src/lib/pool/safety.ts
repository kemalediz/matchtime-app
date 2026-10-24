/**
 * BLOCKS, REPORTS AND A PERSON LOOKING AT A PAUSE, server side (slice L7,
 * 2026-10-24). Thin I/O around `reliability-rules.ts`. Plan sections 6 and
 * 9; decisions L7.x.
 *
 *   setClubBlock        an organiser stops offering his club's games to a
 *                       guest. Silent: the guest is never told. L4 reads
 *                       `PoolBlock` either way (`candidates.ts`).
 *   setPlayerBlock      a player stops one club's offers (his manage page or
 *                       the offer page). Silent: the club is never told.
 *   reportFromClub      an organiser reports a problem with a guest;
 *   reportFromPlayer    a player reports a problem with a club. Both go to
 *                       the PLATFORM OWNER only (`PoolReport` and one DM,
 *                       the owner's own channel `owner-dm.ts`), never to the
 *                       other side. Open reports from two clubs pause the
 *                       player pending a person's review.
 *   requestPauseReview  a player asks a person to look at a pause MatchTime
 *                       decided (the privacy policy's promise).
 *   loadPoolSafety, markReportReviewed, liftPoolPause
 *                       the owner's page, /admin/pool/safety.
 *   stampSafetyRecordsGone, purgeSafetyRecords
 *                       retention (decision L0.3): block and report records
 *                       stay 24 months after the profile is deleted, so a
 *                       blocked person cannot simply re-join; then the daily
 *                       housekeeping removes them.
 *
 * WHO MAY: a club only about someone who was its guest; a player only about
 * a club that offered him a game or had him as a guest. So nobody can block
 * or report a stranger by guessing an id. The callers prove the actor (an
 * organiser of the club; the signed-in player or the offer's holder).
 */
import { db } from "../db";
import { appUrl } from "../app-url";
import { formatLondon } from "../london-time";
import { normaliseLang } from "../i18n/lang";
import { poolSafetyCopy } from "../i18n/pool-safety";
import { queueOwnerDm } from "../owner-dm";
import { queuePlatformDm } from "../platform-jobs";
import { isPoolOffersEnabled } from "./flags";
import { buildPoolManageLink } from "./links";
import { clubsMarkingTooMany, pausesForReports, reportTextOf, safetyRecordPurgeBefore, selfResumeFrom } from "./reliability-rules";
import { turnUpRecordOf, type TurnUpRecord } from "./turn-up";
import { isOneOf, GUEST_RESULTS, POOL_MATCHTIME_PAUSE_REASONS, type GuestResult, type PoolPauseReason, type PoolReportBy } from "./vocab";

type Env = Record<string, string | undefined>;
type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

export const POOL_SAFETY_PATH = "/admin/pool/safety";

const isMatchTimePause = (r: string | null): r is (typeof POOL_MATCHTIME_PAUSE_REASONS)[number] =>
  !!r && (POOL_MATCHTIME_PAUSE_REASONS as readonly string[]).includes(r);

// ── Who may ────────────────────────────────────────────────────────────

/** Was he ever this club's guest (a guest place, or a guest membership)? */
async function wasGuestOf(orgId: string, userId: string): Promise<boolean> {
  const [place, mem] = await Promise.all([
    db.guestPlace.findFirst({ where: { orgId, userId }, select: { id: true } }),
    db.membership.findFirst({ where: { orgId, userId, guestMatchId: { not: null } }, select: { id: true } }),
  ]);
  return !!place || !!mem;
}

/** Did this club offer him a game (delivered) or have him as a guest? */
async function clubKnowsPlayer(orgId: string, userId: string): Promise<boolean> {
  const [offer, place] = await Promise.all([
    db.poolOffer.findFirst({ where: { orgId, userId, sentAt: { not: null } }, select: { id: true } }),
    db.guestPlace.findFirst({ where: { orgId, userId }, select: { id: true } }),
  ]);
  return !!offer || !!place;
}

// ── Blocks ─────────────────────────────────────────────────────────────

export type SafetyResult = { ok: true } | { ok: false; reason: "not-allowed" | "too-short" | "not-paused" | "asked-already" | "failed" };

async function setBlock(by: PoolReportBy, a: { orgId: string; userId: string; byUserId: string | null; blocked: boolean }): Promise<void> {
  if (a.blocked) {
    await db.poolBlock.upsert({
      where: { orgId_userId_by: { orgId: a.orgId, userId: a.userId, by } },
      create: { orgId: a.orgId, userId: a.userId, by, byUserId: a.byUserId },
      update: {},
    });
  } else {
    await db.poolBlock.deleteMany({ where: { orgId: a.orgId, userId: a.userId, by } });
  }
  console.log(`[pool-safety] ${by} block ${a.blocked ? "on" : "off"}: org ${a.orgId}, user ${a.userId}`);
}

/** The CALLER has proven `byUserId` is an organiser of `orgId`. */
export async function setClubBlock(a: { orgId: string; userId: string; byUserId: string; blocked: boolean }): Promise<SafetyResult> {
  if (!(await wasGuestOf(a.orgId, a.userId))) return { ok: false, reason: "not-allowed" };
  await setBlock("club", a);
  return { ok: true };
}

/** The CALLER has proven `userId` is the signed-in player or the offer's holder. */
export async function setPlayerBlock(a: { userId: string; orgId: string; blocked: boolean }): Promise<SafetyResult> {
  if (!(await clubKnowsPlayer(a.orgId, a.userId))) return { ok: false, reason: "not-allowed" };
  await setBlock("player", { ...a, byUserId: a.userId });
  return { ok: true };
}

/** The clubs a player can block or report: those that offered him a game
 *  or had him as a guest, with whether he blocked each. Names only. */
export async function loadPlayerClubs(userId: string): Promise<{ orgId: string; name: string; blocked: boolean }[]> {
  const [offers, places, blocks] = await Promise.all([
    db.poolOffer.findMany({ where: { userId, sentAt: { not: null } }, select: { orgId: true }, distinct: ["orgId"] }),
    db.guestPlace.findMany({ where: { userId }, select: { orgId: true }, distinct: ["orgId"] }),
    db.poolBlock.findMany({ where: { userId, by: "player" }, select: { orgId: true } }),
  ]);
  const ids = [...new Set([...offers, ...places].map((o) => o.orgId))];
  if (ids.length === 0) return [];
  const orgs = await db.organisation.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const blocked = new Set(blocks.map((b) => b.orgId));
  return orgs.map((o) => ({ orgId: o.id, name: o.name, blocked: blocked.has(o.id) })).sort((a, b) => a.name.localeCompare(b.name));
}

/** His own turn-up record, for his manage page: counts only. */
export async function loadOwnTurnUp(userId: string): Promise<TurnUpRecord> {
  const rows = await db.guestPlace.findMany({ where: { userId }, select: { result: true } });
  return turnUpRecordOf(rows.map((r) => (isOneOf(GUEST_RESULTS, r.result) ? r.result : ("booked" as GuestResult))));
}

// ── Reports ────────────────────────────────────────────────────────────

const day = (now: Date) => formatLondon(now, "yyyy-MM-dd");

/** One DM to the owner per player per London day, however many reports. */
async function tellOwner(purpose: "owner-pool-report" | "owner-pool-review", userId: string, text: string, now: Date): Promise<void> {
  try {
    await queueOwnerDm(`${text} ${appUrl(POOL_SAFETY_PATH)}`, purpose, `${purpose}:${userId}:${day(now)}`, now);
  } catch (err) {
    console.error(`[pool-safety] owner DM (${purpose}) not queued:`, err instanceof Error ? err.message : "failed");
  }
}

async function writeReport(a: { orgId: string; userId: string; by: PoolReportBy; byUserId: string; matchId?: string | null; text: unknown; now: Date }): Promise<SafetyResult> {
  const text = reportTextOf(a.text);
  if (!text) return { ok: false, reason: "too-short" };
  const report = await db.poolReport.create({
    data: { orgId: a.orgId, userId: a.userId, by: a.by, byUserId: a.byUserId, matchId: a.matchId ?? null, text, createdAt: a.now },
    select: { id: true },
  });
  console.log(`[pool-safety] report ${report.id} by ${a.by}: org ${a.orgId}, user ${a.userId}`);
  await tellOwner(
    "owner-pool-report",
    a.userId,
    a.by === "club" ? "MatchTime pool: a club reported a problem with a guest. Please look:" : "MatchTime pool: a player reported a problem with a club. Please look:",
    a.now,
  );
  return { ok: true };
}

/** The CALLER has proven `byUserId` is an organiser of `orgId`. */
export async function reportFromClub(a: { orgId: string; userId: string; byUserId: string; text: unknown; matchId?: string | null; now?: Date; env?: Env }): Promise<SafetyResult> {
  const now = a.now ?? new Date();
  if (!(await wasGuestOf(a.orgId, a.userId))) return { ok: false, reason: "not-allowed" };
  const r = await writeReport({ ...a, by: "club", now });
  if (r.ok) await pauseForReportsIfDue(a.userId, now, a.env);
  return r;
}

/** The CALLER has proven `userId` is the signed-in player or the offer's holder. */
export async function reportFromPlayer(a: { userId: string; orgId: string; text: unknown; matchId?: string | null; now?: Date }): Promise<SafetyResult> {
  const now = a.now ?? new Date();
  if (!(await clubKnowsPlayer(a.orgId, a.userId))) return { ok: false, reason: "not-allowed" };
  return writeReport({ ...a, by: "player", byUserId: a.userId, now });
}

/** Open reports from two clubs pause him pending a person's review (plan 9). */
async function pauseForReportsIfDue(userId: string, now: Date, env?: Env): Promise<void> {
  const reports = await db.poolReport.findMany({ where: { userId, by: "club", reviewedAt: null }, select: { orgId: true, by: true } });
  if (!pausesForReports(reports.map((r) => ({ orgId: r.orgId, by: r.by as PoolReportBy, reviewed: false })))) return;
  const p = await db.poolProfile.findUnique({ where: { userId }, select: { id: true, status: true, pausedReason: true, language: true, user: { select: { phoneNumber: true } } } });
  if (!p || p.status === "pending-verify" || p.pausedReason === "reports" || p.pausedReason === "admin") return;
  const done = await db.poolProfile.updateMany({
    where: { id: p.id, status: p.status, pausedReason: p.pausedReason },
    data: p.status === "stopped" ? { pausedReason: "reports", pausedAt: now } : { status: "paused", pausedReason: "reports", pausedAt: now },
  });
  if (done.count === 0) return;
  console.log(`[pool-safety] ${userId}: pool offers paused after reports from two clubs`);
  if (p.status === "stopped" || !p.user?.phoneNumber || !isPoolOffersEnabled(env)) return;
  await dmPlayer(p.user.phoneNumber, `reports:${p.id}:${now.getTime()}`, poolSafetyCopy(normaliseLang(p.language)).dm_paused_reports({ link: await buildPoolManageLink(userId) }));
}

async function dmPlayer(phone: string, refId: string, text: string): Promise<void> {
  try {
    await queuePlatformDm({ phone, purpose: "pool-paused", refId, text });
  } catch (err) {
    console.error(`[pool-safety] DM ${refId} not queued:`, err instanceof Error ? err.message : "failed");
  }
}

// ── A person looks at a pause ──────────────────────────────────────────

/** The signed-in player asks a person to look at his MatchTime pause. */
export async function requestPauseReview(userId: string, now: Date = new Date()): Promise<SafetyResult> {
  const p = await db.poolProfile.findUnique({ where: { userId }, select: { id: true, status: true, pausedReason: true, reviewRequestedAt: true } });
  if (!p || !isMatchTimePause(p.pausedReason)) return { ok: false, reason: "not-paused" };
  if (p.reviewRequestedAt) return { ok: false, reason: "asked-already" };
  const done = await db.poolProfile.updateMany({ where: { id: p.id, pausedReason: p.pausedReason, reviewRequestedAt: null }, data: { reviewRequestedAt: now, lastActiveAt: now } });
  if (done.count === 0) return { ok: false, reason: "asked-already" };
  console.log(`[pool-safety] ${userId}: asked for a person to look at the ${p.pausedReason} pause`);
  await tellOwner("owner-pool-review", userId, "MatchTime pool: a player asked a person to look at his pause. Please look:", now);
  return { ok: true };
}

// ── The owner's page ───────────────────────────────────────────────────

export interface SafetyReportRow {
  id: string;
  by: PoolReportBy;
  club: string;
  player: string | null;
  userId: string;
  text: string;
  createdAt: Date;
}

export interface SafetyPauseRow {
  userId: string;
  name: string;
  reason: PoolPauseReason;
  status: string;
  pausedAt: Date | null;
  reviewRequestedAt: Date | null;
  record: TurnUpRecord;
}

export interface PoolSafetyView {
  reports: SafetyReportRow[];
  pauses: SafetyPauseRow[];
  flaggedClubs: { orgId: string; name: string; players: number }[];
}

export async function loadPoolSafety(now: Date = new Date()): Promise<PoolSafetyView> {
  const since = new Date(now.getTime() - 31 * 24 * 3600_000);
  const [reports, paused, marks] = await Promise.all([
    db.poolReport.findMany({ where: { reviewedAt: null }, orderBy: { createdAt: "desc" }, take: 200 }),
    db.poolProfile.findMany({
      where: { pausedReason: { in: [...POOL_MATCHTIME_PAUSE_REASONS] } },
      select: { userId: true, displayName: true, status: true, pausedReason: true, pausedAt: true, reviewRequestedAt: true },
      orderBy: { pausedAt: "desc" },
      take: 200,
    }),
    db.guestPlace.findMany({ where: { result: "no-show", source: "pool", resultById: { not: null }, resultAt: { gte: since } }, select: { orgId: true, userId: true, resultAt: true } }),
  ]);
  const flagged = clubsMarkingTooMany(marks.map((m) => ({ orgId: m.orgId, userId: m.userId, at: m.resultAt! })), now);
  const orgIds = [...new Set([...reports.map((r) => r.orgId), ...flagged.map((f) => f.orgId)])];
  const userIds = [...new Set([...reports.map((r) => r.userId), ...paused.map((p) => p.userId!).filter(Boolean)])];
  const [orgs, users, places] = await Promise.all([
    db.organisation.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }),
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
    db.guestPlace.findMany({ where: { userId: { in: paused.map((p) => p.userId!).filter(Boolean) } }, select: { userId: true, result: true } }),
  ]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const userName = new Map(users.map((u) => [u.id, u.name]));
  return {
    reports: reports.map((r) => ({
      id: r.id,
      by: r.by as PoolReportBy,
      club: orgName.get(r.orgId) ?? "?",
      player: userName.get(r.userId) ?? null,
      userId: r.userId,
      text: r.text,
      createdAt: r.createdAt,
    })),
    pauses: paused
      .filter((p) => !!p.userId)
      .map((p) => ({
        userId: p.userId!,
        name: p.displayName,
        reason: p.pausedReason as PoolPauseReason,
        status: p.status,
        pausedAt: p.pausedAt,
        reviewRequestedAt: p.reviewRequestedAt,
        record: turnUpRecordOf(places.filter((x) => x.userId === p.userId).map((x) => (isOneOf(GUEST_RESULTS, x.result) ? x.result : "booked"))),
      })),
    flaggedClubs: flagged.map((f) => ({ ...f, name: orgName.get(f.orgId) ?? "?" })),
  };
}

/** The CALLER has proven `ownerId` is a superadmin. */
export async function markReportReviewed(reportId: string, ownerId: string, now: Date = new Date()): Promise<boolean> {
  const done = await db.poolReport.updateMany({ where: { id: reportId, reviewedAt: null }, data: { reviewedAt: now, reviewedBy: ownerId } });
  return done.count === 1;
}

/**
 * The owner lifts a pause MatchTime decided (the CALLER has proven a
 * superadmin). His open club reports count as looked at (so they cannot
 * pause him again at once), and he is told once that offers are on again.
 * A stopped profile only loses the reason: he withdrew consent, so it
 * stays stopped and hears nothing.
 */
export async function liftPoolPause(userId: string, ownerId: string, now: Date = new Date(), env?: Env): Promise<boolean> {
  const p = await db.poolProfile.findUnique({ where: { userId }, select: { id: true, status: true, pausedReason: true, language: true, user: { select: { phoneNumber: true } } } });
  if (!p || !isMatchTimePause(p.pausedReason)) return false;
  const done = await db.$transaction(async (tx: Tx) => {
    const r = await tx.poolProfile.updateMany({
      where: { id: p.id, pausedReason: p.pausedReason, status: p.status },
      data: p.status === "paused" ? { status: "active", pausedReason: null, pausedAt: null, reviewRequestedAt: null, lastActiveAt: now } : { pausedReason: null, pausedAt: null, reviewRequestedAt: null },
    });
    if (r.count === 1) await tx.poolReport.updateMany({ where: { userId, by: "club", reviewedAt: null }, data: { reviewedAt: now, reviewedBy: ownerId } });
    return r.count === 1;
  });
  if (!done) return false;
  console.log(`[pool-safety] ${userId}: the ${p.pausedReason} pause lifted by ${ownerId}`);
  if (p.status === "paused" && p.user?.phoneNumber && isPoolOffersEnabled(env)) {
    await dmPlayer(p.user.phoneNumber, `resumed:${p.id}:${now.getTime()}`, poolSafetyCopy(normaliseLang(p.language)).dm_resumed({ link: await buildPoolManageLink(userId) }));
  }
  return true;
}

/** When he may lift his pause himself (his manage page), or null. */
export function ownResumeFrom(p: { pausedReason: PoolPauseReason | null; pausedAt: Date | null }): Date | null {
  return p.pausedReason ? selfResumeFrom({ reason: p.pausedReason, pausedAt: p.pausedAt }) : null;
}

// ── Retention ──────────────────────────────────────────────────────────

/** In the profile's deletion transaction: his blocks and reports start
 *  their 24 months. */
export async function stampSafetyRecordsGone(tx: Tx, userId: string, now: Date): Promise<void> {
  await tx.poolBlock.updateMany({ where: { userId }, data: { userGoneAt: now } });
  await tx.poolReport.updateMany({ where: { userId }, data: { userGoneAt: now } });
}

/** The daily housekeeping: records 24 months past the deletion of a
 *  profile that was not made again since. */
export async function purgeSafetyRecords(now: Date = new Date()): Promise<{ blocks: number; reports: number }> {
  const before = safetyRecordPurgeBefore(now);
  const gone = async (rows: { userId: string }[]) => {
    const ids = [...new Set(rows.map((r) => r.userId))];
    if (ids.length === 0) return [];
    const back = new Set((await db.poolProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true } })).map((p) => p.userId));
    return ids.filter((id) => !back.has(id));
  };
  const [b, r] = await Promise.all([
    db.poolBlock.findMany({ where: { userGoneAt: { lt: before } }, select: { userId: true } }).then(gone),
    db.poolReport.findMany({ where: { userGoneAt: { lt: before } }, select: { userId: true } }).then(gone),
  ]);
  const blocks = b.length ? (await db.poolBlock.deleteMany({ where: { userId: { in: b }, userGoneAt: { lt: before } } })).count : 0;
  const reports = r.length ? (await db.poolReport.deleteMany({ where: { userId: { in: r }, userGoneAt: { lt: before } } })).count : 0;
  return { blocks, reports };
}
