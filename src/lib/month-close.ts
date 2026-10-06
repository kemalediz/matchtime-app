/**
 * Monthly squad, slice 6: credits, cancelled weeks, leaving part-way, a
 * share changed after payments, refunds, the month close and away weeks,
 * the database side (2026-10-06).
 * Plan: MDs/monthly-squad-plan-2026-10-05.md, sections 4.4, 5.2, 7 and 9.
 *
 * For a club on `squadMode = "monthly"` ONLY: every entry point checks the
 * mode (or reaches a month through one that does) before it writes.
 *
 *   addManualCredit() / removeCredit()  the organiser's "Add credit" and
 *                            "Remove credit", each with a reason.
 *   reconcileCancelledWeeks()  a called-off game credits every regular
 *                            charged for it, once; restoring takes it back.
 *   reconcileLeavers()       a regular who paid and left is owed the games
 *                            left. Shown to the collector; never refunded.
 *   recordRefund()           the collector's own word that they gave money
 *                            back.
 *   changeShareAfterPaid()   a new share for a month somebody has paid for:
 *                            the difference is shown, no payment changes.
 *   closeDueMonths()         the morning after the last game: the month is
 *                            closed once and the summary sent once.
 *   sweepMonthClose()        the poll's one call, at most once an hour.
 *   setAwayWeeks()           the weeks a regular ticks in advance.
 *
 * MONEY RULES, all of them enforced here:
 *   - MatchTime moves no money and refunds nobody;
 *   - money state changes only on an organiser's or the collector's own
 *     action. The sweeps only ever write CREDITS (games), from the state
 *     as it is, so a retry or two polls at once write nothing twice;
 *   - no member row and no credit is ever deleted. A credit is voided;
 *   - every credit write is under the club's advisory lock
 *     (`lockClubCredits`), the same one pricing spends credits under.
 *
 * The rules are pure and live in `month-close-rules.ts`. No model is
 * called anywhere in this file.
 */
import { db } from "./db";
import { sendAdminNotice } from "./admin-channel";
import { appUrl } from "./app-url";
import { isClubOperational } from "./club-approval-state";
import { formatLondon, londonDateTimeToUtc } from "./london-time";
import { hasMatchForSlot, isSameRecurringFixture, type RecurringFixtureKey } from "./match-slot";
import { buildLeaverNotice, buildMidMonthJoinDm, buildMidMonthJoinNotice, buildMonthSummaryNotice, buildShareChangeNotice } from "./month-close-copy";
import { adminNoticeSendAfter } from "./rolling-squad-rules";
import {
  REFUNDED_NOTE,
  refundAllowed,
  awayEditable,
  cleanCreditNote,
  creditState,
  decideCancelledWeekCredits,
  decideLeaverCredits,
  isLeaver,
  leaverOwedPence,
  monthCloseDue,
  paidBalancePence,
  planAwayWeeks,
  planShareChange,
  summariseMonth,
  validManualGames,
  type AwayGame,
  type CreditState,
  type LeaverGame,
  type MonthSummary,
  type Paid,
} from "./month-close-rules";
import { lockClubCredits, mayConfirmPayments } from "./month-payment";
import { lockMonth } from "./month-signup";
import { WAITING_NOTE, monthKickoffs, nextMonthStart } from "./month-signup-rules";
import { weekListHash } from "./monthly-week-rules";
import { MAX_PAID_PENCE, MAX_PER_GAME_PENCE, normaliseCreditRule, normaliseSquadMode, type MonthCreditRule } from "./squad-month-rules";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/** Every once-only key of this slice: `org-<id>:mcl:`. */
export function closeKeyPrefix(orgId: string): string {
  return `org-${orgId}:mcl:`;
}

async function claimOnce(key: string, kind: string): Promise<boolean> {
  try {
    await db.sentNotification.create({ data: { key, kind } });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

const paidOf = (r: { paidAt: Date | null; paidClaimedAt: Date | null }): Paid => (r.paidAt ? "confirmed" : r.paidClaimedAt ? "claimed" : "none");
const londonDay = (d: Date): string => formatLondon(d, "yyyy-MM-dd");
const monthDateOf = (monthStart: string): Date => new Date(`${monthStart}T12:00:00.000Z`);

// ── Loading ────────────────────────────────────────────────────────────

export interface CloseMember {
  id: string;
  userId: string;
  name: string;
  kind: "regular" | "payg";
  tier: string;
  waiting: boolean;
  /** Off the month (`leftAt`): said OUT, or removed by an organiser. */
  leftAt: Date | null;
  joinedAt: Date;
  /** Still in the group and active. */
  inClub: boolean;
  /** When they left the group, when that is known. */
  clubLeftAt: Date | null;
  absentMatchIds: string[];
  gamesCovered: number;
  creditsApplied: number;
  amountDuePence: number | null;
  paid: Paid;
  /** What was confirmed, else what was claimed, else null. */
  paidPence: number | null;
  refundedPence: number;
}

export interface CloseMatch {
  id: string;
  date: Date;
  status: string;
  /** The month's regulars are on it. */
  seeded: boolean;
  feePerPlayer: number | null;
}

/** A month with EVERY member row, the ones who left included: this slice
 *  is about what they are owed. */
export interface CloseMonth {
  id: string;
  orgId: string;
  activityId: string;
  /** "2026-10-01". */
  monthStart: string;
  status: string;
  /** Nothing dated before this is the month's business (plan 4.5). */
  startsAt: Date;
  gamesPlayedBeforeStart: number;
  sharePerGamePence: number | null;
  concessionPerGamePence: number | null;
  pricedAt: Date | null;
  closedAt: Date | null;
  language: string | null;
  fixture: RecurringFixtureKey;
  /** The fixture's matches in the month, cancelled ones included. */
  matches: CloseMatch[];
  /** The month's games: the calendar minus the cancelled weeks. */
  games: LeaverGame[];
  /** The last day of the fixture's calendar in the month. */
  lastKickoff: Date | null;
  members: CloseMember[];
}

const CLOSE_SELECT = {
  id: true,
  orgId: true,
  activityId: true,
  monthStart: true,
  status: true,
  createdAt: true,
  startedMidMonthAt: true,
  gamesPlayedBeforeStart: true,
  sharePerGamePence: true,
  concessionPerGamePence: true,
  pricedAt: true,
  closedAt: true,
  activity: { select: { venue: true, dayOfWeek: true, time: true } },
  org: { select: { language: true } },
  members: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      userId: true,
      kind: true,
      tier: true,
      slot: true,
      note: true,
      leftAt: true,
      joinedAt: true,
      absentMatchIds: true,
      gamesCovered: true,
      creditsApplied: true,
      amountDuePence: true,
      paidAt: true,
      paidClaimedAt: true,
      paidAmountPence: true,
      paidClaimedAmountPence: true,
      refundedPence: true,
      user: { select: { name: true } },
    },
  },
} as const;

/**
 * A club's months with everybody on them. `ids` for those months alone;
 * otherwise every month that is not closed (whatever its calendar month:
 * a month whose last game is on the 31st closes on the 1st). The caller
 * has checked the club is monthly.
 */
