/**
 * THE UNPAID RULE AND THE UNPAID FOLLOW-UP TIME, PURE (2026-10-01).
 *
 * `summariseUnpaid` is the computation the 17:00 unpaid tail has always
 * used (`buildUnpaidTail` in bot-scheduler.ts), lifted out unchanged so
 * the two follow-ups decided on 2026-10-01 use exactly the same rule:
 *
 *   U1  the admin unpaid list (MDs/friday-group-features-plan-2026-09-30.md,
 *       2.12), for clubs on "one-person" or "admin-group";
 *   the standalone group reminder for a club with a weekly rhythm, whose
 *       17:00 post (and so its tail) D4 switched off.
 *
 * Both fire at `unpaidFollowUpAt`: 10:00 London on the second calendar day
 * after the match's London date. Missed (the Pi was down), they retry at
 * 10:00 to 20:59 London on the following days, up to
 * `UNPAID_FOLLOW_UP_RETRY_DAYS` days in all, never in the evening or at
 * night. The window ends well inside the scheduler's lookback
 * (`POST_MATCH_LOOKBACK_DAYS`), pinned by unpaid-rules.test.ts.
 *
 * Pure: no database, no clock.
 */
import { formatLondon, londonDateTimeToUtc } from "./london-time";

export interface UnpaidAttendance {
  userId: string;
  paidAt: Date | null;
  name?: string | null;
}

export interface UnpaidSummary {
  /** CONFIRMED players who owe, the payment holder left out. */
  n: number;
  /** n minus the unpaid count (bulk credits count as paid). */
  paid: number;
  /** Players still owing, after bulk credits. Always at least 1. */
  unpaid: number;
  /** The players not individually marked paid, in the order given. */
  unpaidNames: Array<string | null>;
}

/**
 * Null when there is nothing honest to report:
 *   - everyone has paid (or bulk credits cover the rest);
 *   - NOBODY has paid and there is no credit: that more likely means the
 *     poll votes never reached us than that nobody paid, and "N unpaid"
 *     would be false precision.
 * The payment holder collects the money, so he is never counted.
 */
export function summariseUnpaid(args: {
  confirmed: UnpaidAttendance[];
  payerId: string | null;
  creditCount: number;
}): UnpaidSummary | null {
  const { payerId, creditCount } = args;
  const confirmed = payerId ? args.confirmed.filter((a) => a.userId !== payerId) : args.confirmed;
  const paidPeople = confirmed.filter((a) => a.paidAt != null).length;
  const unpaidRows = confirmed.filter((a) => a.paidAt == null);
  const unpaid = Math.max(0, unpaidRows.length - creditCount);
  if (paidPeople === 0 && creditCount === 0) return null;
  if (unpaid === 0) return null;
  return {
    n: confirmed.length,
    paid: confirmed.length - unpaid,
    unpaid,
    unpaidNames: unpaidRows.map((a) => a.name ?? null),
  };
}

/** Days, from the first try, on which a missed follow-up is retried. */
export const UNPAID_FOLLOW_UP_RETRY_DAYS = 3;
const FROM_HOUR = 10;
const TO_HOUR = 21;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 10:00 London on the second calendar day after the match's London date. */
export function unpaidFollowUpAt(matchDate: Date): Date {
  const [y, m, d] = formatLondon(matchDate, "yyyy-MM-dd").split("-").map(Number);
  const key = new Date(Date.UTC(y, m - 1, d + 2)).toISOString().slice(0, 10);
  return londonDateTimeToUtc(key, "10:00");
}

/** Due from 10:00 two days after, 10:00 to 20:59 London, for the retry days. */
export function unpaidFollowUpDue(now: Date, matchDate: Date): boolean {
  const at = unpaidFollowUpAt(matchDate);
  if (now.getTime() < at.getTime()) return false;
  if (now.getTime() >= at.getTime() + UNPAID_FOLLOW_UP_RETRY_DAYS * DAY_MS) return false;
  const hour = Number(formatLondon(now, "H"));
  return hour >= FROM_HOUR && hour < TO_HOUR;
}
