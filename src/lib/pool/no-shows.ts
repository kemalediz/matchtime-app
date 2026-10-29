/**
 * NO-SHOWS AND THE RESULT OF A GUEST'S GAME, server side (slice L7,
 * 2026-10-24). Thin I/O around `reliability-rules.ts`.
 *
 *   loadGuestResultsPanel  the match page's "Did your guests turn up?":
 *                          every guest who held a place on this match,
 *                          first name and last initial, his result, and
 *                          whether it can still be changed. Organisers only
 *                          (the page decides who sees it, the action checks
 *                          again). Never a phone, an area or another club.
 *   markGuestNoShow        an organiser marks a guest a no-show, or puts
 *                          him back to played, inside the window.
 *   finaliseGuestPlaces    the complete-matches cron (every 15 minutes):
 *                          each place whose window closed gets its final
 *                          result (`finalGuestResult`) and `settledAt`;
 *                          then each guest with a no-show newly final is
 *                          checked against the no-show pause.
 *
 * The no-show pause is decided ONCE, when a no-show becomes final, not when
 * it is marked: an organiser can correct a mistake inside the window and
 * nobody was paused or told anything (decision L7.2).
 *
 * Partner and pool guests alike (one record, `turn-up.ts`). The pause only
 * touches a pool profile; a partner guest with none is just recorded.
 */
import { db } from "../db";
import { dayCommaTimeLabel } from "../i18n/dates";
import { normaliseLang, type Lang } from "../i18n/lang";
import { poolSafetyCopy } from "../i18n/pool-safety";
import { queuePlatformDm } from "../platform-jobs";
import { isPoolOffersEnabled } from "./flags";
import { guestDisplayName } from "./guest-report";
import { buildPoolManageLink } from "./links";
import { POOL_RELIABILITY, countableGuestGames, finalGuestResult, noShowMarkRefusal, noShowMarkWindow, pausesForNoShows, type NoShowMarkRefusal } from "./reliability-rules";
import { turnUpRecordOf, type TurnUpRecord } from "./turn-up";
import { isOneOf, GUEST_RESULTS, type GuestResult } from "./vocab";

type Env = Record<string, string | undefined>;
type Attendance = "CONFIRMED" | "BENCH" | "DROPPED" | null;
type MatchStatus = Parameters<typeof finalGuestResult>[0]["matchStatus"];

const resultOf = (r: string): GuestResult => (isOneOf(GUEST_RESULTS, r) ? r : "booked");

// ── The match page ─────────────────────────────────────────────────────

export interface GuestResultRow {
  userId: string;
  name: string | null;
  result: GuestResult;
  /** May the organisers still change it (either way)? */
  changeable: boolean;
  /** His record across every club, counts only. */
  record: TurnUpRecord;
}

export interface GuestResultsPanel {
  closesAt: Date;
  final: boolean;
  rows: GuestResultRow[];
}

/** Null before kickoff, or when no guest held a place. */
export async function loadGuestResultsPanel(orgId: string, matchId: string, now: Date = new Date()): Promise<GuestResultsPanel | null> {
  const match = await db.match.findUnique({ where: { id: matchId }, select: { date: true, status: true, activity: { select: { orgId: true } } } });
  if (!match || match.activity.orgId !== orgId || match.status === "CANCELLED" || now.getTime() < match.date.getTime()) return null;
  const places = await db.guestPlace.findMany({ where: { orgId, matchId }, select: { userId: true, result: true, settledAt: true } });
  if (places.length === 0) return null;
  const ids = places.map((p) => p.userId);
  const [rows, users, history] = await Promise.all([
    db.attendance.findMany({ where: { matchId, userId: { in: ids } }, select: { userId: true, status: true } }),
    db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    db.guestPlace.findMany({ where: { userId: { in: ids } }, select: { userId: true, result: true } }),
  ]);
  const statusOf = new Map(rows.map((r) => [r.userId, r.status as Attendance]));
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const window = noShowMarkWindow(match.date);
  const final = now.getTime() >= window.closesAt.getTime();
  const out: GuestResultRow[] = [];
  for (const p of places) {
    const result = resultOf(p.result);
    const attendance = statusOf.get(p.userId) ?? null;
    // Only guests who held a place: a bench place never called up, a place
    // given up before kickoff (its own result) and a settled non-game are
    // not on this list. One taken off AFTER kickoff stays (review of #404, 6).
    if (!inResultsPanel({ result, attendance, settled: p.settledAt !== null })) continue;
    const refusal = noShowMarkRefusal({
      result,
      settled: p.settledAt !== null,
      attendance,
      matchStatus: match.status as MatchStatus,
      kickoff: match.date,
      noShow: result !== "no-show",
      now,
    });
    out.push({
      userId: p.userId,
      name: guestDisplayName(nameOf.get(p.userId)),
      // Shown as the organisers see it: marked, or counted as played.
      result: result === "no-show" ? "no-show" : "played",
      changeable: refusal === null,
      record: turnUpRecordOf(history.filter((h) => h.userId === p.userId).map((h) => resultOf(h.result))),
    });
  }
  if (out.length === 0) return null;
  out.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.userId.localeCompare(b.userId));
  return { closesAt: window.closesAt, final, rows: out };
}