export async function loadCloseMonths(orgId: string, ids?: string[]): Promise<CloseMonth[]> {
  const rows = await db.squadMonth.findMany({
    where: { orgId, ...(ids ? { id: { in: ids } } : { status: { in: ["open", "priced", "running"] } }) },
    select: CLOSE_SELECT,
    orderBy: { monthStart: "asc" },
  });
  if (rows.length === 0) return [];
  const userIds = [...new Set(rows.flatMap((r) => r.members.map((m) => m.userId)))];
  const starts = rows.map((r) => r.monthStart.toISOString().slice(0, 10)).sort();
  const [memberships, matches] = await Promise.all([
    userIds.length === 0
      ? Promise.resolve([])
      : db.membership.findMany({
          where: { orgId, userId: { in: userIds } },
          select: { userId: true, leftAt: true, user: { select: { isActive: true } } },
        }),
    db.match.findMany({
      where: {
        activity: { orgId },
        isHistorical: false,
        date: { gte: londonDateTimeToUtc(starts[0], "00:00"), lt: londonDateTimeToUtc(nextMonthStart(starts[starts.length - 1]), "00:00") },
      },
      select: { id: true, date: true, status: true, rollingSeededAt: true, feePerPlayer: true, activity: { select: { orgId: true, venue: true, dayOfWeek: true } } },
      orderBy: { date: "asc" },
    }),
  ]);
  const membershipOf = new Map(memberships.map((m) => [m.userId, m]));

  return rows.map((row) => {
    const monthStart = row.monthStart.toISOString().slice(0, 10);
    const from = londonDateTimeToUtc(monthStart, "00:00").getTime();
    const to = londonDateTimeToUtc(nextMonthStart(monthStart), "00:00").getTime();
    const fixture = { orgId, venue: row.activity.venue, dayOfWeek: row.activity.dayOfWeek };
    const mine = matches.filter((m) => m.date.getTime() >= from && m.date.getTime() < to && isSameRecurringFixture(m.activity, fixture));
    const calendar = monthKickoffs(monthStart, row.activity.dayOfWeek, row.activity.time);
    // The month's games (`monthGames`' rule, with the match each one is).
    const games: LeaverGame[] = [];
    for (const kickoff of calendar) {
      const onDay = mine.filter((m) => londonDay(m.date) === londonDay(kickoff));
      const live = onDay.find((m) => m.status !== "CANCELLED");
      if (live) games.push({ matchId: live.id, date: live.date });
      else if (onDay.length === 0) games.push({ matchId: null, date: kickoff });
    }
    return {
      id: row.id,
      orgId,
      activityId: row.activityId,
      monthStart,
      status: row.status,
      startsAt: row.startedMidMonthAt ?? new Date(from),
      gamesPlayedBeforeStart: row.gamesPlayedBeforeStart,
      sharePerGamePence: row.sharePerGamePence,
      concessionPerGamePence: row.concessionPerGamePence,
      pricedAt: row.pricedAt,
      closedAt: row.closedAt,
      language: row.org.language,
      fixture,
      matches: mine.map((m) => ({
        id: m.id,
        date: m.date,
        status: m.status,
        seeded: m.rollingSeededAt != null && m.rollingSeededAt.getTime() >= row.createdAt.getTime(),
        feePerPlayer: m.feePerPlayer,
      })),
      games,
      lastKickoff: games.length > 0 ? games[games.length - 1].date : (calendar[calendar.length - 1] ?? null),
      members: [...row.members]
        .sort((a, b) => (a.slot ?? Number.MAX_SAFE_INTEGER) - (b.slot ?? Number.MAX_SAFE_INTEGER))
        .map((m) => {
        const ms = membershipOf.get(m.userId);
        const inClub = !!ms && ms.leftAt === null && ms.user.isActive;
        return {
          id: m.id,
          userId: m.userId,
          name: m.user.name ?? "",
          kind: m.kind === "payg" ? ("payg" as const) : ("regular" as const),
          tier: m.tier,
          waiting: m.kind === "payg" && m.note === WAITING_NOTE,
          leftAt: m.leftAt,
          joinedAt: m.joinedAt,
          inClub,
          clubLeftAt: ms?.leftAt ?? null,
          absentMatchIds: m.absentMatchIds,
          gamesCovered: m.gamesCovered,
          creditsApplied: m.creditsApplied,
          amountDuePence: m.amountDuePence,
          paid: paidOf(m),
          paidPence: m.paidAt ? m.paidAmountPence : m.paidClaimedAt ? m.paidClaimedAmountPence : null,
          refundedPence: m.refundedPence,
        };
        }),
    };
  });
}

const shareFor = (month: { sharePerGamePence: number | null; concessionPerGamePence: number | null }, tier: string): number | null =>
  month.sharePerGamePence == null ? null : tier === "concession" && month.concessionPerGamePence != null ? month.concessionPerGamePence : month.sharePerGamePence;

const leaverView = (m: CloseMember) => ({
  regular: m.kind === "regular" && m.leftAt === null,
  offMonth: m.leftAt !== null || m.kind === "payg",
  inClub: m.inClub,
  paid: m.paid,
});

async function isMonthlyClub(orgId: string): Promise<boolean> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { squadMode: true } });
  return !!org && normaliseSquadMode(org.squadMode) === "monthly";
}

// ── The ledger: Add credit, Remove credit (plan 9.2) ───────────────────

export type ManualCreditError = "not-monthly" | "bad-reason" | "bad-games" | "not-a-member" | "bad-token";

/**
 * An organiser adds credit by hand: one ledger row a game, reason
 * "manual", with their own words. For something MatchTime did not see (a
 * game missed before the club started here, plan 4.5).
 *
 * `token` is made by the form, once per press: the rows' ids are built
 * from it, so the same press sent twice (a double click, a retry) writes
 * the credit once.
 */
export async function addManualCredit(args: {
  orgId: string;
  userId: string;
  games: number;
  reason: string;
  actorUserId: string;
  token: string;
}): Promise<{ ok: true; added: number } | { ok: false; error: ManualCreditError }> {
  if (!(await isMonthlyClub(args.orgId))) return { ok: false, error: "not-monthly" };
  const note = cleanCreditNote(args.reason);
  if (!note) return { ok: false, error: "bad-reason" };
  if (!validManualGames(args.games)) return { ok: false, error: "bad-games" };
  if (typeof args.token !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(args.token)) return { ok: false, error: "bad-token" };
  // Anybody who is or was a player of this club (a leaver can be owed).
  const member = await db.membership.findFirst({ where: { orgId: args.orgId, userId: args.userId }, select: { id: true } });
  if (!member) return { ok: false, error: "not-a-member" };

  const added = await db.$transaction(async (tx) => {
    await lockClubCredits(tx, args.orgId);
    const res = await tx.squadCredit.createMany({
      data: Array.from({ length: args.games }, (_, i) => ({
        id: `mc-${args.token}-${i}`,
        orgId: args.orgId,
        userId: args.userId,
        games: 1,
        reason: "manual",
        note,
        createdById: args.actorUserId,
      })),
      skipDuplicates: true,
    });
    return res.count;
  });
  return { ok: true, added };
}

export type RemoveCreditError = "not-monthly" | "bad-reason" | "not-found" | "used";

/**
 * An organiser removes a credit, with a reason. The row stays, voided, with
 * who and why. A credit that has already come off a month's amount cannot
 * be removed: that money was asked for net of it. Removing one that is
 * already removed changes nothing.
 */
export async function removeCredit(args: {
  orgId: string;
  creditId: string;
  reason: string;
  actorUserId: string;
  now?: Date;
}): Promise<{ ok: true; changed: boolean } | { ok: false; error: RemoveCreditError }> {
  if (!(await isMonthlyClub(args.orgId))) return { ok: false, error: "not-monthly" };
  const voidNote = cleanCreditNote(args.reason);
  if (!voidNote) return { ok: false, error: "bad-reason" };
  const now = args.now ?? new Date();
  return db.$transaction(async (tx) => {
    await lockClubCredits(tx, args.orgId);
    const credit = await tx.squadCredit.findFirst({
      where: { id: args.creditId, orgId: args.orgId },
      select: { id: true, voidedAt: true, appliedMonthId: true },
    });
    if (!credit) return { ok: false as const, error: "not-found" as const };
    if (credit.voidedAt) return { ok: true as const, changed: false };
    if (credit.appliedMonthId) return { ok: false as const, error: "used" as const };
    const res = await tx.squadCredit.updateMany({
      where: { id: credit.id, voidedAt: null, appliedMonthId: null },
      data: { voidedAt: now, voidedById: args.actorUserId, voidNote },
    });
    return { ok: true as const, changed: res.count > 0 };
  });
}

export interface LedgerRow {
  id: string;
  /** ISO instant. */
  createdAt: string;
  reason: string;
  /** The London day of the game it was earned on, as an ISO instant, or null. */
  gameDate: string | null;
  note: string | null;
  state: CreditState;
  /** The month it was used against ("2026-11-01"), or null. */
  appliedMonthStart: string | null;
  voidNote: string | null;
  /** An organiser may remove it: it stands and has not been used. */
  removable: boolean;
}

export interface LedgerPlayer {
  userId: string;
  name: string;
  /** Games of credit that stand and have not been used. */
  available: number;
  rows: LedgerRow[];
}

/** A page of the ledger is the newest rows; a club makes a few a week. */
const LEDGER_PAGE = 500;

