/**
 * CLUB FEE BILLING: the pure rules the Stripe half reads (slice B3, revised
 * for games played in slice P2).
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.2, 5.3, 5.4,
 * 6 and the B2 review gap (Free, then back to Standard after the free month
 * was used).
 *
 * No database, no Stripe, no clock: every rule takes `now` and `env`.
 * The 49 hour Checkout trial rule, the subscription status helpers and
 * `subscriptionStateEvent` retired with the subscription (P2, 5.5).
 */
import { describe, expect, it } from "vitest";
import * as rules from "../club-billing-rules";
import { nextBillingState, vatCountryNeedsCheck, type BillingClub } from "../club-billing-rules";
import {
  BILLED_EVENT_TYPE,
  BILLING_OFF_EVENT_TYPE,
  BILLING_ON_EVENT_TYPE,
  MONTH_CLOSE_DELAY_MS,
  PAUSED_EVENT_TYPE,
  RESUMED_EVENT_TYPE,
  UNBILLED_EVENT_TYPE,
  monthCloseDue,
  monthsToOpen,
  monthBounds,
  notChargedSpansFrom,
} from "../club-billing-cycle-rules";

const ON = { BILLING_ENABLED: "1" };
const OFF = {};
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const APPROVED = new Date("2026-10-01T09:00:00Z");
const TRIAL_ENDS = new Date(APPROVED.getTime() + 30 * DAY);

describe("slice P2: the subscription helpers are gone", () => {
  it("no checkoutTrialEnd, CHECKOUT_TRIAL_MIN_HOURS, isLiveSubscriptionStatus, isUnpaidSubscriptionStatus or subscriptionStateEvent", () => {
    for (const name of ["checkoutTrialEnd", "CHECKOUT_TRIAL_MIN_HOURS", "isLiveSubscriptionStatus", "isUnpaidSubscriptionStatus", "subscriptionStateEvent"]) {
      expect(name in rules, name).toBe(false);
    }
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

describe("Stop paying inside the free month goes back to trial (B3 review fix 7, kept for P2)", () => {
  const club = (status: string): BillingClub => ({
    approvedAt: APPROVED,
    billingStatus: status,
    billingPlan: "standard",
    billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: null, pausedReason: null },
  });

  it("stopped on day 10 (card removed): back to trial, the free month's end kept", () => {
    const now = new Date(APPROVED.getTime() + 10 * DAY);
    expect(nextBillingState(club("subscribed"), { type: "billing-stopped" }, now, ON)).toMatchObject({ to: "trial", pausedReason: null });
  });

  it("stopped after the free month (at the month close): paused (cancelled)", () => {
    const now = new Date(TRIAL_ENDS.getTime() + 31 * DAY);
    expect(nextBillingState(club("subscribed"), { type: "billing-stopped" }, now, ON)).toMatchObject({ to: "paused", pausedReason: "cancelled" });
  });
});

describe("slice P2: when a month closes and which months open (plan 6)", () => {
  it("the close waits 6 hours after the month ends", () => {
    expect(MONTH_CLOSE_DELAY_MS).toBe(6 * HOUR);
    const endsAt = new Date("2026-12-01T00:00:00Z");
    expect(monthCloseDue(endsAt, new Date(endsAt.getTime() + 6 * HOUR - 1))).toBe(false);
    expect(monthCloseDue(endsAt, new Date(endsAt.getTime() + 6 * HOUR))).toBe(true);
  });

  it("nothing opens inside the free month", () => {
    expect(monthsToOpen(TRIAL_ENDS, 0, new Date(TRIAL_ENDS.getTime() - 1))).toEqual([]);
  });

  it("month 1 opens at the free month's end, at any hour", () => {
    expect(monthsToOpen(TRIAL_ENDS, 0, TRIAL_ENDS)).toEqual([1]);
  });

  it("H1: ONLY the month containing now opens: no catch-up of months missed while the club was not billable or billing was off", () => {
    const at = new Date(monthBounds(TRIAL_ENDS, 4).startsAt.getTime() + HOUR);
    expect(monthsToOpen(TRIAL_ENDS, 0, at)).toEqual([4]);
    expect(monthsToOpen(TRIAL_ENDS, 1, at)).toEqual([4]);
    expect(monthsToOpen(TRIAL_ENDS, 4, at)).toEqual([]);
    expect(monthsToOpen(TRIAL_ENDS, 5, at)).toEqual([]);
  });

  it("Stop paying: no month that starts at or after the stop date", () => {
    const stopAt = monthBounds(TRIAL_ENDS, 2).endsAt;
    const at = new Date(monthBounds(TRIAL_ENDS, 4).startsAt.getTime() + HOUR);
    expect(monthsToOpen(TRIAL_ENDS, 2, at, { stopAt })).toEqual([]);
    expect(monthsToOpen(TRIAL_ENDS, 1, at, { stopAt })).toEqual([]);
    const inMonth2 = new Date(monthBounds(TRIAL_ENDS, 2).startsAt.getTime() + HOUR);
    expect(monthsToOpen(TRIAL_ENDS, 1, inMonth2, { stopAt })).toEqual([2]);
  });
});

describe("H1: spans in which games are never charged (pause, not billable, billing off)", () => {
  const at = (iso: string) => new Date(iso);
  it("each kind pairs its own start and end; an open start runs to now", () => {
    const spans = notChargedSpansFrom([
      { type: PAUSED_EVENT_TYPE, at: at("2026-11-02T00:00:00Z") },
      { type: RESUMED_EVENT_TYPE, at: at("2026-11-05T00:00:00Z") },
      { type: UNBILLED_EVENT_TYPE, at: at("2026-11-10T00:00:00Z") },
      { type: BILLED_EVENT_TYPE, at: at("2027-02-14T12:00:00Z") },
      { type: BILLING_OFF_EVENT_TYPE, at: at("2027-03-01T00:00:00Z") },
    ]);
    expect(spans).toEqual([
      { from: at("2026-11-02T00:00:00Z"), to: at("2026-11-05T00:00:00Z") },
      { from: at("2026-11-10T00:00:00Z"), to: at("2027-02-14T12:00:00Z") },
      { from: at("2027-03-01T00:00:00Z"), to: null },
    ]);
  });

  it("a billing-off marker does not end on a club's 'billed' marker, only on billing-on", () => {
    const spans = notChargedSpansFrom([
      { type: BILLING_OFF_EVENT_TYPE, at: at("2026-11-01T00:00:00Z") },
      { type: BILLED_EVENT_TYPE, at: at("2026-11-02T00:00:00Z") },
      { type: BILLING_ON_EVENT_TYPE, at: at("2026-11-20T00:00:00Z") },
    ]);
    expect(spans).toEqual([{ from: at("2026-11-01T00:00:00Z"), to: at("2026-11-20T00:00:00Z") }]);
  });
});

