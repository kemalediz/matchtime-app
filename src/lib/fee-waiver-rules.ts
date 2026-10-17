/**
 * FREE PLACES, THE PURE RULES (2026-10-16). No database, no clock.
 *
 * A club can give a player a free place on a match (FNF: the player who
 * washes the bibs). That is `Attendance.feeWaivedAt`: the player owes
 * nothing, and it is NOT a payment. `paidAt` means money reached the
 * collector; a free place means no money is due. Keeping them apart is
 * what lets the payments page show "Free" and leave it out of
 * "collected", which tonight's stopgap (#299, marking them "received")
 * could not.
 *
 * Every reader of "who owes for this match" applies the same three
 * exclusions, here: the collector (collects, does not pay), a monthly
 * regular (paid for by the month), and a free place. Paid rows are left
 * to each reader, because some count them (the fee headcount: a player
 * who already paid cash still paid THIS fee) and some do not (the chase).
 *
 * Paid wins over free everywhere: a row can end up both (a bank payment
 * that started before the free place and settled after it). Money moved,
 * so it reads as paid and the collector refunds it if they want to;
 * MatchTime never moves money back by itself.
 */
/** `monthly-week.ts`'s `MONTHLY_PAYMENT_METHOD`, repeated here because
 *  that module reads the database and this one must not;
 *  fee-waiver-rules.test.ts pins that the two agree. */
const MONTHLY_PAYMENT_METHOD = "monthly";

import { formatLondon } from "./london-time";
import { selectRegistrationMatch } from "./registration-match-select";

/** The one reason in use today. The column is a free-text code. */
export const FEE_WAIVER_REASON_ORGANISER = "organiser";

export function isFeeWaived(a: { feeWaivedAt: Date | null }): boolean {
  return a.feeWaivedAt != null;
}

interface FeeRow {
  status?: string;
  paidAt?: Date | null;
  feeWaivedAt: Date | null;
  paymentMethod?: string | null;
}

/** Owes this match's fee right now: not the collector, not a monthly
 *  regular, not paid, not on a free place. */
export function owesMatchFee(a: FeeRow & { userId: string }, collectorId: string | null): boolean {
  if (collectorId && a.userId === collectorId) return false;
  if (a.paymentMethod === MONTHLY_PAYMENT_METHOD) return false;
  if (a.paidAt) return false;
  return !isFeeWaived(a);
}

export type WaiveDecision = "waive" | "already-free" | "already-paid" | "monthly" | "not-in-squad";

/** May this attendance be made free? The write itself repeats the
 *  conditions in its WHERE (`fee-waiver.ts`), so a race cannot get past
 *  them; this is what the reply says. */
export function decideWaive(a: FeeRow | null): WaiveDecision {
  if (!a || a.status === "DROPPED") return "not-in-squad";
  if (a.paidAt) return "already-paid";
  if (isFeeWaived(a)) return "already-free";
  if (a.paymentMethod === MONTHLY_PAYMENT_METHOD) return "monthly";
  return "waive";
}

/** The latest game of the last 48 hours is the fallback when nothing is
 *  today and nothing is ahead (the end of a season). */