/** The credits ledger, by player, newest first. Read only. */
export async function loadCreditLedger(orgId: string): Promise<{ players: LedgerPlayer[]; clubPlayers: Array<{ userId: string; name: string }> }> {
  const [credits, memberships] = await Promise.all([
    db.squadCredit.findMany({
      where: { orgId },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: LEDGER_PAGE,
      select: {
        id: true,
        userId: true,
        createdAt: true,
        reason: true,
        earnedMatchId: true,
        note: true,
        voidNote: true,
        voidedAt: true,
        voidedById: true,
        appliedMonthId: true,
        appliedMonth: { select: { monthStart: true } },
        user: { select: { name: true } },
      },
    }),
    db.membership.findMany({
      where: { orgId, leftAt: null, user: { isActive: true } },
      select: { user: { select: { id: true, name: true } } },
      orderBy: { user: { name: "asc" } },
    }),
  ]);
  const matchIds = [...new Set(credits.map((c) => c.earnedMatchId).filter((id): id is string => id !== null))];
  const dateOf = new Map(
    matchIds.length === 0 ? [] : (await db.match.findMany({ where: { id: { in: matchIds } }, select: { id: true, date: true } })).map((m) => [m.id, m.date]),
  );
  const players = new Map<string, LedgerPlayer>();
  for (const c of credits) {
    const state = creditState(c);
    const p = players.get(c.userId) ?? { userId: c.userId, name: c.user.name ?? "", available: 0, rows: [] };
    if (state === "available") p.available += 1;
    p.rows.push({
      id: c.id,
      createdAt: c.createdAt.toISOString(),
      reason: c.reason,
      gameDate: c.earnedMatchId ? (dateOf.get(c.earnedMatchId)?.toISOString() ?? null) : null,
      note: c.note,
      state,
      appliedMonthStart: c.appliedMonth ? c.appliedMonth.monthStart.toISOString().slice(0, 10) : null,
      voidNote: c.voidNote,
      removable: state === "available",
    });
    players.set(c.userId, p);
  }
  return {
    players: [...players.values()].sort((a, b) => a.name.localeCompare(b.name)),
    clubPlayers: memberships.map((m) => ({ userId: m.user.id, name: m.user.name ?? "" })),
  };
}

// ── A cancelled week (plan section 7) ──────────────────────────────────

/**
 * Bring the "cancelled-week" credits of a club's months in line with which
 * of their games are called off (`decideCancelledWeekCredits`). Called
 * right after an organiser cancels or restores a match, and by the hourly
 * sweep as the safety net. Idempotent. Returns how many credits it wrote.
 *
 * Only a game dated on or after the month started here is the month's.
 */
export async function reconcileCancelledWeeks(orgId: string, now: Date = new Date(), preloaded?: CloseMonth[]): Promise<{ created: number; voided: number }> {
  const months = (preloaded ?? (await loadCloseMonths(orgId))).filter((m) => m.status !== "closed");
  let created = 0;
  let voided = 0;
  for (const month of months) {
    const mine = month.matches.filter((m) => m.date.getTime() >= month.startsAt.getTime());
    if (mine.length === 0) continue;
    const credits = await db.squadCredit.findMany({
      where: { orgId, earnedMatchId: { in: mine.map((m) => m.id) }, reason: "cancelled-week", voidedAt: null },
      select: { earnedMatchId: true },
    });
    const credited = new Set(credits.map((c) => c.earnedMatchId));
    // A game that is on again but still has its "called off at" record:
    // the record is dropped, so cancelling again starts a new one.
    const live = mine.filter((m) => m.status !== "CANCELLED");
    const marked = new Set(
      live.length === 0
        ? []
        : (await db.sentNotification.findMany({ where: { key: { in: live.map((m) => cancelledAtKey(orgId, m.id)) } }, select: { key: true } })).map((r) => r.key),
    );
    // Only a game that is off, or one that still carries such a credit or record.
    for (const match of mine.filter((m) => m.status === "CANCELLED" || credited.has(m.id) || marked.has(cancelledAtKey(orgId, m.id)))) {
      const res = await reconcileCancelledMatch(month, match.id, now);
      created += res.created;
      voided += res.voided;
    }
  }
  return { created, voided };
}

async function reconcileCancelledMatch(month: CloseMonth, matchId: string, now: Date): Promise<{ created: number; voided: number }> {
  const res = await db.$transaction(async (tx) => {
    await lockMonth(tx, month.id);
    await lockClubCredits(tx, month.orgId);
    // Everything is read again under the locks: what was loaded outside
    // them only chose which matches to look at.
    const [match, state, rows, existing] = await Promise.all([
      tx.match.findUnique({ where: { id: matchId }, select: { status: true, date: true, updatedAt: true } }),
      tx.squadMonth.findUnique({ where: { id: month.id }, select: { status: true, sharePerGamePence: true, concessionPerGamePence: true } }),
      tx.squadMonthMember.findMany({
        where: { monthId: month.id },
        select: { id: true, userId: true, kind: true, tier: true, leftAt: true, joinedAt: true, paidAt: true, paidClaimedAt: true, gamesCovered: true, creditsApplied: true },
      }),
      // Every credit earned on this game, WHATEVER the reason: one live
      // credit per player per game.
      tx.squadCredit.findMany({
        where: { orgId: month.orgId, earnedMatchId: matchId },
        select: { id: true, userId: true, reason: true, voidedAt: true, voidedById: true, appliedMonthId: true, createdById: true },
      }),
    ]);
    if (!match || !state || state.status === "closed") return { created: 0, voided: 0, elsewhere: [] };
    // WHEN IT WAS CALLED OFF, written down ONCE (the first time it is seen
    // cancelled, from the match row as the cancellation left it) and read
    // from that record ever after, so nothing that touches the match row
    // later can move it. Somebody who joined the month after that had
    // their games counted without this one. Dropped when the game is
    // restored, so cancelling again records the new moment.
    const markKey = cancelledAtKey(month.orgId, matchId);
    let cancelledAt: Date | null = null;
    if (match.status === "CANCELLED") {
      const mark =
        (await tx.sentNotification.findUnique({ where: { key: markKey }, select: { createdAt: true } })) ??
        (await tx.sentNotification.create({ data: { key: markKey, kind: "month-cancelled-at", createdAt: match.updatedAt }, select: { createdAt: true } }));
      cancelledAt = mark.createdAt;
    } else {
      await tx.sentNotification.deleteMany({ where: { key: markKey } });
    }
    const inClub = new Set(
      rows.length === 0
        ? []
        : (
            await tx.membership.findMany({
              where: { orgId: month.orgId, userId: { in: rows.map((r) => r.userId) }, leftAt: null, user: { isActive: true } },
              select: { userId: true },
            })
          ).map((m) => m.userId),
    );
    const plan = decideCancelledWeekCredits({
      cancelled: match.status === "CANCELLED",
      matchDate: match.date,
      cancelledAt,
      monthId: month.id,
      members: rows.map((r) => ({
        userId: r.userId,
        regular: r.kind === "regular" && r.leftAt === null,
        inClub: inClub.has(r.userId),
        paid: paidOf(r),
        joinedAt: r.joinedAt,
      })),
      existing,
    });
    const rowOf = new Map(rows.map((r) => [r.userId, r]));
    /** A member's amount after their credits changed, when a share is set. */
    const amountAfter = (r: (typeof rows)[number], creditsApplied: number): number | null => {
      const share = shareFor(state, r.tier);
      return share == null ? null : share * Math.max(0, r.gamesCovered - creditsApplied);
    };

    if (plan.voidMissedIds.length > 0) {
      await tx.squadCredit.updateMany({ where: { id: { in: plan.voidMissedIds }, voidedAt: null, appliedMonthId: null }, data: { voidedAt: now } });
    }
    for (const c of plan.create) {
      const r = rowOf.get(c.userId);
      // Off this month's amount at once, while there is a game left to take
      // it off. Otherwise it waits in the ledger like any other.
      const applyNow = c.applyNow && !!r && r.creditsApplied < r.gamesCovered;
      await tx.squadCredit.create({
        data: {
          orgId: month.orgId,
          userId: c.userId,
          games: 1,
          reason: "cancelled-week",
          earnedMonthId: month.id,
          earnedMatchId: matchId,
          ...(applyNow ? { appliedMonthId: month.id, appliedAt: now } : {}),
        },
      });
      if (applyNow && r) {
        const creditsApplied = r.creditsApplied + 1;
        // `paidAt: null, paidClaimedAt: null` in the WHERE: somebody who
        // paid a moment ago is not re-priced behind their back.
        const res = await tx.squadMonthMember.updateMany({
          where: { id: r.id, paidAt: null, paidClaimedAt: null },
          data: { creditsApplied, amountDuePence: amountAfter(r, creditsApplied) },
        });
        if (res.count === 0) {
          await tx.squadCredit.updateMany({
            where: { orgId: month.orgId, userId: c.userId, earnedMatchId: matchId, reason: "cancelled-week", appliedMonthId: month.id, voidedAt: null },
            data: { appliedMonthId: null, appliedAt: null },
          });
        }
      }
    }
    if (plan.voidIds.length > 0) {
      await tx.squadCredit.updateMany({ where: { id: { in: plan.voidIds }, voidedAt: null }, data: { voidedAt: now } });
      for (const rel of plan.release) {
        const r = rowOf.get(rel.userId);
        if (!r) continue;
        // The game is on again: it goes back onto what they are asked for.
        // For somebody who has paid since, that shows as "owes more".
        const creditsApplied = Math.max(0, r.creditsApplied - 1);
        await tx.squadMonthMember.update({ where: { id: r.id }, data: { creditsApplied, amountDuePence: amountAfter(r, creditsApplied) } });
      }
    }
    return { created: plan.create.length, voided: plan.voidIds.length, elsewhere: plan.releaseElsewhere };
  });
  // A restored game whose credit had already come off ANOTHER month: taken
  // back there, each in a transaction of its own under THAT month's lock
  // (never two months' locks at once).
  for (const rel of res.elsewhere) {
    try {
      await releaseSpentCredit(month.orgId, rel, now);
    } catch (err) {
      console.error(`[month-close] taking credit ${rel.creditId} back from month ${rel.monthId} failed (the hourly sweep retries):`, err);
    }
  }
  return { created: res.created, voided: res.voided };
}

