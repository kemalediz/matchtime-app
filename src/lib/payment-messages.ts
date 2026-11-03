/**
 * WHETHER MATCHTIME MAY SAY ANYTHING ABOUT PAYMENTS TO ANYONE IN A CLUB
 * (2026-11-03). Kemal: "once payment tracking is off for a club, there is
 * no need to DM anybody about payment reminders."
 *
 * The Vets preview (monthly, both flags off) showed a 10:00 DM to the
 * collector every day: "💷 13 say they've paid for November ... Reply
 * *PAID ALL*". The monthly money flow read neither flag.
 *
 * The two flags:
 *   - `paymentTrackingEnabled`: the poll, the unpaid reminders and lists;
 *   - `paymentCollectionEnabled`: fee asks, pay links and pay chases.
 * Collection implies tracking (a club taking money tracks who paid), so
 * payments are ON when either is on, and OFF only when both are off. With
 * them off nothing about payments is sent: no reminder, digest, chase,
 * price or pay-by ask, summary or "no need to pay" note. A player may
 * still SAY "paid"; where the design records that, it is recorded
 * silently.
 *
 * Each flag keeps its own narrower gate where it had one (the payment
 * poll still needs tracking; a pay chase still needs collection). This is
 * the outer gate every payment message also passes, and
 * `__tests__/payment-messages-guard.test.ts` makes a new payment message
 * that skips it fail.
 */

export const PAYMENT_FLAGS_SELECT = { paymentTrackingEnabled: true, paymentCollectionEnabled: true } as const;

export interface PaymentFlags {
  paymentTrackingEnabled?: boolean | null;
  paymentCollectionEnabled?: boolean | null;
}

/** True when the club tracks or collects payments; false sends nothing about them. */
export function paymentMessagesOn(org: PaymentFlags | null | undefined): boolean {
  return org?.paymentTrackingEnabled === true || org?.paymentCollectionEnabled === true;
}

/** The scheduler's `OrgFeatures` spelling of the same two flags. */
export function paymentMessagesOnFor(features: { paymentTracking?: boolean; paymentCollection?: boolean }): boolean {
  return paymentMessagesOn({ paymentTrackingEnabled: features.paymentTracking, paymentCollectionEnabled: features.paymentCollection });
}

/**
 * A scheduler instruction whose key is a payment message: the weekly
 * poll and unpaid reminders (`payment-`, `unpaid-`), the fee ask and pay
 * chases (`fee-ask`, `pay-chase`), and every monthly money post and DM
 * (`mpy:`, the priced list, the group's count, the pay reminders).
 */
export function isPaymentMessageKey(key: string): boolean {
  const seg = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
  return (
    seg.startsWith("mpy:") ||
    seg.startsWith("payment-") ||
    seg.startsWith("unpaid-") ||
    seg.startsWith("fee-ask") ||
    seg.startsWith("pay-chase")
  );
}
