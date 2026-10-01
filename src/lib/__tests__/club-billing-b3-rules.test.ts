/**
 * CLUB FEE BILLING, slice B3: the pure rules the Stripe half reads.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.2, 5.2 to 5.4,
 * decision 3 (the 49 hour Checkout trial rule) and the B2 review gap
 * (Free, then back to Standard after the free month was used).
 *
 * No database, no Stripe, no clock: every rule takes `now` and `env`.
 */
import { describe, expect, it } from "vitest";
import {
  CHECKOUT_TRIAL_MIN_HOURS,
  checkoutTrialEnd,
  isLiveSubscriptionStatus,
  nextBillingState,
  subscriptionStateEvent,
  vatCountryNeedsCheck,
  type BillingClub,
} from "../club-billing-rules";

const ON = { BILLING_ENABLED: "1" };
const OFF = {};
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const APPROVED = new Date("2026-10-01T09:00:00Z");
const TRIAL_ENDS = new Date(APPROVED.getTime() + 30 * DAY);

describe("checkoutTrialEnd (decision 3): max(trialEndsAt, now + 49h)", () => {
  it("is 49 hours, one more than Stripe's 48 hour minimum", () => {
    expect(CHECKOUT_TRIAL_MIN_HOURS).toBe(49);
  });

  it("day 21: the free month's own end", () => {
    const now = new Date(APPROVED.getTime() + 21 * DAY);
    expect(checkoutTrialEnd(TRIAL_ENDS, now)).toEqual(TRIAL_ENDS);
  });

  it("day 28 with exactly 48 hours left: pushed to now + 49h (one extra free hour, never early)", () => {
    const now = new Date(TRIAL_ENDS.getTime() - 48 * HOUR);
    expect(checkoutTrialEnd(TRIAL_ENDS, now)).toEqual(new Date(now.getTime() + 49 * HOUR));
  });

  it("day 28 with 50 hours left: the free month's own end", () => {
    const now = new Date(TRIAL_ENDS.getTime() - 50 * HOUR);
    expect(checkoutTrialEnd(TRIAL_ENDS, now)).toEqual(TRIAL_ENDS);
  });

  it("day 29: pushed to now + 49h", () => {
    const now = new Date(TRIAL_ENDS.getTime() - 24 * HOUR);
    expect(checkoutTrialEnd(TRIAL_ENDS, now)).toEqual(new Date(now.getTime() + 49 * HOUR));
  });

  it("day 30, a minute before the end: pushed to now + 49h", () => {
    const now = new Date(TRIAL_ENDS.getTime() - 60_000);
    expect(checkoutTrialEnd(TRIAL_ENDS, now)).toEqual(new Date(now.getTime() + 49 * HOUR));
  });
});

describe("Free, then back to Standard or Custom (the B2 gap): the 'plan-billed' event", () => {
  const club = (over: Partial<BillingClub> = {}): BillingClub => ({
    approvedAt: APPROVED,
    billingStatus: "exempt",
    billingPlan: "standard",
    billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: null, pausedReason: null },
    ...over,
  });

  it("free month used up: to grace with a FRESH 7 day grace from now", () => {
    const now = new Date(TRIAL_ENDS.getTime() + 20 * DAY);
    const t = nextBillingState(club(), { type: "plan-billed" }, now, ON);
    expect(t).toMatchObject({ to: "grace", pausedReason: null, createsBilling: false, resumes: false });
    expect(t?.graceEndsAt).toEqual(new Date(now.getTime() + 7 * DAY));
  });

  it("an old grace end on the row is never reused: the grace is always 7 days from now", () => {
    const now = new Date(TRIAL_ENDS.getTime() + 60 * DAY);
    const t = nextBillingState(
      club({ billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: new Date(TRIAL_ENDS.getTime() + 7 * DAY), pausedReason: null } }),
      { type: "plan-billed" },
      now,
      ON,
    );
    expect(t?.graceEndsAt).toEqual(new Date(now.getTime() + 7 * DAY));
  });

  it("still inside the free month (Free was set mid trial): back to trial, the original end kept", () => {
    const now = new Date(APPROVED.getTime() + 10 * DAY);
    const t = nextBillingState(club(), { type: "plan-billed" }, now, ON);
    expect(t).toMatchObject({ to: "trial", createsBilling: false });
    expect(t?.graceEndsAt).toBeUndefined();
  });

  it("never trialled (no ClubBilling row): stays exempt, 'Start free month' is the way in", () => {
    expect(nextBillingState(club({ billing: null }), { type: "plan-billed" }, APPROVED, ON)).toBeNull();
  });

  it("flag off: nothing changes", () => {
    const now = new Date(TRIAL_ENDS.getTime() + 20 * DAY);
    expect(nextBillingState(club(), { type: "plan-billed" }, now, OFF)).toBeNull();
  });

  it("plan still Free: nothing changes", () => {
    const now = new Date(TRIAL_ENDS.getTime() + 20 * DAY);
    expect(nextBillingState(club({ billingPlan: "free" }), { type: "plan-billed" }, now, ON)).toBeNull();
  });

  it("a club already billed: nothing changes", () => {
    const now = new Date(TRIAL_ENDS.getTime() + 20 * DAY);
    for (const s of ["trial", "grace", "subscribed", "past_due", "paused"]) {
      expect(nextBillingState(club({ billingStatus: s }), { type: "plan-billed" }, now, ON), s).toBeNull();
    }
  });

  it("Sutton FC's shape (approvedAt NULL): never", () => {
    const now = new Date(TRIAL_ENDS.getTime() + 20 * DAY);
    expect(nextBillingState(club({ approvedAt: null }), { type: "plan-billed" }, now, ON)).toBeNull();
  });
});