/** Where the moment a game was called off is kept: one row per match. */
const cancelledAtKey = (orgId: string, matchId: string): string => `${closeKeyPrefix(orgId)}cancelled-at:${matchId}`;

/**
 * A "cancelled-week" credit that was used against a month, for a game
 * that is on again: the credit is voided and that month asks its holder
 * for one game more. For somebody who has paid that month it shows as
 * "owes more" (`paidBalancePence`); nobody's payment is touched. A CLOSED
 * month is frozen and is left as it is.
 */
async function releaseSpentCredit(orgId: string, rel: { creditId: string; userId: string; monthId: string }, now: Date): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockMonth(tx, rel.monthId);
    await lockClubCredits(tx, orgId);
    const [credit, state, row] = await Promise.all([
      tx.squadCredit.findFirst({ where: { id: rel.creditId, orgId, voidedAt: null, appliedMonthId: rel.monthId }, select: { id: true } }),
      tx.squadMonth.findFirst({ where: { id: rel.monthId, orgId }, select: { status: true, sharePerGamePence: true, concessionPerGamePence: true } }),
      tx.squadMonthMember.findUnique({
        where: { monthId_userId: { monthId: rel.monthId, userId: rel.userId } },
        select: { id: true, tier: true, kind: true, gamesCovered: true, creditsApplied: true },
      }),
    ]);
    if (!credit || !state || state.status === "closed") return;
    await tx.squadCredit.update({ where: { id: credit.id }, data: { voidedAt: now } });
    if (!row || row.creditsApplied < 1) return;
    const creditsApplied = row.creditsApplied - 1;
    const share = shareFor(state, row.tier);
    await tx.squadMonthMember.update({
      where: { id: row.id },
      data: { creditsApplied, ...(row.kind === "regular" && share != null ? { amountDuePence: share * Math.max(0, row.gamesCovered - creditsApplied) } : {}) },
    });
  });
}

/**
 * The one call the cancel and restore actions make, for a club on
 * "monthly" only (the caller checks the mode it already loaded). Returns
 * how many of the cancelled games credited the regulars, for the line the
 * announcement carries. Never throws: a failure here must not undo a
 * cancellation, and the hourly sweep writes the credits.
 */
export async function afterMatchesCancelled(orgId: string, matchIds: string[], now: Date = new Date()): Promise<{ creditedGames: number }> {
  try {
    if (!(await isMonthlyClub(orgId))) return { creditedGames: 0 };
    await reconcileCancelledWeeks(orgId, now);
    if (matchIds.length === 0) return { creditedGames: 0 };
    const credited = await db.squadCredit.findMany({
      where: { orgId, earnedMatchId: { in: matchIds }, reason: "cancelled-week", voidedAt: null },
      select: { earnedMatchId: true },
      distinct: ["earnedMatchId"],
    });
    return { creditedGames: credited.length };
  } catch (err) {
    console.error(`[month-close] crediting cancelled games for ${orgId} failed (the hourly sweep retries):`, err);
    return { creditedGames: 0 };
  }
}

// ── Leaving part-way through (plan section 7) ──────────────────────────

/**
 * Bring the "left-mid-month" credits of a club's months in line with who
 * has left (`decideLeaverCredits`): a regular who paid and is one no
 * longer is owed the games left. When they left of their own accord (the
 * sweep finds them gone from the group) the organisers are told once per
 * leaver per month, with the amount. MatchTime refunds nobody. Idempotent.
 */
export async function reconcileLeavers(
  orgId: string,
  now: Date = new Date(),
  preloaded?: CloseMonth[],
  /** False when an organiser has just made the change on the Months page:
   *  the page shows what is owed, and an organiser's own change is theirs
   *  to pass on (the rule of every button on that page). */
  opts: { notify?: boolean } = {},
): Promise<{ created: number; voided: number }> {
  const months = (preloaded ?? (await loadCloseMonths(orgId))).filter((m) => m.status !== "closed");
  if (months.length === 0) return { created: 0, voided: 0 };
  const held = await db.squadCredit.findMany({
    where: { orgId, earnedMonthId: { in: months.map((m) => m.id) }, reason: "left-mid-month", voidedAt: null },
    select: { userId: true, earnedMonthId: true },
  });
  const holds = new Set(held.map((c) => `${c.earnedMonthId}:${c.userId}`));
  let created = 0;
  let voided = 0;
  for (const month of months) {
    for (const m of month.members) {
      // A leaver, or somebody who holds such a credit and may be back.
      if (!isLeaver(leaverView(m)) && !holds.has(`${month.id}:${m.userId}`)) continue;
      const res = await reconcileLeaver(month, m, now);
      created += res.created;
      voided += res.voided;
      if (res.created > 0 && opts.notify !== false) await tellLeaverOwed(month, m, now);
    }
  }
  return { created, voided };
}

async function reconcileLeaver(month: CloseMonth, m: CloseMember, now: Date): Promise<{ created: number; voided: number }> {
  return db.$transaction(async (tx) => {
    await lockMonth(tx, month.id);
    await lockClubCredits(tx, month.orgId);
    const [state, row, membership, credits] = await Promise.all([
      tx.squadMonth.findUnique({ where: { id: month.id }, select: { status: true } }),
      tx.squadMonthMember.findUnique({ where: { id: m.id }, select: { kind: true, leftAt: true, paidAt: true, paidClaimedAt: true } }),
      tx.membership.findFirst({ where: { orgId: month.orgId, userId: m.userId }, select: { leftAt: true, user: { select: { isActive: true } } } }),
      tx.squadCredit.findMany({
        where: { orgId: month.orgId, userId: m.userId },
        select: { id: true, userId: true, reason: true, earnedMonthId: true, earnedMatchId: true, voidedAt: true, voidedById: true, appliedMonthId: true, createdById: true },
      }),
    ]);
    if (!state || state.status === "closed" || !row) return { created: 0, voided: 0 };
    const inClub = !!membership && membership.leftAt === null && membership.user.isActive;
    const leftAt = row.leftAt ?? membership?.leftAt ?? now;
    const plan = decideLeaverCredits({
      member: { regular: row.kind === "regular" && row.leftAt === null, offMonth: row.leftAt !== null || row.kind === "payg", inClub, paid: paidOf(row) },
      leftAt,
      // Never a game from before the month started here, nor one from
      // before they became a regular.
      games: month.games.filter((g) => g.date.getTime() >= month.startsAt.getTime() && g.date.getTime() > m.joinedAt.getTime()),
      existing: credits.filter((c) => c.reason === "left-mid-month" && c.earnedMonthId === month.id),
      creditedMatchIds: new Set(credits.filter((c) => c.voidedAt === null && c.earnedMatchId !== null).map((c) => c.earnedMatchId as string)),
    });
    if (plan.create.length > 0) {
      await tx.squadCredit.createMany({
        data: plan.create.map((c) => ({ orgId: month.orgId, userId: m.userId, games: 1, reason: "left-mid-month", earnedMonthId: month.id, earnedMatchId: c.matchId })),
      });
    }
    if (plan.voidIds.length > 0) {
      await tx.squadCredit.updateMany({ where: { id: { in: plan.voidIds }, voidedAt: null, appliedMonthId: null }, data: { voidedAt: now } });
    }
    return { created: plan.create.length, voided: plan.voidIds.length };
  });
}

