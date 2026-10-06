/**
 * Monthly squad, slice 6: credits, cancelled weeks, joining and leaving
 * part-way, a share changed after somebody paid, refunds, the month close
 * and its summary, and away weeks. The pure rules (2026-10-06).
 * Plan: MDs/monthly-squad-plan-2026-10-05.md, sections 4.4, 5.2, 7 and 9.
 *
 *   LEDGER     `cleanCreditNote`, `validManualGames`, `creditState`.
 *   CANCELLED  `decideCancelledWeekCredits`: one credit per regular charged
 *              for a game that was called off, once, taken back on restore.
 *   LEAVING    `isLeaver`, `decideLeaverCredits`, `leaverOwedPence`: what a
 *              regular who paid and left is owed. Shown; never refunded by
 *              MatchTime.
 *   SHARE      `paidBalancePence`, `planShareChange`: a share changed after
 *              somebody paid. The difference is shown, never applied
 *              silently.
 *   CLOSE      `monthCloseDue`, `summariseMonth`.
 *   AWAY       `planAwayWeeks`: the weeks a regular ticks in advance.
 *
 * Nothing here reads a database, calls a model or moves money.
 */
import { formatLondon, londonDateTimeToUtc } from "./london-time";
import { isDaytime } from "./month-signup-rules";
import { ROLLING_SEED_HOUR } from "./rolling-squad-rules";

export type Paid = "none" | "claimed" | "confirmed";

// ── The ledger ─────────────────────────────────────────────────────────

/** An organiser's reason is a few words, not an essay. Mirrors the CHECK. */
export const CREDIT_NOTE_MIN = 3;
export const CREDIT_NOTE_MAX = 200;
/** One "Add credit" is at most a long month of games. A typo guard. */
export const MAX_MANUAL_CREDIT_GAMES = 10;

/** The organiser's words, on one line, control characters out. Null when
 *  it is too short to be a reason or too long to be one. */
export function cleanCreditNote(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const flat = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length >= CREDIT_NOTE_MIN && flat.length <= CREDIT_NOTE_MAX ? flat : null;
}

export function validManualGames(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_MANUAL_CREDIT_GAMES;
}

export type CreditState = "available" | "used" | "removed" | "refunded" | "taken-back";

/** The note the collector's "Refunded" writes on each credit it settles.
 *  One constant, shared by the writer and the reader. */
export const REFUNDED_NOTE = "refunded";

/** Where one ledger row stands, for the credits page. */
export function creditState(c: { voidedAt: Date | null; voidedById: string | null; voidNote: string | null; appliedMonthId: string | null }): CreditState {
  if (c.voidedAt) {
    if (c.voidNote === REFUNDED_NOTE) return "refunded";
    // MatchTime takes a credit back itself when the reason for it has gone
    // (the regular played after all, the cancelled week is back on).
    return c.voidedById ? "removed" : "taken-back";
  }
  return c.appliedMonthId ? "used" : "available";
}

// ── A cancelled week (plan section 7) ──────────────────────────────────

export interface CancelMember {
  userId: string;
  /** A regular of the month who is still on it (`leftAt` null). */
  regular: boolean;
  /** Still in the group and active. */
  inClub: boolean;
  paid: Paid;
  /** When they became a regular of this month: a game played before it is
   *  not one they are charged for. */
  joinedAt: Date;
}

export interface MatchCredit {
  id: string;
  userId: string;
  reason: string;
  voidedAt: Date | null;
  voidedById: string | null;
  appliedMonthId: string | null;
  createdById: string | null;
}

export interface CancelledWeekPlan {
  /** A "cancelled-week" credit to write. `applyNow`: the regular has not
   *  paid yet, so it comes straight off what they are asked for this month. */
  create: Array<{ userId: string; applyNow: boolean }>;
  /** "missed" credits for this game that the cancellation replaces. */
  voidMissedIds: string[];
  /** "cancelled-week" credits to take back: the game is on again. */
  voidIds: string[];
  /** Of `voidIds`, the ones that had come off this month's amount. */
  release: Array<{ creditId: string; userId: string }>;
  /** The game is on again, but its credit was already used against
   *  ANOTHER month: it is taken back there (that month asks for one game
   *  more, shown as "owes more" if they have paid), never silently kept. */
  releaseElsewhere: Array<{ creditId: string; userId: string; monthId: string }>;
}