/** Is this guest place on the match page's results list? Pure. */
export function inResultsPanel(p: { result: GuestResult; attendance: Attendance; settled: boolean }): boolean {
  if (p.result === "no-show" || p.result === "played") return true;
  return p.result === "booked" && !p.settled && p.attendance !== "BENCH";
}

export type MarkResult = { ok: true; result: GuestResult } | { ok: false; reason: NoShowMarkRefusal | "not-a-guest" };

/** The CALLER has proven `byUserId` is an owner or admin of `orgId`. */
export async function markGuestNoShow(a: { orgId: string; matchId: string; userId: string; byUserId: string; noShow: boolean; now?: Date }): Promise<MarkResult> {
  const now = a.now ?? new Date();
  const [place, match, row] = await Promise.all([
    db.guestPlace.findUnique({ where: { matchId_userId: { matchId: a.matchId, userId: a.userId } }, select: { id: true, orgId: true, result: true, settledAt: true } }),
    db.match.findUnique({ where: { id: a.matchId }, select: { date: true, status: true } }),
    db.attendance.findUnique({ where: { matchId_userId: { matchId: a.matchId, userId: a.userId } }, select: { status: true } }),
  ]);
  if (!place || place.orgId !== a.orgId || !match) return { ok: false, reason: "not-a-guest" };
  const result = resultOf(place.result);
  const refusal = noShowMarkRefusal({
    result,
    settled: place.settledAt !== null,
    attendance: (row?.status ?? null) as Attendance,
    matchStatus: match.status as MatchStatus,
    kickoff: match.date,
    noShow: a.noShow,
    now,
  });
  if (refusal) return { ok: false, reason: refusal };
  const target: GuestResult = a.noShow ? "no-show" : "booked";
  if (target === result) return { ok: true, result };
  // Compare-and-set on what the rule read, and never once settled.
  const done = await db.guestPlace.updateMany({
    where: { id: place.id, result: place.result, settledAt: null },
    data: a.noShow ? { result: "no-show", resultAt: now, resultById: a.byUserId } : { result: "booked", resultAt: null, resultById: null },
  });
  if (done.count === 0) return { ok: false, reason: "closed" };
  console.log(`[pool-no-show] place ${place.id}: ${a.noShow ? "marked no-show" : "back to played"} by ${a.byUserId}`);
  return { ok: true, result: target };
}

// ── The cron ───────────────────────────────────────────────────────────

const FINALISE_BATCH = 500;
/** How far back a final no-show is checked again (review of #404, 10). */
const RECHECK_DAYS = 2;