/** The games of credit each of these players holds unused, in this club. */
async function unusedCredits(orgId: string, userIds?: string[]): Promise<Map<string, number>> {
  const rows = await db.squadCredit.groupBy({
    by: ["userId"],
    where: { orgId, voidedAt: null, appliedMonthId: null, ...(userIds ? { userId: { in: userIds } } : {}) },
    _sum: { games: true },
  });
  return new Map(rows.map((r) => [r.userId, r._sum.games ?? 0]));
}

async function tellLeaverOwed(month: CloseMonth, m: CloseMember, now: Date): Promise<void> {
  try {
    if (!(await claimOnce(`${closeKeyPrefix(month.orgId)}leaver:${month.id}:${m.userId}`, "admin-notice"))) return;
    const games = (await unusedCredits(month.orgId, [m.userId])).get(m.userId) ?? 0;
    if (games === 0) return;
    const path = `/admin/months?month=${month.monthStart}`;
    await sendAdminNotice({
      orgId: month.orgId,
      now,
      nextPath: path,
      text: (link) =>
        buildLeaverNotice({
          name: m.name,
          monthDate: monthDateOf(month.monthStart),
          games,
          pence: leaverOwedPence({ games, tier: m.tier, sharePence: month.sharePerGamePence, concessionPence: month.concessionPerGamePence }),
          link: link || appUrl(path),
          lang: month.language,
        }),
    });
  } catch (err) {
    console.error(`[month-close] telling the organisers what ${m.userId} is owed failed:`, err);
  }
}

// ── Joining part-way through (plan section 7) ──────────────────────────

/**
 * Somebody has just joined a month under way (`applySignup`): tell them
 * the games left and what to pay, and tell the organisers, once each per
 * month. The DM is held overnight like every other; the page says it on
 * the page, so a join from there sends the player no DM.
 */