/**
 * The credits a called-off game owes, from the state as it is now. It is
 * worked out again on every run, so cancelling twice, a retry, or two
 * polls at once write one credit; and restoring the game takes it back.
 *
 *  - every regular who is charged for that game gets ONE "cancelled-week"
 *    credit: still on the month, still in the group, a regular before the
 *    game's date, and a regular before it was called off;
 *  - somebody who has paid (or says so) keeps it for a later month. Somebody
 *    who has NOT paid yet has it taken off this month's amount at once, so
 *    nobody is asked to pay for a game that is not played;
 *  - a "missed" credit for the same game is replaced, never added to: one
 *    game is one credit. (One that was already used stands, and no second
 *    credit is written.);
 *  - a credit an organiser removed is never written again;
 *  - a credit is only ever taken back from a regular who is still here.
 *    Somebody who has left keeps what they were given.
 */
export function decideCancelledWeekCredits(p: {
  cancelled: boolean;
  matchDate: Date;
  /** When the game was called off, as nearly as it is known. Somebody who
   *  became a regular AFTER that was never charged for it: the games they
   *  cover were counted without it. Null: not known (nobody is left out). */
  cancelledAt?: Date | null;
  monthId: string;
  members: CancelMember[];
  /** Every credit earned on this match, any reason, voided ones included. */
  existing: MatchCredit[];
}): CancelledWeekPlan {
  const plan: CancelledWeekPlan = { create: [], voidMissedIds: [], voidIds: [], release: [], releaseElsewhere: [] };
  const here = p.members.filter((m) => m.regular && m.inClub);
  const mine = (userId: string, reason: string) => p.existing.filter((c) => c.userId === userId && c.reason === reason);

  if (!p.cancelled) {
    const hereIds = new Set(here.map((m) => m.userId));
    for (const c of p.existing) {
      if (c.reason !== "cancelled-week" || c.voidedAt !== null || !hereIds.has(c.userId)) continue;
      // Used against another month already: handed back there.
      if (c.appliedMonthId !== null && c.appliedMonthId !== p.monthId) {
        plan.releaseElsewhere.push({ creditId: c.id, userId: c.userId, monthId: c.appliedMonthId });
        continue;
      }
      plan.voidIds.push(c.id);
      if (c.appliedMonthId === p.monthId) plan.release.push({ creditId: c.id, userId: c.userId });
    }
    return plan;
  }

  for (const m of here) {
    if (p.matchDate.getTime() <= m.joinedAt.getTime()) continue;
    if (p.cancelledAt && m.joinedAt.getTime() >= p.cancelledAt.getTime()) continue;
    const cancelled = mine(m.userId, "cancelled-week");
    const missed = mine(m.userId, "missed").filter((c) => c.voidedAt === null);
    // A "missed" credit for this game that was already used stands.
    const spent = missed.some((c) => c.appliedMonthId !== null);
    const live = cancelled.some((c) => c.voidedAt === null);
    const removedByOrganiser = cancelled.some((c) => c.voidedById !== null);
    // ONE live credit per player per game, whatever the reason: somebody
    // who left and came back may still hold a "left-mid-month" one for it.
    if (p.existing.some((c) => c.userId === m.userId && c.voidedAt === null && c.reason !== "missed" && c.reason !== "cancelled-week")) continue;
    if (live || spent) {
      // One game, one credit: an unspent "missed" one beside it goes.
      if (live) plan.voidMissedIds.push(...missed.filter((c) => c.appliedMonthId === null && c.createdById === null).map((c) => c.id));
      continue;
    }
    if (removedByOrganiser) continue;
    plan.voidMissedIds.push(...missed.filter((c) => c.createdById === null).map((c) => c.id));
    plan.create.push({ userId: m.userId, applyNow: m.paid === "none" });
  }
  return plan;
}

// ── Leaving part-way through (plan section 7) ──────────────────────────

