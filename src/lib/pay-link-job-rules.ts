/**
 * A QUEUED PAY LINK GOES ONLY TO SOMEONE WHO STILL OWES, AT SEND TIME.
 * Pure rules: no database, no clock.
 *
 * Sutton, Tue 17 Nov 2026: the fee was confirmed at 23:01 UTC, inside the
 * club's quiet hours, so `releaseMatchPayments` queued every pay link as a
 * BotJob for 09:00. The collector marked 8 of those players paid on
 * /collect before midnight. Release had checked `paidAt` at 23:01 and
 * nothing looked again, so at 09:00 all 8 were told to pay a fee they had
 * already paid.
 *
 * So each pay-link BotJob carries what it is about (`BotJob.aboutKey`,
 * `<matchId>:pay-link:<userId>`) and the scheduler asks this rule again
 * just before it hands the job to the Pi (`pay-link-job.ts`). Checking at
 * send time, not at each place payment state changes, covers every path
 * that settles or cancels a debt, including ones added later.
 *
 * The exclusions are the release's own (collector, monthly regular, paid,
 * free place) plus what can only change after it: a direct payment chosen,
 * a drop, a fee withdrawn, a cancelled match. The daily chase reads the
 * same columns live at 18:00, so it needs no such check.
 */
import { MONTHLY_PAYMENT_METHOD, isFeeWaived } from "./fee-waiver-rules";

const SEGMENT = ":pay-link:";

export function payLinkAboutKey(matchId: string, userId: string): string {
  return `${matchId}${SEGMENT}${userId}`;
}

export function parsePayLinkAboutKey(key: string | null | undefined): { matchId: string; userId: string } | null {
  if (!key) return null;
  const at = key.indexOf(SEGMENT);
  if (at <= 0) return null;
  const matchId = key.slice(0, at);
  const userId = key.slice(at + SEGMENT.length);
  if (!userId || userId.includes(":")) return null;
  return { matchId, userId };
}

export type PayLinkNotOwedReason =
  | "paid"
  | "fee-waived"
  | "direct-pending"
  | "not-confirmed"
  | "monthly"
  | "collector"
  | "no-fee"
  | "match-cancelled";

export interface PayLinkAttendance {
  status: string;
  paidAt: Date | null;
  feeWaivedAt: Date | null;
  directPendingAt: Date | null;
  paymentMethod: string | null;
}

export interface PayLinkMatch {
  status: string;
  feePerPlayer: number | null;
  paymentLinksReleasedAt: Date | null;
  collectorId: string | null;
}

/** Why the player no longer owes for this match, or null when they still
 *  do and the link should go. Paid wins over every other reason, as on the
 *  payments page (fee-waiver-rules.ts). */
export function payLinkNotOwedReason(input: {
  userId: string;
  attendance: PayLinkAttendance | null;
  match: PayLinkMatch | null;
}): PayLinkNotOwedReason | null {
  const { userId, attendance: a, match: m } = input;
  if (a?.paidAt) return "paid";
  if (!m || m.feePerPlayer == null || m.paymentLinksReleasedAt == null) return "no-fee";
  if (m.status === "CANCELLED") return "match-cancelled";
  if (m.collectorId && m.collectorId === userId) return "collector";
  if (!a || a.status !== "CONFIRMED") return "not-confirmed";
  if (a.paymentMethod === MONTHLY_PAYMENT_METHOD) return "monthly";
  if (isFeeWaived(a)) return "fee-waived";
  if (a.directPendingAt) return "direct-pending";
  return null;
}
