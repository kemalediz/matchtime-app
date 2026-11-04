/**
 * WHAT THE DM QUESTION ANSWERER IS TOLD ABOUT A PLAYER'S OWN PAYMENTS, FOR A
 * CLUB WITH EXACTLY ONE PAYMENT FLAG ON, PINNED (club summary, slice B3).
 *
 * Written FIRST, on the code before B3, and green there. B3 makes every door
 * follow one rule for "payments are on" (`paymentMessagesOn`: tracking OR
 * collection, decision K2) and one rule for "a card can be taken"
 * (`isPaymentCollectionLive`). The DM answerer's YOUR PAYMENTS block already
 * followed the first rule (it read the two flags with an inline OR), and its
 * ways to pay come from `availablePayMethods`, which B3 moves onto the
 * second. So this block, which is model input (the dm-qa CONTEXT), must come
 * out byte-identical for both shapes. If it changes, B3 changed a prompt.
 */
import { describe, expect, it } from "vitest";
import { decideMyPayments, formatMyPaymentsBlock, type MyPaymentsOrg, type MyPaymentRow } from "../my-payments-rules";
import { decidePaymentSnapshot } from "../pipeline/payment-answer";

const BASE = {
  payMethodPayByBank: false,
  payMethodCard: true,
  payMethodDirect: true,
  stripeConnectAccountId: "acct_sutton",
  stripeChargesEnabled: true,
  paymentHolderId: "u-colin",
  paymentInstructions: "Cash to Colin on the night",
  squadMode: "weekly",
};
/** Sutton FC in production: collection on, tracking off. */
const COLLECTION_ONLY = { ...BASE, paymentTrackingEnabled: false, paymentCollectionEnabled: true } as MyPaymentsOrg;
/** An older club that still has the hidden poll on and collects nothing. */
const TRACKING_ONLY = { ...BASE, paymentTrackingEnabled: true, paymentCollectionEnabled: false } as MyPaymentsOrg;

const d = (s: string) => new Date(s);
const ROWS: MyPaymentRow[] = [
  { matchId: "m3", activityName: "Tuesday 7-a-side", date: d("2026-11-03T21:30:00Z"), fee: 6, paymentLinksReleasedAt: d("2026-11-03T23:00:00Z"), paidAt: null, feeWaivedAt: null, paymentMethod: null, directPendingAt: null },
  { matchId: "m2", activityName: "Tuesday 7-a-side", date: d("2026-10-27T21:30:00Z"), fee: null, paymentLinksReleasedAt: null, paidAt: null, feeWaivedAt: null, paymentMethod: null, directPendingAt: null },
  { matchId: "m1", activityName: "Tuesday 7-a-side", date: d("2026-10-20T21:30:00Z"), fee: 6, paymentLinksReleasedAt: d("2026-10-20T23:00:00Z"), paidAt: d("2026-10-21T09:00:00Z"), feeWaivedAt: null, paymentMethod: "card", directPendingAt: null },
];

function block(org: MyPaymentsOrg, lang: "en" | "tr") {
  const p = decideMyPayments({ userId: "u-amir", org, collectorName: "Colin Banks", upcomingFee: 6, rows: ROWS });
  return formatMyPaymentsBlock(p, lang, { m3: "https://mt/p/abc" });
}

describe("the YOUR PAYMENTS block for a club with one flag on", () => {
  it("collection only (Sutton FC), English", () => {
    expect(block(COLLECTION_ONLY, "en")).toMatchInlineSnapshot(`
      "YOUR PAYMENTS (this player's own; you know nothing about anyone else's payments):
      - Money collector: Colin Banks
      - Ways to pay: card, pay Colin Banks directly
      - The club's payment instructions (quote them exactly): Cash to Colin on the night
      - Usual match fee: £6 per player
      - Tuesday 7-a-side, Tue 3 Nov at 21:30: owes £6, not paid yet. Pay link: https://mt/p/abc
      - Tuesday 7-a-side, Tue 27 Oct at 21:30: no fee set yet. Nothing to pay for now.
      - Tuesday 7-a-side, Tue 20 Oct at 22:30: paid: payment received and recorded. Nothing to pay."
    `);
  });
  it("collection only (Sutton FC), Turkish dates", () => {
    expect(block(COLLECTION_ONLY, "tr")).toMatchInlineSnapshot(`
      "YOUR PAYMENTS (this player's own; you know nothing about anyone else's payments):
      - Money collector: Colin Banks
      - Ways to pay: card, pay Colin Banks directly
      - The club's payment instructions (quote them exactly): Cash to Colin on the night
      - Usual match fee: £6 per player
      - Tuesday 7-a-side, 3 Kasım Salı 21:30: owes £6, not paid yet. Pay link: https://mt/p/abc
      - Tuesday 7-a-side, 27 Ekim Salı 21:30: no fee set yet. Nothing to pay for now.
      - Tuesday 7-a-side, 20 Ekim Salı 22:30: paid: payment received and recorded. Nothing to pay."
    `);
  });
  it("tracking only, English", () => {
    expect(block(TRACKING_ONLY, "en")).toMatchInlineSnapshot(`
      "YOUR PAYMENTS (this player's own; you know nothing about anyone else's payments):
      - Money collector: Colin Banks
      - Tuesday 7-a-side, Tue 3 Nov at 21:30: not marked as paid in MatchTime. No amount on record.
      - Tuesday 7-a-side, Tue 27 Oct at 21:30: not marked as paid in MatchTime. No amount on record.
      - Tuesday 7-a-side, Tue 20 Oct at 22:30: paid: payment received and recorded. Nothing to pay."
    `);
  });
  it("both off: nothing tracked", () => {
    expect(block({ ...BASE, paymentTrackingEnabled: false, paymentCollectionEnabled: false } as MyPaymentsOrg, "en")).toMatchInlineSnapshot(`
      "YOUR PAYMENTS (this player's own; you know nothing about anyone else's payments):
      - This club does not run payments through MatchTime. For money questions, ask the organiser."
    `);
  });
});

describe("the group's 'who has not paid' answer for a club with one flag on", () => {
  const match = {
    kickoffLabel: "Tue 3 Nov",
    status: "COMPLETED" as const,
    isHistorical: false,
    paymentLinksReleasedAt: d("2026-11-03T23:00:00Z"),
    confirmed: [
      { userId: "u-colin", paid: false },
      { userId: "u-amir", paid: true },
      { userId: "u-sam", paid: false },
    ],
    creditCount: 0,
  };
  it("collection only, tracking only, both off", () => {
    const of = (t: boolean, c: boolean) => decidePaymentSnapshot({ paymentTracking: t, paymentCollection: c, paymentHolderId: "u-colin", match });
    expect([of(false, true), of(true, false), of(false, false)]).toMatchInlineSnapshot(`
      [
        {
          "chargeable": 2,
          "kickoffLabel": "Tue 3 Nov",
          "kind": "counted",
          "unpaid": 1,
        },
        {
          "chargeable": 2,
          "kickoffLabel": "Tue 3 Nov",
          "kind": "counted",
          "unpaid": 1,
        },
        {
          "kind": "not_tracked",
        },
      ]
    `);
  });
});