export interface LeaverMember {
  /** Still a regular on the month's list. */
  regular: boolean;
  /** Taken off the month (`leftAt`), or moved to pay-as-you-go. */
  offMonth: boolean;
  inClub: boolean;
  paid: Paid;
}

/** A regular who PAID (or says so) and is one no longer: taken off the
 *  month, moved to pay-as-you-go, or gone from the group. */
export function isLeaver(m: LeaverMember): boolean {
  return m.paid !== "none" && (m.offMonth || !m.inClub);
}

export interface LeaverGame {
  /** Null when no Match row exists for that game yet. */
  matchId: string | null;
  date: Date;
}

/**
 * The "left-mid-month" credits of one member of one month, from the state
 * as it is now (so a retry or a second poll writes nothing more).
 *
 *  - a leaver is owed one game for every game of the month still to be
 *    played when they left. A game they already hold a credit for (an away
 *    week, a cancelled week) is not counted twice;
 *  - written once: while any of them stands, nothing is added; and once
 *    the collector has settled them ("Refunded") or an organiser removed
 *    one, none is ever written again for that month;
 *  - somebody who is back (a regular again, in the group) has the unused
 *    ones taken back: they are playing the games after all.
 * MatchTime refunds nobody. The collector sees what is owed.
 */
export function decideLeaverCredits(p: {
  member: LeaverMember;
  /** When they left. */
  leftAt: Date;
  /** The month's games still on (the calendar minus the cancelled weeks). */
  games: LeaverGame[];
  /** This member's "left-mid-month" credits for this month, voided ones included. */
  existing: MatchCredit[];
  /** The matches this member already holds a live credit for, any reason. */
  creditedMatchIds: ReadonlySet<string>;
}): { create: Array<{ matchId: string | null }>; voidIds: string[] } {
  const live = p.existing.filter((c) => c.voidedAt === null);
  if (!isLeaver(p.member)) {
    const back = p.member.regular && p.member.inClub;
    return { create: [], voidIds: back ? live.filter((c) => c.appliedMonthId === null && c.createdById === null).map((c) => c.id) : [] };
  }
  if (live.length > 0 || p.existing.some((c) => c.voidedById !== null)) return { create: [], voidIds: [] };
  const create = p.games
    .filter((g) => g.date.getTime() > p.leftAt.getTime() && !(g.matchId !== null && p.creditedMatchIds.has(g.matchId)))
    .map((g) => ({ matchId: g.matchId }));
  return { create, voidIds: [] };
}

/** What the games a leaver is owed are worth: the share of the month they
 *  left, at their own tier. Null while that month has no share. */
export function leaverOwedPence(p: { games: number; tier: string; sharePence: number | null; concessionPence: number | null }): number | null {
  if (p.sharePence == null) return null;
  const share = p.tier === "concession" && p.concessionPence != null ? p.concessionPence : p.sharePence;
  return share * Math.max(0, p.games);
}

/** A refund is never more than what the person paid for that month, and
 *  with no payment recorded there is nothing to refund. */
export function refundAllowed(p: { amountPence: unknown; paidPence: number | null }): boolean {
  const a = p.amountPence;
  if (!(typeof a === "number" && Number.isInteger(a) && a >= 0)) return false;
  return a <= (p.paidPence ?? 0);
}

