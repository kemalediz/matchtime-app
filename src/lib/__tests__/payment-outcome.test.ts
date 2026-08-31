/**
 * Money-path decision logic (2026-08-31).
 *
 * These are the two decisions that, when wrong, cost a real club real
 * money:
 *
 *   1. `decideCheckoutEvent` — should a Stripe Checkout event mark a
 *      player PAID? Pay by Bank is a DELAYED-NOTIFICATION method:
 *      `checkout.session.completed` fires with `payment_status: "unpaid"`
 *      and the money either lands later
 *      (`checkout.session.async_payment_succeeded`) or FAILS
 *      (`checkout.session.async_payment_failed`). Marking paid on
 *      completion alone silently reads a failed bank debit as settled and
 *      leaves the collector out of pocket.
 *
 *   2. `payBlockedReason` — may this player start a payment at all?
 *      Guards double-charging, charging for a cancelled match, and
 *      charging someone who dropped out.
 *
 * Pure functions, no Stripe, no DB — the Stripe API is NEVER called in
 * tests.
 */
import { describe, it, expect } from "vitest";
import { decideCheckoutEvent, payBlockedReason } from "@/lib/payment-outcome";

describe("decideCheckoutEvent — only genuinely-settled money marks a player paid", () => {
  it("card checkout completes already paid → mark paid (the live happy path)", () => {
    expect(decideCheckoutEvent("checkout.session.completed", "paid")).toBe("mark-paid");
  });

  it("PAY BY BANK completes UNPAID → await settlement, never mark paid", () => {
    // The bug this file exists for: a bank debit that has not settled.
    expect(decideCheckoutEvent("checkout.session.completed", "unpaid")).toBe("await-settlement");
  });

  it("the async success event is what marks a bank payment paid", () => {
    expect(decideCheckoutEvent("checkout.session.async_payment_succeeded", "paid")).toBe("mark-paid");
  });

  it("an async success that is somehow still unpaid does NOT mark paid", () => {
    expect(decideCheckoutEvent("checkout.session.async_payment_succeeded", "unpaid")).toBe(
      "await-settlement",
    );
  });

  it("async_payment_failed reverses any paid mark for that session", () => {
    expect(decideCheckoutEvent("checkout.session.async_payment_failed", "unpaid")).toBe(
      "reverse-unpaid",
    );
    // Stripe sends the session as it stands; the event type is decisive.
    expect(decideCheckoutEvent("checkout.session.async_payment_failed", "paid")).toBe(
      "reverse-unpaid",
    );
  });

  it("a zero-amount session (no_payment_required) counts as settled", () => {
    expect(decideCheckoutEvent("checkout.session.completed", "no_payment_required")).toBe(
      "mark-paid",
    );
  });

  it("a missing/unknown payment_status is treated as NOT settled", () => {
    expect(decideCheckoutEvent("checkout.session.completed", null)).toBe("await-settlement");
    expect(decideCheckoutEvent("checkout.session.completed", undefined)).toBe("await-settlement");
    expect(decideCheckoutEvent("checkout.session.completed", "something_new")).toBe(
      "await-settlement",
    );
  });

  it("expired sessions and unrelated events are ignored", () => {
    expect(decideCheckoutEvent("checkout.session.expired", "unpaid")).toBe("ignore");
    expect(decideCheckoutEvent("payment_intent.succeeded", "paid")).toBe("ignore");
    expect(decideCheckoutEvent("charge.refunded", "paid")).toBe("ignore");
  });
});

describe("payBlockedReason — who may start a payment", () => {
  const ok = { paidAt: null, attendanceStatus: "CONFIRMED", matchStatus: "COMPLETED" } as const;

  it("a confirmed, unpaid player on a played match may pay", () => {
    expect(payBlockedReason(ok)).toBeNull();
  });

  it("a COMPLETED match is still payable — that is when fees are collected", () => {
    // Guards against over-blocking: the whole money flow runs post-match.
    expect(payBlockedReason({ ...ok, matchStatus: "COMPLETED" })).toBeNull();
    expect(payBlockedReason({ ...ok, matchStatus: "TEAMS_PUBLISHED" })).toBeNull();
    expect(payBlockedReason({ ...ok, matchStatus: "UPCOMING" })).toBeNull();
  });

  it("an already-paid player is blocked (no double charge)", () => {
    const reason = payBlockedReason({ ...ok, paidAt: new Date() });
    expect(reason).toBeTruthy();
    expect(reason!.toLowerCase()).toContain("already");
    // Human, not a stack trace.
    expect(reason).not.toMatch(/error|undefined|null/i);
  });

  it("a cancelled match is blocked", () => {
    const reason = payBlockedReason({ ...ok, matchStatus: "CANCELLED" });
    expect(reason).toBeTruthy();
    expect(reason!.toLowerCase()).toContain("cancelled");
  });

  it("a player who dropped out is blocked", () => {
    const reason = payBlockedReason({ ...ok, attendanceStatus: "DROPPED" });
    expect(reason).toBeTruthy();
    expect(reason!.toLowerCase()).toContain("dropped out");
  });

  it("a bench player is NOT blocked (they are still in the squad)", () => {
    expect(payBlockedReason({ ...ok, attendanceStatus: "BENCH" })).toBeNull();
  });

  it("already-paid wins over every other reason (clearest message)", () => {
    const reason = payBlockedReason({
      paidAt: new Date(),
      attendanceStatus: "DROPPED",
      matchStatus: "CANCELLED",
    });
    expect(reason!.toLowerCase()).toContain("already");
  });
});