describe("isLiveSubscriptionStatus: a subscription that still charges or may charge", () => {
  it.each(["trialing", "active", "past_due", "unpaid", "incomplete", "paused"])("%s is live", (s) => {
    expect(isLiveSubscriptionStatus(s)).toBe(true);
  });
  it.each(["canceled", "incomplete_expired", null, undefined, ""])("%s is not", (s) => {
    expect(isLiveSubscriptionStatus(s as string | null)).toBe(false);
  });
});

describe("subscriptionStateEvent: Stripe's latest truth to one billing event (5.3)", () => {
  const ev = (status: string, clubStatus: string, extra: { cancelAtPeriodEnd?: boolean; pausedReason?: string | null } = {}) =>
    subscriptionStateEvent({ status, cancelAtPeriodEnd: extra.cancelAtPeriodEnd ?? false }, { status: clubStatus, pausedReason: extra.pausedReason ?? null });

  it("trialing or active on a club with no card yet: card-added", () => {
    for (const s of ["trialing", "active"]) {
      expect(ev(s, "trial")).toEqual({ type: "card-added" });
      expect(ev(s, "grace")).toEqual({ type: "card-added" });
    }
  });

  it("active on a paused club: card-added (resume), unless the pause is a removal from the group", () => {
    expect(ev("active", "paused", { pausedReason: "payment-failed" })).toEqual({ type: "card-added" });
    expect(ev("active", "paused", { pausedReason: "no-card" })).toEqual({ type: "card-added" });
    expect(ev("active", "paused", { pausedReason: "removed", cancelAtPeriodEnd: true })).toBeNull();
  });

  it("active on a past due club: invoice-paid", () => {
    expect(ev("active", "past_due")).toEqual({ type: "invoice-paid" });
  });

  it("active on a subscribed club: nothing", () => {
    expect(ev("active", "subscribed")).toBeNull();
  });

  it("past_due on a subscribed club: payment-failed", () => {
    expect(ev("past_due", "subscribed")).toEqual({ type: "payment-failed" });
    expect(ev("past_due", "past_due")).toBeNull();
  });

  it("unpaid: Stripe gave up", () => {
    expect(ev("unpaid", "past_due")).toEqual({ type: "subscription-unpaid" });
    expect(ev("unpaid", "subscribed")).toEqual({ type: "payment-failed" });
  });

  it("canceled: the subscription ended, cancelled or failed", () => {
    expect(ev("canceled", "subscribed", { cancelAtPeriodEnd: true })).toEqual({ type: "subscription-ended", cancelAtPeriodEnd: true });
    expect(ev("canceled", "past_due")).toEqual({ type: "subscription-ended", cancelAtPeriodEnd: false });
  });

  it("an exempt club (Free, Sutton FC) never moves on Stripe's word", () => {
    for (const s of ["trialing", "active", "past_due", "unpaid", "canceled"]) expect(ev(s, "exempt"), s).toBeNull();
  });

  it("incomplete and paused subscriptions say nothing", () => {
    expect(ev("incomplete", "trial")).toBeNull();
    expect(ev("incomplete_expired", "trial")).toBeNull();
    expect(ev("paused", "subscribed")).toBeNull();
  });
});

describe("vatCountryNeedsCheck (5.4): UK only, flag rather than refuse", () => {
  it("both GB: no check", () => {
    expect(vatCountryNeedsCheck("GB", "GB")).toBe(false);
    expect(vatCountryNeedsCheck("gb", "GB")).toBe(false);
  });
  it("either not GB: check", () => {
    expect(vatCountryNeedsCheck("TR", "GB")).toBe(true);
    expect(vatCountryNeedsCheck("GB", "TR")).toBe(true);
    expect(vatCountryNeedsCheck("DE", "TR")).toBe(true);
  });
  it("either unknown: check (two pieces of evidence are needed)", () => {
    expect(vatCountryNeedsCheck(null, "GB")).toBe(true);
    expect(vatCountryNeedsCheck("GB", null)).toBe(true);
  });
});