/** A reply counts against a digest for two days (slice 4's window). */
const CLOSED_REPLY_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Is the collector's "PAID ..." an answer to the last digest of a month
 * that has since CLOSED? Then it is answered ("October is closed; confirm
 * on the Months page"), never ignored and never applied to another month.
 * Yes when that digest is still in its two days, and either the reply
 * names that month, or names none and no live month has a newer digest. A
 * number that was not on that digest's list is somebody's own message.
 */
export function closedDigestReply(p: {
  reply: { kind: "all" | "none" | "numbers"; numbers?: number[]; month?: number };
  closed: { monthNumber: number; digestAt: Date; listedSlots: number[] };
  /** The newest digest of a live month this sender may confirm for. */
  liveDigestAt: Date | null;
  now: Date;
}): boolean {
  if (p.now.getTime() - p.closed.digestAt.getTime() > CLOSED_REPLY_WINDOW_MS) return false;
  if (p.reply.month != null) {
    if (p.reply.month !== p.closed.monthNumber) return false;
  } else if (p.liveDigestAt && p.liveDigestAt.getTime() > p.closed.digestAt.getTime()) return false;
  if (p.reply.kind === "numbers") return (p.reply.numbers ?? []).some((n) => p.closed.listedSlots.includes(n));
  return true;
}

// ── A share changed after somebody paid (plan section 7) ───────────────

/**
 * What a regular who has paid (or says so) still owes, or is owed back:
 * what they are asked for now, minus what they paid, plus what was
 * refunded. Positive: they owe that much more. Negative: that much is
 * theirs. Zero when nothing is known to be out (no amount set, or no
 * amount recorded for the payment).
 */
export function paidBalancePence(p: { paid: Paid; amountDuePence: number | null; paidPence: number | null; refundedPence: number }): number {
  if (p.paid === "none" || p.amountDuePence == null || p.paidPence == null) return 0;
  return p.amountDuePence - (p.paidPence - Math.max(0, p.refundedPence));
}

export interface ShareMember {
  userId: string;
  name: string;
  tier: string;
  /** A regular on the month, not waiting, still in the group. */
  owes: boolean;
  gamesCovered: number;
  creditsApplied: number;
  amountDuePence: number | null;
  paid: Paid;
  /** What was confirmed, else what was claimed, else null. */
  paidPence: number | null;
  refundedPence: number;
}

export interface ShareChangeRow {
  userId: string;
  name: string;
  amountDuePence: number;
  /** For somebody who SAYS they paid with no amount recorded: what they
   *  were asked for when they said it, written down so the difference can
   *  be shown. Null: leave the claim as it is. */
  freezeClaimedPence: number | null;
  /** After the change. Positive: owes more. Negative: owed back. 0 for
   *  somebody who has not paid (they are simply asked for the new amount). */
  balancePence: number;
}

/**
 * A new share for a month somebody has already paid for. Every regular's
 * amount is worked out again (share x (games - credits), their credits
 * untouched). Nobody's payment is changed: for a regular who has paid, the
 * difference is the balance the collector settles.
 */
export function planShareChange(p: { members: ShareMember[]; sharePence: number; concessionPence: number | null }): ShareChangeRow[] {
  const rows: ShareChangeRow[] = [];
  for (const m of p.members) {
    if (!m.owes) continue;
    const share = m.tier === "concession" && p.concessionPence !== null ? p.concessionPence : p.sharePence;
    const amountDuePence = share * Math.max(0, m.gamesCovered - m.creditsApplied);
    const freezeClaimedPence = m.paid === "claimed" && m.paidPence == null ? m.amountDuePence : null;
    const paidPence = m.paidPence ?? freezeClaimedPence;
    rows.push({
      userId: m.userId,
      name: m.name,
      amountDuePence,
      freezeClaimedPence,
      balancePence: paidBalancePence({ paid: m.paid, amountDuePence, paidPence, refundedPence: m.refundedPence }),
    });
  }
  return rows;
}

// ── The month close (plan 4.4) ─────────────────────────────────────────

/** The morning after the month's last game, from 08:00 London (the hour
 *  the squad is seeded), in waking hours only. */
export function monthCloseDue(p: { now: Date; lastKickoff: Date }): boolean {
  const day = new Date(`${formatLondon(p.lastKickoff, "yyyy-MM-dd")}T12:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  const from = londonDateTimeToUtc(day.toISOString().slice(0, 10), ROLLING_SEED_HOUR);
  return p.now.getTime() >= from.getTime() && isDaytime(p.now);
}

export interface SummaryRegular {
  name: string;
  amountDuePence: number | null;
  paid: Paid;
  paidPence: number | null;
  refundedPence: number;
}

export interface SummaryPayg {
  name: string;
  date: Date;
  feePence: number | null;
  paid: boolean;
}

export interface SummaryOwed {
  name: string;
  games: number;
  pence: number | null;
}

export interface MonthSummary {
  gamesPlayed: number;
  regulars: number;
  confirmed: { count: number; totalPence: number };
  claimed: Array<{ name: string; pence: number | null }>;
  unpaid: Array<{ name: string; pence: number }>;
  owesMore: Array<{ name: string; pence: number }>;
  owedBack: Array<{ name: string; pence: number }>;
  payg: { games: number; totalPence: number; paid: number; toChase: Array<{ name: string; date: Date }> };
  /** Unused credits, by player: what comes off a later month. */
  carried: { games: number; people: Array<{ name: string; games: number }> };
  creditsUsed: number;
  leavers: SummaryOwed[];
}

/**
 * The month's numbers, for the collector (plan 4.4): who paid, who owes,
 * the pay-as-you-go totals and the credits carried on. "Says paid" is
 * never counted as paid.
 */
export function summariseMonth(p: {
  gamesPlayed: number;
  regulars: SummaryRegular[];
  payg: SummaryPayg[];
  /** One entry per unused credit's owner (a name per game is fine). */
  carried: Array<{ name: string; games: number }>;
  creditsUsed: number;
  leavers: SummaryOwed[];
}): MonthSummary {
  const confirmed = p.regulars.filter((r) => r.paid === "confirmed");
  const balances = p.regulars
    .map((r) => ({ name: r.name, pence: paidBalancePence(r) }))
    .filter((b) => b.pence !== 0);
  const carried = new Map<string, number>();
  for (const c of p.carried) carried.set(c.name, (carried.get(c.name) ?? 0) + c.games);
  const people = [...carried].map(([name, games]) => ({ name, games })).sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
  return {
    gamesPlayed: p.gamesPlayed,
    regulars: p.regulars.length,
    confirmed: { count: confirmed.length, totalPence: confirmed.reduce((sum, r) => sum + (r.paidPence ?? 0), 0) },
    claimed: p.regulars.filter((r) => r.paid === "claimed").map((r) => ({ name: r.name, pence: r.paidPence ?? r.amountDuePence })),
    unpaid: p.regulars.filter((r) => r.paid === "none" && (r.amountDuePence ?? 0) > 0).map((r) => ({ name: r.name, pence: r.amountDuePence ?? 0 })),
    owesMore: balances.filter((b) => b.pence > 0),
    owedBack: balances.filter((b) => b.pence < 0).map((b) => ({ name: b.name, pence: -b.pence })),
    payg: {
      games: p.payg.length,
      totalPence: p.payg.reduce((sum, g) => sum + (g.feePence ?? 0), 0),
      paid: p.payg.filter((g) => g.paid).length,
      toChase: p.payg.filter((g) => !g.paid).map((g) => ({ name: g.name, date: g.date })),
    },
    carried: { games: people.reduce((sum, x) => sum + x.games, 0), people },
    creditsUsed: p.creditsUsed,
    leavers: p.leavers.filter((l) => l.games > 0),
  };
}

// ── Away weeks (plan 5.2 and 9.3) ──────────────────────────────────────

export interface AwayGame {
  matchId: string;
  date: Date;
  /** The month's regulars are already on this match. From then on a
   *  regular says OUT the usual way (the group, a DM, the match page). */
  seeded: boolean;
}

/** A game a regular can still tick: not kicked off, and not seeded yet. */
export function awayEditable(g: AwayGame, now: Date): boolean {
  return g.date.getTime() > now.getTime() && !g.seeded;
}

/**
 * The away weeks to store after a regular's ticks. Only the games they
 * can still tick are changed; whatever is recorded for a game that has
 * been played, or that the squad is already on, stays as it is.
 */
export function planAwayWeeks(p: { games: AwayGame[]; ticked: string[]; current: string[]; now: Date }): { absentMatchIds: string[]; changed: boolean } {
  const editable = new Set(p.games.filter((g) => awayEditable(g, p.now)).map((g) => g.matchId));
  const kept = p.current.filter((id) => !editable.has(id));
  const added = [...new Set(p.ticked)].filter((id) => editable.has(id));
  const absentMatchIds = [...kept, ...added];
  const before = new Set(p.current);
  const changed = absentMatchIds.length !== before.size || absentMatchIds.some((id) => !before.has(id));
  return { absentMatchIds, changed };
}