export async function finaliseGuestPlaces(now: Date = new Date(), env?: Env): Promise<{ settled: number; paused: number }> {
  let settled = 0;
  let paused = 0;
  try {
    const due = new Date(now.getTime() - POOL_RELIABILITY.markWindowHours * 3600_000);
    const places = await db.guestPlace.findMany({
      // Cancelled matches too, but only once their window is over: one put
      // back on before kickoff is played and marked as any other (review 2).
      where: { settledAt: null, match: { date: { lte: due } } },
      select: { id: true, userId: true, matchId: true, result: true, match: { select: { date: true, status: true } } },
      take: FINALISE_BATCH,
    });
    const rows = places.length
      ? await db.attendance.findMany({
          where: { OR: places.map((p) => ({ matchId: p.matchId, userId: p.userId })) },
          select: { matchId: true, userId: true, status: true },
        })
      : [];
    const statusOf = new Map(rows.map((r) => [`${r.matchId}:${r.userId}`, r.status as Attendance]));
    const newlyNoShow = new Set<string>();
    for (const p of places) {
      const final = finalGuestResult({
        result: resultOf(p.result),
        attendance: statusOf.get(`${p.matchId}:${p.userId}`) ?? null,
        matchStatus: p.match.status as MatchStatus,
        kickoff: p.match.date,
        now,
      });
      if (!final) continue;
      const changes = final.result !== p.result;
      const done = await db.guestPlace.updateMany({
        where: { id: p.id, result: p.result, settledAt: null },
        data: {
          settledAt: now,
          ...(changes ? (final.result === "booked" ? { result: "booked", resultAt: null, resultById: null } : { result: final.result, resultAt: now }) : {}),
        },
      });
      if (done.count === 0) continue;
      settled++;
      if (final.result === "no-show") newlyNoShow.add(p.userId);
    }
    // The retry path (review 10): anyone with a no-show made final in the
    // last two days is checked again, so a check that threw on an earlier
    // run is not lost. The check is idempotent (a pause is set once).
    const recent = await db.guestPlace.findMany({
      where: { result: "no-show", settledAt: { gte: new Date(now.getTime() - RECHECK_DAYS * 24 * 3600_000), lt: now } },
      select: { userId: true },
      distinct: ["userId"],
    });
    for (const r of recent) newlyNoShow.add(r.userId);
    // One player's failure never skips the rest (review 10).
    for (const userId of newlyNoShow) {
      try {
        if (await pauseForNoShowsIfDue(userId, now, env)) paused++;
      } catch (err) {
        console.error(`[pool-no-show] ${userId}: the pause check failed (retried next run):`, err instanceof Error ? err.message : "failed");
      }
    }
    if (settled || paused) console.log(`[pool-no-show] finalised ${settled} guest place(s), ${paused} paused for no-shows`);
  } catch (err) {
    console.error("[pool-no-show] finalising guest places failed:", err instanceof Error ? err.message : "failed");
  }
  return { settled, paused };
}

/**
 * The no-show pause (plan 5.5). An active profile, or one he paused himself
 * (or for ignored offers), becomes paused "no-shows"; a stopped one keeps
 * the reason on the row so starting again comes back paused. He is told
 * once (only an active or self-paused profile, only with the pool on: a
 * stopped profile withdrew consent to messages).
 */
async function pauseForNoShowsIfDue(userId: string, now: Date, env?: Env): Promise<boolean> {
  const profile = await db.poolProfile.findUnique({ where: { userId }, select: { id: true, status: true, pausedReason: true, language: true, user: { select: { phoneNumber: true } } } });
  if (!profile || profile.status === "pending-verify") return false;
  if (profile.pausedReason === "no-shows" || profile.pausedReason === "reports" || profile.pausedReason === "admin") return false;
  // Final results only, never a cancelled match (review of #404, 1 and 8).
  const games = await db.guestPlace.findMany({ where: { userId }, select: { result: true, settledAt: true, match: { select: { date: true, status: true } } } });
  const counted = countableGuestGames(games.map((g) => ({ kickoff: g.match.date, result: resultOf(g.result), settledAt: g.settledAt, cancelled: g.match.status === "CANCELLED" })));
  if (!pausesForNoShows(counted)) return false;
  const done = await db.poolProfile.updateMany({
    where: { id: profile.id, status: profile.status, pausedReason: profile.pausedReason },
    data: profile.status === "stopped" ? { pausedReason: "no-shows", pausedAt: now } : { status: "paused", pausedReason: "no-shows", pausedAt: now },
  });
  if (done.count === 0) return false;
  console.log(`[pool-no-show] ${userId}: pool offers paused for no-shows (was ${profile.status})`);
  if (profile.status === "stopped" || !profile.user?.phoneNumber || !isPoolOffersEnabled(env)) return true;
  const lang: Lang = normaliseLang(profile.language);
  try {
    await queuePlatformDm({
      phone: profile.user.phoneNumber,
      purpose: "pool-paused",
      refId: `no-shows:${profile.id}:${now.getTime()}`,
      text: poolSafetyCopy(lang).dm_paused_no_shows({
        n: POOL_RELIABILITY.noShowPause.noShows,
        games: POOL_RELIABILITY.noShowPause.lastGames,
        days: POOL_RELIABILITY.noShowResumeAfterDays,
        link: await buildPoolManageLink(userId),
      }),
      sendAfter: null,
    });
  } catch (err) {
    console.error(`[pool-no-show] ${userId}: the pause DM was not queued:`, err instanceof Error ? err.message : "failed");
  }
  return true;
}

/** "Tue 3 Nov, 20:00" for the panel's "mark by" line, in the club's language. */
export const markByLabel = (lang: string | null | undefined, closesAt: Date): string => dayCommaTimeLabel(lang, closesAt);
