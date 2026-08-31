/**
 * Money-path decisions (2026-08-31) — PURE. No Stripe, no DB, no Prisma,
 * so it is unit-testable in isolation (src/lib/__tests__/payment-outcome.test.ts).
 *
 * Two decisions live here because both, when wrong, move real money:
 *
 *   decideCheckoutEvent — does this Stripe Checkout webhook event mean
 *     the player actually paid?
 *   payBlockedReason    — may this player start a payment at all?
 *
 * Background on why the first one matters: **Pay by Bank is a
 * delayed-notification payment method**. Stripe fires
 * `checkout.session.completed` as soon as the player finishes the hosted
 * flow, with `payment_status: "unpaid"` — the bank debit has NOT settled.
 * Settlement arrives later as `checkout.session.async_payment_succeeded`,
 * or the debit fails and Stripe sends
 * `checkout.session.async_payment_failed`. Treating "completed" as "paid"
 * therefore marks failed bank payments as settled: the player is told
 * they're square, the chaser stops, and the collector never sees the
 * money. Card sessions complete with `payment_status: "paid"` in the same
 * event, which is why the bug is invisible on card.
 */

/** What the webhook should do with a Checkout Session event. */
export type CheckoutDecision =
  /** The money is genuinely with the collector — mark the player paid. */
  | "mark-paid"
  /** Session finished but the money has NOT settled yet (bank debit in
   *  flight, or an unknown payment_status). Record the session, leave the
   *  player unpaid so the normal chaser keeps them on the list. */
  | "await-settlement"
  /** The payment failed after the fact — undo any paid mark this exact
   *  session created. */
  | "reverse-unpaid"
  /** Not our business. */
  | "ignore";

/** Checkout Session `payment_status` values that mean the money is in.
 *  `no_payment_required` is Stripe's zero-amount case. */
const SETTLED = new Set(["paid", "no_payment_required"]);

/**
 * Decide from the event type + the session's `payment_status`.
 *
 * Deliberately conservative: anything that is not a recognised "settled"
 * status is `await-settlement`, never `mark-paid`. Being late to mark a
 * payment is recoverable (the chaser re-nudges, the collector can mark it
 * received); wrongly marking an unsettled payment as paid is not.
 *
 * Ordering-safe: only a settled status ever sets `paidAt`, so a late
 * `checkout.session.completed` arriving AFTER its
 * `async_payment_succeeded` sibling cannot un-pay anybody, and duplicate
 * deliveries of the same event repeat the same decision.
 */
export function decideCheckoutEvent(
  eventType: string,
  paymentStatus: string | null | undefined,
): CheckoutDecision {
  switch (eventType) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return paymentStatus && SETTLED.has(paymentStatus) ? "mark-paid" : "await-settlement";
    case "checkout.session.async_payment_failed":
      // The event type is decisive: Stripe only sends this when the
      // delayed debit failed.
      return "reverse-unpaid";
    default:
      // checkout.session.expired: nothing was ever marked, nothing to undo.
      return "ignore";
  }
}

export interface PayGuardInput {
  /** Attendance.paidAt — non-null means this player is already settled. */
  paidAt: Date | null;
  /** Attendance.status — CONFIRMED | BENCH | DROPPED. */
  attendanceStatus: string;
  /** Match.status — UPCOMING | TEAMS_GENERATED | TEAMS_PUBLISHED | COMPLETED | CANCELLED. */
  matchStatus: string;
}

/**
 * Why this player may NOT start a payment right now — a short, human
 * sentence to show them — or null when they may.
 *
 * NOT blocked on `COMPLETED`: the entire fee flow runs after the match is
 * played, so blocking completed matches would break every payment. The
 * "this is over" case we DO block is a cancelled match.
 *
 * The pay LINK is a permanent magic link (see releaseMatchPayments), so
 * these guards are the only thing standing between an old WhatsApp
 * message and a second charge.
 */
export function payBlockedReason(input: PayGuardInput): string | null {
  if (input.paidAt) {
    return "You're already paid for this match — nothing more to do. Thanks!";
  }
  if (input.matchStatus === "CANCELLED") {
    return "That match was cancelled, so there's nothing to pay.";
  }
  if (input.attendanceStatus === "DROPPED") {
    return "You dropped out of this match, so there's no fee for you. Speak to the organiser if that's not right.";
  }
  return null;
}