export async function tellMidMonthJoin(args: { orgId: string; monthId: string; userId: string; viaPage: boolean; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  const row = await db.squadMonthMember.findUnique({
    where: { monthId_userId: { monthId: args.monthId, userId: args.userId } },
    select: {
      kind: true,
      leftAt: true,
      gamesCovered: true,
      amountDuePence: true,
      paidAt: true,
      paidClaimedAt: true,
      user: { select: { name: true, phoneNumber: true } },
      month: { select: { monthStart: true, org: { select: { language: true, squadMode: true, paymentHolderId: true } } } },
    },
  });
  if (!row || row.kind !== "regular" || row.leftAt !== null || normaliseSquadMode(row.month.org.squadMode) !== "monthly") return;
  // Somebody who had paid and is back keeps what they paid for: there is
  // no new amount to tell them, and the Months page shows where they stand.
  if (row.paidAt || row.paidClaimedAt) return;
  const monthStart = row.month.monthStart.toISOString().slice(0, 10);
  const lang = row.month.org.language;
  const facts = { name: row.user.name, monthDate: monthDateOf(monthStart), games: row.gamesCovered, amountDuePence: row.amountDuePence, lang };
  const phone = row.user.phoneNumber?.replace(/^\+/, "") ?? null;
  if (phone && !args.viaPage && (await claimOnce(`${closeKeyPrefix(args.orgId)}midjoin-dm:${args.monthId}:${args.userId}`, "month-join-dm"))) {
    const collector = row.month.org.paymentHolderId
      ? await db.user.findUnique({ where: { id: row.month.org.paymentHolderId }, select: { name: true } })
      : null;
    const sendAfter = adminNoticeSendAfter(now);
    await db.botJob.create({
      data: { orgId: args.orgId, kind: "dm", phone, text: buildMidMonthJoinDm({ ...facts, collectorName: collector?.name ?? null }), ...(sendAfter ? { sendAfter } : {}) },
    });
  }
  if (await claimOnce(`${closeKeyPrefix(args.orgId)}midjoin:${args.monthId}:${args.userId}`, "admin-notice")) {
    const path = `/admin/months?month=${monthStart}`;
    await sendAdminNotice({ orgId: args.orgId, now, nextPath: path, text: (link) => buildMidMonthJoinNotice({ ...facts, link: link || appUrl(path) }) });
  }
}

// ── Refunds (plan section 7) ───────────────────────────────────────────

export type RefundError = "not-monthly" | "not-collector" | "not-found" | "bad-amount" | "too-much";

/**
 * The collector records that they gave money back: the TOTAL refunded to
 * this person for this month (so saying it twice changes nothing).
 * MatchTime moved none of it. For somebody who left, the credits they
 * were owed are settled with it: voided, marked "refunded", never written
 * again. The collector only (D3): with none set, the owner and admins.
 */
export async function recordRefund(args: {
  orgId: string;
  monthId: string;
  userId: string;
  amountPence: number;
  actorUserId: string;
  now?: Date;
}): Promise<{ ok: true; settledCredits: number } | { ok: false; error: RefundError }> {
  if (!(await isMonthlyClub(args.orgId))) return { ok: false, error: "not-monthly" };
  if (!(await mayConfirmPayments(args.orgId, args.actorUserId))) return { ok: false, error: "not-collector" };
  const amount = args.amountPence;
  if (!(typeof amount === "number" && Number.isInteger(amount) && amount >= 0 && amount <= MAX_PAID_PENCE)) return { ok: false, error: "bad-amount" };
  const now = args.now ?? new Date();
  return db.$transaction(async (tx) => {
    await lockMonth(tx, args.monthId);
    await lockClubCredits(tx, args.orgId);
    const row = await tx.squadMonthMember.findFirst({
      where: { monthId: args.monthId, userId: args.userId, month: { orgId: args.orgId } },
      select: { id: true, kind: true, leftAt: true, paidAt: true, paidClaimedAt: true, paidAmountPence: true, paidClaimedAmountPence: true, amountDuePence: true },
    });
    if (!row) return { ok: false as const, error: "not-found" as const };
    // Never more than they paid for this month: what was confirmed, else
    // what they said they paid (else what they were asked for then).
    const paidPence = row.paidAt ? (row.paidAmountPence ?? row.amountDuePence) : row.paidClaimedAt ? (row.paidClaimedAmountPence ?? row.amountDuePence) : null;
    if (!refundAllowed({ amountPence: amount, paidPence })) return { ok: false as const, error: "too-much" as const };
    await tx.squadMonthMember.update({ where: { id: row.id }, data: { refundedPence: amount } });
    const membership = await tx.membership.findFirst({ where: { orgId: args.orgId, userId: args.userId }, select: { leftAt: true, user: { select: { isActive: true } } } });
    const leaver = isLeaver({
      regular: row.kind === "regular" && row.leftAt === null,
      offMonth: row.leftAt !== null || row.kind === "payg",
      inClub: !!membership && membership.leftAt === null && membership.user.isActive,
      paid: paidOf(row),
    });
    // Only a leaver's credits are settled by a refund. A regular who is
    // still playing keeps theirs: they come off a later month.
    if (!leaver || amount === 0) return { ok: true as const, settledCredits: 0 };
    const res = await tx.squadCredit.updateMany({
      where: { orgId: args.orgId, userId: args.userId, voidedAt: null, appliedMonthId: null },
      data: { voidedAt: now, voidedById: args.actorUserId, voidNote: REFUNDED_NOTE },
    });
    return { ok: true as const, settledCredits: res.count };
  });
}

// ── A share changed after somebody paid (plan section 7) ───────────────

export type ShareChangeError = "not-monthly" | "not-found" | "closed" | "not-priced" | "bad-share" | "bad-concession" | "not-acknowledged";

/**
 * A new share for a month that is priced, when somebody has already paid
 * (the price form refuses that with "locked"). The organiser's explicit
 * action, with an acknowledgement:
 *   - every regular's amount is worked out again; credits are untouched;
 *   - NOBODY'S PAYMENT IS CHANGED. A regular who has paid is shown as
 *     owing the difference, or having it to come back (`paidBalancePence`);
 *   - the organisers are told once who that is, and the group gets the
 *     priced list again (the scheduler posts one per price).
 * Saving the same share again changes nothing and tells nobody.
 */
export async function changeShareAfterPaid(args: {
  orgId: string;
  monthId: string;
  sharePence: number;
  concessionPence: number | null;
  acknowledged: boolean;
  actorUserId: string;
  now?: Date;
}): Promise<{ ok: true; changed: boolean } | { ok: false; error: ShareChangeError }> {
  if (!(await isMonthlyClub(args.orgId))) return { ok: false, error: "not-monthly" };
  if (args.acknowledged !== true) return { ok: false, error: "not-acknowledged" };
  const isPrice = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_PER_GAME_PENCE;
  if (!isPrice(args.sharePence)) return { ok: false, error: "bad-share" };
  if (args.concessionPence !== null && !(isPrice(args.concessionPence) && args.concessionPence <= args.sharePence)) return { ok: false, error: "bad-concession" };
  const now = args.now ?? new Date();
  const [month] = await loadCloseMonths(args.orgId, [args.monthId]);
  if (!month) return { ok: false, error: "not-found" };

  const res = await db.$transaction(async (tx) => {
    await lockMonth(tx, month.id);
    const state = await tx.squadMonth.findUnique({
      where: { id: month.id },
      select: { status: true, pricedAt: true, sharePerGamePence: true, concessionPerGamePence: true },
    });
    if (!state) return { ok: false as const, error: "not-found" as const };
    if (state.status === "closed") return { ok: false as const, error: "closed" as const };
    if (!state.pricedAt || state.sharePerGamePence == null) return { ok: false as const, error: "not-priced" as const };
    if (state.sharePerGamePence === args.sharePence && (state.concessionPerGamePence ?? null) === args.concessionPence) {
      return { ok: true as const, changed: false, rows: [] };
    }
    const rows = await tx.squadMonthMember.findMany({
      where: { monthId: month.id },
      select: {
        id: true,
        userId: true,
        kind: true,
        tier: true,
        note: true,
        leftAt: true,
        gamesCovered: true,
        creditsApplied: true,
        amountDuePence: true,
        paidAt: true,
        paidClaimedAt: true,
        paidAmountPence: true,
        paidClaimedAmountPence: true,
        refundedPence: true,
        user: { select: { name: true } },
      },
    });
    const inClub = new Set(month.members.filter((x) => x.inClub).map((x) => x.userId));
    const plan = planShareChange({
      sharePence: args.sharePence,
      concessionPence: args.concessionPence,
      members: rows.map((r) => ({
        userId: r.userId,
        name: r.user.name ?? "",
        tier: r.tier,
        owes: r.kind === "regular" && r.leftAt === null && inClub.has(r.userId),
        gamesCovered: r.gamesCovered,
        creditsApplied: r.creditsApplied,
        amountDuePence: r.amountDuePence,
        paid: paidOf(r),
        paidPence: r.paidAt ? r.paidAmountPence : r.paidClaimedAt ? r.paidClaimedAmountPence : null,
        refundedPence: r.refundedPence,
      })),
    });
    const idOf = new Map(rows.map((r) => [r.userId, r.id]));
    for (const p of plan) {
      await tx.squadMonthMember.update({
        where: { id: idOf.get(p.userId)! },
        // The claim's AMOUNT is written down (what they were asked for when
        // they said "paid"). Whether they have paid is not touched.
        data: { amountDuePence: p.amountDuePence, ...(p.freezeClaimedPence != null ? { paidClaimedAmountPence: p.freezeClaimedPence } : {}) },
      });
    }
    await tx.squadMonth.update({ where: { id: month.id }, data: { sharePerGamePence: args.sharePence, concessionPerGamePence: args.concessionPence } });
    return { ok: true as const, changed: true, rows: plan };
  });
  if (!res.ok) return res;
  if (!res.changed) return { ok: true, changed: false };

  try {
    const day = formatLondon(now, "yyyy-MM-dd");
    const key = `${closeKeyPrefix(args.orgId)}share:${month.id}:${day}:${weekListHash(`${args.sharePence}|${args.concessionPence ?? ""}`)}`;
    if (await claimOnce(key, "admin-notice")) {
      const path = `/admin/months?month=${month.monthStart}`;
      await sendAdminNotice({
        orgId: args.orgId,
        now,
        nextPath: path,
        text: (link) =>
          buildShareChangeNotice({ rows: res.rows, sharePence: args.sharePence, monthDate: monthDateOf(month.monthStart), link: link || appUrl(path), lang: month.language }),
      });
    }
  } catch (err) {
    console.error(`[month-close] telling the organisers about the new share of ${month.id} failed:`, err);
  }
  return { ok: true, changed: true };
}

// ── The month's money, for /admin/months ───────────────────────────────

export interface LeaverRow {
  userId: string;
  name: string;
  paid: Paid;
  paidPence: number | null;
  /** Unused credits they hold in this club, in games. */
  owedGames: number;
  owedPence: number | null;
  refundedPence: number;
}

export interface MonthMoney {
  /** By user id, for a regular who has paid: positive owes more, negative is owed back. */
  balances: Record<string, number>;
  refunded: Record<string, number>;
  leavers: LeaverRow[];
}

const leaversOf = (month: CloseMonth, unused: Map<string, number>): LeaverRow[] =>
  month.members
    .filter((m) => isLeaver(leaverView(m)))
    .map((m) => {
      const owedGames = unused.get(m.userId) ?? 0;
      return {
        userId: m.userId,
        name: m.name,
        paid: m.paid,
        paidPence: m.paidPence,
        owedGames,
        owedPence: leaverOwedPence({ games: owedGames, tier: m.tier, sharePence: month.sharePerGamePence, concessionPence: month.concessionPerGamePence }),
        refundedPence: m.refundedPence,
      };
    });

/** Who is an active regular of a month: on its list, in the group. */
const activeRegulars = (month: CloseMonth): CloseMember[] => month.members.filter((m) => m.kind === "regular" && m.leftAt === null && m.inClub);

/** What /admin/months shows beside a month's table: the balances after a
 *  share change, the refunds recorded and who left owed. Read only. */
export async function loadMonthMoney(orgId: string, monthIds: string[]): Promise<Record<string, MonthMoney>> {
  if (monthIds.length === 0) return {};
  const months = await loadCloseMonths(orgId, monthIds);
  const leaverIds = [...new Set(months.flatMap((m) => m.members.filter((x) => isLeaver(leaverView(x))).map((x) => x.userId)))];
  const unused = leaverIds.length > 0 ? await unusedCredits(orgId, leaverIds) : new Map<string, number>();
  const out: Record<string, MonthMoney> = {};
  for (const month of months) {
    const balances: Record<string, number> = {};
    const refunded: Record<string, number> = {};
    for (const m of activeRegulars(month)) {
      const b = paidBalancePence(m);
      if (b !== 0) balances[m.userId] = b;
      if (m.refundedPence > 0) refunded[m.userId] = m.refundedPence;
    }
    out[month.id] = { balances, refunded, leavers: leaversOf(month, unused) };
  }
  return out;
}

// ── The month close and its summary (plan 4.4) ─────────────────────────

/** The month's numbers as they stand (`summariseMonth`). Read only. */
export async function loadMonthSummary(month: CloseMonth, now: Date = new Date()): Promise<MonthSummary> {
  const played = month.matches.filter((m) => m.status !== "CANCELLED" && m.date.getTime() >= month.startsAt.getTime() && m.date.getTime() < now.getTime());
  const [org, attendances, unusedRows, used] = await Promise.all([
    db.organisation.findUnique({ where: { id: month.orgId }, select: { paygPricePence: true } }),
    played.length === 0
      ? Promise.resolve([])
      : db.attendance.findMany({
          where: { matchId: { in: played.map((m) => m.id) }, status: "CONFIRMED", OR: [{ paymentMethod: null }, { paymentMethod: { not: "monthly" } }] },
          select: { matchId: true, paidAt: true, user: { select: { name: true } } },
        }),
    db.squadCredit.findMany({
      where: { orgId: month.orgId, voidedAt: null, appliedMonthId: null },
      select: { userId: true, games: true, user: { select: { name: true } } },
    }),
    db.squadCredit.aggregate({ where: { orgId: month.orgId, appliedMonthId: month.id, voidedAt: null }, _sum: { games: true } }),
  ]);
  const matchOf = new Map(played.map((m) => [m.id, m]));
  const unused = new Map<string, number>();
  for (const c of unusedRows) unused.set(c.userId, (unused.get(c.userId) ?? 0) + c.games);
  const leavers = leaversOf(month, unused);
  const leaverIds = new Set(leavers.map((l) => l.userId));
  // The games played: the ones before the month started here (the
  // organiser's own count), and the calendar's since.
  const since = month.games.filter((g) => g.date.getTime() >= month.startsAt.getTime() && g.date.getTime() < now.getTime()).length;
  return summariseMonth({
    gamesPlayed: month.gamesPlayedBeforeStart + since,
    regulars: activeRegulars(month).map((m) => ({ name: m.name, amountDuePence: m.amountDuePence, paid: m.paid, paidPence: m.paidPence, refundedPence: m.refundedPence })),
    payg: attendances
      .map((a) => {
        const match = matchOf.get(a.matchId)!;
        const feePence = match.feePerPlayer != null ? Math.round(match.feePerPlayer * 100) : (org?.paygPricePence ?? null);
        return { name: a.user.name ?? "", date: match.date, feePence, paid: a.paidAt !== null };
      })
      .sort((a, b) => a.date.getTime() - b.date.getTime() || a.name.localeCompare(b.name)),
    // What a leaver holds is owed as money, on its own line.
    carried: unusedRows.filter((c) => !leaverIds.has(c.userId)).map((c) => ({ name: c.user.name ?? "", games: c.games })),
    creditsUsed: used._sum.games ?? 0,
    leavers: leavers.map((l) => ({ name: l.name, games: l.owedGames, pence: l.owedPence })),
  });
}

/** A closed (or any) month's summary for the page. Null: not this club's. */
export async function loadMonthSummaryById(orgId: string, monthId: string, now: Date = new Date()): Promise<{ summary: MonthSummary; monthStart: string } | null> {
  const [month] = await loadCloseMonths(orgId, [monthId]);
  if (!month) return null;
  return { summary: await loadMonthSummary(month, now), monthStart: month.monthStart };
}

/**
 * Close every month of a club that is due: the morning after its last
 * game, from 08:00 London, in waking hours. Once per month: `closedAt` is
 * the claim (a compare-and-set on the status), so two polls close a month
 * once and one summary goes out.
 *
 * Before the claim the month's bookkeeping is brought up to date one last
 * time (who missed which game, called-off games, leavers). After it the
 * numbers are frozen: nothing here or in the weekly flow writes a credit
 * for a closed month again. The collector can still confirm a payment.
 */
export async function closeDueMonths(orgId: string, now: Date = new Date(), preloaded?: CloseMonth[]): Promise<string[]> {
  const months = (preloaded ?? (await loadCloseMonths(orgId))).filter((m) => m.status === "running" && m.lastKickoff && monthCloseDue({ now, lastKickoff: m.lastKickoff }));
  const closed: string[] = [];
  for (const month of months) {
    try {
      const { syncMonthlyWeek } = await import("./monthly-week");
      for (const match of month.matches) {
        if (match.status === "CANCELLED" || match.date.getTime() < month.startsAt.getTime()) continue;
        await syncMonthlyWeek(match.id, now);
      }
      await reconcileCancelledWeeks(orgId, now, [month]);
      await reconcileLeavers(orgId, now, [month]);

      const claim = await db.squadMonth.updateMany({ where: { id: month.id, status: "running", closedAt: null }, data: { status: "closed", closedAt: now } });
      if (claim.count === 0) continue;
      closed.push(month.id);
      console.log(`[month-close] closed ${month.monthStart} for ${orgId}/${month.activityId}`);
    } catch (err) {
      // One month's failure must not stop the others.
      console.error(`[month-close] closing ${month.id} failed:`, err);
    }
  }
  // The summary has a claim of ITS OWN, so one that failed to send after
  // the close is sent by a later sweep and is never lost.
  await sendDueCloseSummaries(orgId, now);
  return closed;
}

/** How long after a close its summary is still worth sending. */
const SUMMARY_RETRY_DAYS = 3;
const summaryKey = (orgId: string, monthId: string): string => `${closeKeyPrefix(orgId)}summary:${monthId}`;

/**
 * Send the summary of every month closed lately that has not had one.
 * Once per month: the key is claimed first (so two sweeps send one), and
 * RELEASED if the send fails or reaches nobody, so the next sweep tries
 * again, for three days.
 */
export async function sendDueCloseSummaries(orgId: string, now: Date = new Date()): Promise<number> {
  const months = await db.squadMonth.findMany({
    where: { orgId, status: "closed", closedAt: { gte: new Date(now.getTime() - SUMMARY_RETRY_DAYS * DAY_MS) } },
    select: { id: true },
  });
  if (months.length === 0) return 0;
  const done = new Set(
    (await db.sentNotification.findMany({ where: { key: { in: months.map((m) => summaryKey(orgId, m.id)) } }, select: { key: true } })).map((r) => r.key),
  );
  let sent = 0;
  for (const m of months) {
    const key = summaryKey(orgId, m.id);
    if (done.has(key) || !(await claimOnce(key, "admin-notice"))) continue;
    try {
      const [fresh] = await loadCloseMonths(orgId, [m.id]);
      if (!fresh) throw new Error("the month could not be read");
      const summary = await loadMonthSummary(fresh, now);
      const path = `/admin/months?month=${fresh.monthStart}`;
      const res = await sendAdminNotice({
        orgId,
        now,
        nextPath: path,
        text: (link) => buildMonthSummaryNotice({ summary, monthDate: monthDateOf(fresh.monthStart), link: link || appUrl(path), lang: fresh.language }),
      });
      if (res.queued === 0) throw new Error("nobody to send it to");
      sent++;
    } catch (err) {
      await db.sentNotification.deleteMany({ where: { key } }).catch(() => {});
      console.error(`[month-close] the summary of ${m.id} was not sent (the next sweep retries):`, err);
    }
  }
  return sent;
}

/** True once per club per London hour. A read first, so a poll that is
 *  not the hour's first costs one indexed lookup and no failed insert. */
async function claimHourly(orgId: string, now: Date): Promise<boolean> {
  const prefix = `org-${orgId}:monthly-close-sweep:`;
  const key = `${prefix}${formatLondon(now, "yyyy-MM-dd'T'HH")}`;
  if (await db.sentNotification.findUnique({ where: { key }, select: { id: true } })) return false;
  if (!(await claimOnce(key, "monthly-sweep"))) return false;
  // Only this hour's row is ever needed, and the scheduler loads every
  // `org-<id>:` key on each poll: drop the earlier ones, and this slice's
  // once-only keys once their month is well behind us.
  await db.sentNotification.deleteMany({ where: { key: { startsWith: prefix, not: key } } }).catch(() => {});
  await db.sentNotification
    .deleteMany({ where: { key: { startsWith: closeKeyPrefix(orgId) }, createdAt: { lt: new Date(Date.now() - 45 * DAY_MS) } } })
    .catch(() => {});
  return true;
}

/**
 * The due-posts poll's one call for this slice, made only for a club the
 * sign-up sweep has just found to be monthly and operational. At most
 * once a London hour per club: called-off games, leavers, and the months
 * that are due to close. Never throws. Returns the months it closed.
 */
export async function sweepMonthClose(orgId: string, now: Date = new Date()): Promise<string[]> {
  try {
    if (!(await claimHourly(orgId, now))) return [];
    const org = await db.organisation.findUnique({
      where: { id: orgId },
      select: { squadMode: true, approvalStatus: true, dormantAt: true, billingStatus: true },
    });
    if (!org || normaliseSquadMode(org.squadMode) !== "monthly" || !isClubOperational(org)) return [];
    const months = await loadCloseMonths(orgId);
    if (months.length === 0) {
      // Nothing open, but a summary may still be owed for a month just closed.
      await sendDueCloseSummaries(orgId, now);
      return [];
    }
    await reconcileCancelledWeeks(orgId, now, months);
    await reconcileLeavers(orgId, now, months);
    return await closeDueMonths(orgId, now, months);
  } catch (err) {
    console.error(`[month-close] sweep for ${orgId} failed (the next hour retries):`, err);
    return [];
  }
}

// ── Away weeks (plan 5.2 and 9.3) ──────────────────────────────────────

export interface AwayView {
  monthId: string;
  creditRule: MonthCreditRule;
  games: Array<{ matchId: string | null; day: string; date: string; ticked: boolean; editable: boolean; seeded: boolean }>;
}

/**
 * The games of a month a regular can tick as away, for /month. Null when
 * the person is not a regular on the month's list. A game with no Match
 * row yet (a month started part-way has one for the next game only) is
 * shown by its day: ticking it makes sure the row exists (`setAwayWeeks`).
 */
export async function loadAwayView(orgId: string, monthId: string, userId: string, now: Date = new Date()): Promise<AwayView | null> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { squadMode: true, monthCreditRule: true } });
  if (!org || normaliseSquadMode(org.squadMode) !== "monthly") return null;
  const [month] = await loadCloseMonths(orgId, [monthId]);
  if (!month || month.status === "closed") return null;
  const me = month.members.find((m) => m.userId === userId);
  if (!me || me.kind !== "regular" || me.leftAt !== null || !me.inClub) return null;
  const seededOf = new Map(month.matches.map((m) => [m.id, m.seeded]));
  const games = month.games
    .filter((g) => g.date.getTime() > now.getTime() && g.date.getTime() >= month.startsAt.getTime())
    .map((g) => {
      const seeded = g.matchId ? (seededOf.get(g.matchId) ?? false) : false;
      return {
        matchId: g.matchId,
        day: londonDay(g.date),
        date: g.date.toISOString(),
        ticked: g.matchId ? me.absentMatchIds.includes(g.matchId) : false,
        editable: !seeded,
        seeded,
      };
    });
  return { monthId: month.id, creditRule: normaliseCreditRule(org.monthCreditRule), games };
}