export const FEE_WAIVER_RECENT_MS = 48 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const londonKey = (d: Date): string => formatLondon(d, "yyyy-MM-dd");
const addDays = (key: string, n: number): string => new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** ISO weekday of a "yyyy-MM-dd" key: 1 = Monday .. 7 = Sunday. */
const isoDow = (key: string): number => {
  const d = new Date(`${key}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

/** Weekday words, Monday first. Longest first within a language where one
 *  is the start of another (cumartesi / cuma, pazartesi / pazar). */
const WEEKDAYS: Array<[number, string[]]> = [
  [1, ["monday", "mon", "pazartesi"]],
  [2, ["tuesday", "tues", "tue", "salı", "sali"]],
  [3, ["wednesday", "wed", "çarşamba", "carsamba"]],
  [4, ["thursday", "thurs", "thur", "thu", "perşembe", "persembe"]],
  [6, ["saturday", "sat", "cumartesi"]],
  [5, ["friday", "fri", "cuma"]],
  [7, ["sunday", "sun", "pazar"]],
];

export type DayHint =
  | { kind: "offset"; days: number }
  | { kind: "weekday"; dow: number; dir: "near" | "next" | "last" }
  | { kind: "next-week" };

/**
 * The day an organiser named for the game ("tonight", "next Friday",
 * "dün", "cuma"), read from the admin extractor's `matchDay` (the words,
 * verbatim). A small stated vocabulary, English and Turkish, like
 * `resolveReminderPhrase`: anything else, "this week" included, is null and
 * the default game is used. The confirm question names the date either way.
 */
export function readDayHint(phrase: string | null | undefined): DayHint | null {
  const raw = (phrase ?? "").trim();
  if (!raw) return null;
  // Both lower-casings: Turkish turns "FRIDAY" into "frıday".
  const words = [raw.toLowerCase(), raw.toLocaleLowerCase("tr")].flatMap((s) => s.split(/[^\p{L}]+/u)).filter(Boolean);
  const has = (...w: string[]) => w.some((x) => words.includes(x));
  for (const [dow, names] of WEEKDAYS) {
    if (words.some((w) => names.some((n) => (n.length <= 4 ? w === n : w.startsWith(n))))) {
      const dir = has("next", "gelecek", "önümüzdeki", "haftaya") ? "next" : has("last", "geçen") ? "last" : "near";
      return { kind: "weekday", dow, dir };
    }
  }
  if ((has("next") && has("week")) || has("haftaya") || ((has("gelecek") || has("önümüzdeki")) && has("hafta"))) return { kind: "next-week" };
  if (has("yesterday", "dün") || (has("last") && has("night"))) return { kind: "offset", days: -1 };
  if (has("tomorrow", "yarın", "yarin")) return { kind: "offset", days: 1 };
  if (has("today", "tonight", "bugün", "bugun") || (has("this") && has("evening")) || (has("bu") && (has("akşam") || has("gece")))) {
    return { kind: "offset", days: 0 };
  }
  return null;
}

/**
 * Which game a free place is for, from the club's games:
 *
 *   - the organiser named a day (`dayPhrase`, read by `readDayHint`): the
 *     game on that day, or NONE (the reply says there is no game then;
 *     never a different game);
 *   - otherwise a game today, kicked off or not;
 *   - otherwise the club's registration match, the one every HQ squad
 *     command lands on (`selectRegistrationMatch`), so two games a week
 *     pick the next game, not the one just played;
 *   - otherwise (nothing ahead) the latest game of the last 48 hours.
 *
 * Cancelled games are never picked. Nothing is written on this choice:
 * MatchTime asks "Make Bilal free for Fri 16 Oct? Reply YES" first.
 */
export function pickWaiverMatch<T extends { id: string; date: Date; status: string }>(
  all: readonly T[],
  now: Date,
  dayPhrase?: string | null,
): T | null {
  const matches = all.filter((m) => m.status !== "CANCELLED").sort((a, b) => a.date.getTime() - b.date.getTime());
  const today = londonKey(now);
  const on = (key: string) => matches.find((m) => londonKey(m.date) === key) ?? null;
  const hint = readDayHint(dayPhrase);
  if (hint?.kind === "offset") return on(addDays(today, hint.days));
  if (hint?.kind === "next-week") {
    const monday = addDays(today, 8 - isoDow(today));
    return matches.find((m) => londonKey(m.date) >= monday) ?? null;
  }
  if (hint?.kind === "weekday") {
    const back = (isoDow(today) - hint.dow + 7) % 7; // 0 = today
    const ahead = back === 0 ? 7 : 7 - back;
    const behind = hint.dir === "last" && back === 0 ? 7 : back;
    const past = hint.dir === "next" ? null : on(addDays(today, -behind));
    const next = hint.dir === "last" ? null : on(addDays(today, ahead));
    if (past && next) return behind <= ahead ? past : next;
    return past ?? next;
  }
  const todays = matches.filter((m) => londonKey(m.date) === today);
  if (todays.length) return todays.reduce((a, b) => (Math.abs(b.date.getTime() - now.getTime()) < Math.abs(a.date.getTime() - now.getTime()) ? b : a));
  const reg = selectRegistrationMatch<T>([...matches], now);
  if (reg) return reg;
  const t = now.getTime();
  const recent = matches.filter((m) => m.date.getTime() <= t && t - m.date.getTime() <= FEE_WAIVER_RECENT_MS);
  return recent[recent.length - 1] ?? null;
}

/** The HQ outcome when a free place was asked for and none was given
 *  (already paid, not in the squad, no match): an answer, but nothing
 *  done, so no ✅ tick (admin-group.ts). */
export const HQ_FEE_FREE_NOTHING_DONE = "hq-fee-free-none";

/** A free place question too old for its YES: answered, nothing done, no tick. */
export const HQ_FEE_FREE_EXPIRED = "fee-free-expired";

/** How long a free place question waits for its YES, as a pasted list's. */
export const FEE_PROPOSAL_TTL_MS = 30 * 60 * 1000;

/** The safe-YES rule's ref for a free place question (`admin-group-log.ts`). */
export const feeAskRef = (proposalId: string): string => `fee:${proposalId}`;
export const parseFeeAskRef = (ref: string): string | null => (ref.startsWith("fee:") ? ref.slice(4) : null);

export type CollectRowState = "paid" | "free" | "direct" | "unpaid";

/** How a row reads on /collect/<matchId>. */
export function collectRowState(a: FeeRow, directPending: boolean): CollectRowState {
  if (a.paidAt) return "paid";
  if (isFeeWaived(a)) return "free";
  return directPending ? "direct" : "unpaid";
}

/**
 * The number the collector's fee question uses (the N in "N played" and
 * the divisor of a total to split), and how many free places it left out.
 * CONFIRMED rows only, without the collector and monthly regulars. A paid
 * row still counts: that player paid this fee.
 */
export function feeHeadcount(
  rows: ReadonlyArray<FeeRow & { userId: string }>,
  collectorId: string | null,
): { headcount: number; freeCount: number } {
  let headcount = 0;
  let freeCount = 0;
  for (const a of rows) {
    if (a.status !== undefined && a.status !== "CONFIRMED") continue;
    if (collectorId && a.userId === collectorId) continue;
    if (a.paymentMethod === MONTHLY_PAYMENT_METHOD) continue;
    if (isFeeWaived(a) && !a.paidAt) freeCount++;
    else headcount++;
  }
  return { headcount, freeCount };
}
