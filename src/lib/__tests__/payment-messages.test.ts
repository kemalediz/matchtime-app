import { describe, expect, it } from "vitest";
import { isPaymentMessageKey, paymentMessagesOn, paymentMessagesOnFor } from "../payment-messages";

describe("paymentMessagesOn", () => {
  it("both off: nothing about payments (the Vets)", () => {
    expect(paymentMessagesOn({ paymentTrackingEnabled: false, paymentCollectionEnabled: false })).toBe(false);
    expect(paymentMessagesOn(null)).toBe(false);
    expect(paymentMessagesOn({})).toBe(false);
  });
  it("tracking on: on", () => {
    expect(paymentMessagesOn({ paymentTrackingEnabled: true, paymentCollectionEnabled: false })).toBe(true);
  });
  it("collection on implies tracking: on (Sutton FC, FNF)", () => {
    expect(paymentMessagesOn({ paymentTrackingEnabled: false, paymentCollectionEnabled: true })).toBe(true);
  });
  it("the scheduler's spelling", () => {
    expect(paymentMessagesOnFor({ paymentTracking: false, paymentCollection: false })).toBe(false);
    expect(paymentMessagesOnFor({ paymentTracking: false, paymentCollection: true })).toBe(true);
  });
});

describe("isPaymentMessageKey", () => {
  it.each([
    "org-vets:mpy:priced:month-nov:abc",
    "org-vets:mpy:group:month-nov:count",
    "org-vets:mpy:dm:month-nov:u1:r1",
    "m1:payment-poll",
    "m1:unpaid-group",
    "m1:fee-ask",
    "m1:fee-ask:again",
    "m1:pay-chase:u1:2026-11-04",
    "m1:pay-chase-collector:2026-11-04",
  ])("%s is a payment message", (key) => expect(isPaymentMessageKey(key)).toBe(true));
  it.each(["m1:announce-match", "m1:month-list:abc", "m1:cancel-nudge:u1", "m1:payg-pool-line:1:2", "m1:rate-u1"])(
    "%s is not",
    (key) => expect(isPaymentMessageKey(key)).toBe(false),
  );
});