/**
 * Make sure a month's games still to come have their Match rows, so an
 * away week can name one. The same rows, made the same way, as when
 * MatchTime opens a month's list itself (`openMonthList`): deduped by the
 * fixture's slot, under the same advisory lock, and silent (only a
 * fixture's next match is ever posted about). Returns nothing new for a
 * month whose rows all exist.
 */
async function ensureMonthMatches(month: CloseMonth, now: Date): Promise<void> {
  if (!month.games.some((g) => g.matchId === null && g.date.getTime() > now.getTime())) return;
  const activity = await db.activity.findUnique({
    where: { id: month.activityId },
    select: { id: true, deadlineHours: true, isActive: true, sport: { select: { playersPerTeam: true } } },
  });
  if (!activity || !activity.isActive) return;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`squad-month-open:${month.orgId}:${month.monthStart}`}))`;
    const existing = await tx.match.findMany({
      where: {
        activity: { orgId: month.orgId },
        date: { gte: londonDateTimeToUtc(month.monthStart, "00:00"), lt: londonDateTimeToUtc(nextMonthStart(month.monthStart), "00:00") },
      },
      select: { date: true, activity: { select: { orgId: true, venue: true, dayOfWeek: true } } },
    });
    const taken = existing.map((m) => ({ ...m.activity, instant: m.date }));
    for (const g of month.games) {
      if (g.matchId !== null || g.date.getTime() <= now.getTime()) continue;
      if (hasMatchForSlot({ ...month.fixture, instant: g.date }, taken)) continue;
      await tx.match.create({
        data: {
          activityId: activity.id,
          date: g.date,
          maxPlayers: activity.sport.playersPerTeam * 2,
          attendanceDeadline: new Date(g.date.getTime() - activity.deadlineHours * HOUR_MS),
        },
      });
      taken.push({ ...month.fixture, instant: g.date });
    }
  });
}

export type AwayError = "not-monthly" | "not-found" | "not-a-regular";

/**
 * A regular says, ahead of time, which games of the month they will miss
 * (the London days ticked on /month, "YYYY-MM-DD"). Writes
 * `absentMatchIds`: those weeks are seeded without them, listed under
 * "can't play" and credited by the club's own rule, exactly as an away
 * week from a pasted list is. No model.
 *
 * Only a game that has not kicked off and that the squad is not on yet can
 * be changed here (`planAwayWeeks`). Once the squad is out, a regular says
 * OUT the usual way, so the bench and the PAYG pool are asked as normal.
 * Under the month's lock; the same ticks twice change nothing.
 */
export async function setAwayWeeks(args: {
  orgId: string;
  monthId: string;
  userId: string;
  days: string[];
  now?: Date;
}): Promise<{ ok: true; changed: boolean; absentMatchIds: string[] } | { ok: false; error: AwayError }> {
  const now = args.now ?? new Date();
  if (!(await isMonthlyClub(args.orgId))) return { ok: false, error: "not-monthly" };
  let [month] = await loadCloseMonths(args.orgId, [args.monthId]);
  if (!month || month.status === "closed") return { ok: false, error: "not-found" };
  const me = month.members.find((m) => m.userId === args.userId);
  if (!me || me.kind !== "regular" || me.leftAt !== null || !me.inClub) return { ok: false, error: "not-a-regular" };

  const days = new Set((Array.isArray(args.days) ? args.days : []).filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)));
  // A ticked game with no row yet: make the month's rows, then read again.
  if (month.games.some((g) => g.matchId === null && g.date.getTime() > now.getTime() && days.has(londonDay(g.date)))) {
    await ensureMonthMatches(month, now);
    [month] = await loadCloseMonths(args.orgId, [args.monthId]);
    if (!month) return { ok: false, error: "not-found" };
  }
  const seededOf = new Map(month.matches.map((m) => [m.id, m.seeded]));
  const games: AwayGame[] = month.games
    .filter((g): g is { matchId: string; date: Date } => g.matchId !== null && g.date.getTime() >= month.startsAt.getTime())
    .map((g) => ({ matchId: g.matchId, date: g.date, seeded: seededOf.get(g.matchId) ?? false }));
  const ticked = games.filter((g) => days.has(londonDay(g.date)) && awayEditable(g, now)).map((g) => g.matchId);

  const res = await db.$transaction(async (tx) => {
    await lockMonth(tx, month.id);
    const row = await tx.squadMonthMember.findUnique({ where: { id: me.id }, select: { absentMatchIds: true, kind: true, leftAt: true } });
    if (!row || row.kind !== "regular" || row.leftAt !== null) return null;
    const plan = planAwayWeeks({ games, ticked, current: row.absentMatchIds, now });
    if (plan.changed) await tx.squadMonthMember.update({ where: { id: me.id }, data: { absentMatchIds: plan.absentMatchIds } });
    return plan;
  });
  if (!res) return { ok: false, error: "not-a-regular" };

  if (res.changed) {
    // The credit rule applies at once (a credit for a game still to come
    // is taken back if they play after all): the weekly flow's own sync.
    try {
      const { syncMonthlyWeek } = await import("./monthly-week");
      const before = new Set(me.absentMatchIds);
      const after = new Set(res.absentMatchIds);
      for (const g of games) {
        if (before.has(g.matchId) !== after.has(g.matchId)) await syncMonthlyWeek(g.matchId, now);
      }
    } catch (err) {
      console.error(`[month-close] bookkeeping after away weeks for ${args.userId} failed (the poll's sweep reconciles):`, err);
    }
  }
  return { ok: true, changed: res.changed, absentMatchIds: res.absentMatchIds };
}
