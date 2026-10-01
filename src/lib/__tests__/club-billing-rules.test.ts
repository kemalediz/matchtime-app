/**
 * CLUB FEE BILLING, slice B1: the pure rules.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 3, 4.1 to 4.5.
 *
 * No database, no clock: every function takes `now` and an `env`.
 *
 * The safety property above everything else: Sutton FC and every club
 * that predates self-join read `billingStatus = "exempt"` (the column
 * default), and an exempt club is never paused and never moved by any
 * event except the explicit trial starts, which need the flag on. With
 * BILLING_ENABLED off, NOBODY counts as paused, whatever the column says.
 */
import { describe, expect, it } from "vitest";
import {
  BILLING_LINK_TTL,
  BILLING_PLANS,
  BILLING_STATUSES,
  GRACE_DAYS,
  PAUSED_REASONS,
  TRIAL_DAYS,
  billingContact,
  billingQuietWhere,
  graceEndsFrom,
  isBillingEnabled,
  isBillingPaused,
  nextBillingState,
  trialWindow,
  type BillingClub,
  type BillingEventInput,
} from "@/lib/club-billing-rules";

const DAY = 24 * 60 * 60 * 1000;
const ON = { BILLING_ENABLED: "1" };
const OFF = {};
const APPROVED_AT = new Date("2026-10-01T09:00:00Z");
const TRIAL_ENDS = new Date(APPROVED_AT.getTime() + 30 * DAY);
const GRACE_ENDS = new Date(TRIAL_ENDS.getTime() + 7 * DAY);

const club = (over: Partial<BillingClub> = {}): BillingClub => ({
  approvedAt: APPROVED_AT,
  billingStatus: "trial",
  billingPlan: "standard",
  billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: null, pausedReason: null },
  ...over,
});
const exempt = (over: Partial<BillingClub> = {}): BillingClub =>
  club({ billingStatus: "exempt", billing: null, ...over });

describe("constants match the plan", () => {
  it("six states, three plans, four pause reasons", () => {
    expect([...BILLING_STATUSES]).toEqual(["exempt", "trial", "grace", "subscribed", "past_due", "paused"]);
    expect([...BILLING_PLANS]).toEqual(["standard", "free", "custom"]);
    expect([...PAUSED_REASONS]).toEqual(["no-card", "payment-failed", "cancelled", "removed"]);
  });
  it("30 day trial, 7 day grace, 9 day billing link", () => {
    expect(TRIAL_DAYS).toBe(30);
    expect(GRACE_DAYS).toBe(7);
    expect(BILLING_LINK_TTL).toBe(9 * 24 * 60 * 60);
  });
  it("trialWindow and graceEndsFrom", () => {
    expect(trialWindow(APPROVED_AT)).toEqual({ trialStartedAt: APPROVED_AT, trialEndsAt: TRIAL_ENDS });
    expect(graceEndsFrom(TRIAL_ENDS)).toEqual(GRACE_ENDS);
  });
});

describe("the kill switch: BILLING_ENABLED", () => {
  it("is off unless explicitly on", () => {
    expect(isBillingEnabled({})).toBe(false);
    expect(isBillingEnabled({ BILLING_ENABLED: "" })).toBe(false);
    expect(isBillingEnabled({ BILLING_ENABLED: "0" })).toBe(false);
    expect(isBillingEnabled({ BILLING_ENABLED: "false" })).toBe(false);
    expect(isBillingEnabled({ BILLING_ENABLED: "nope" })).toBe(false);
    for (const v of ["1", "true", "on", "yes", " ON "]) expect(isBillingEnabled({ BILLING_ENABLED: v })).toBe(true);
  });

  it("off: nobody counts as paused, whatever the column says", () => {
    expect(isBillingPaused({ billingStatus: "paused" }, OFF)).toBe(false);
    expect(isBillingPaused({ billingStatus: "paused" }, { BILLING_ENABLED: "0" })).toBe(false);
  });

  it("on: only billingStatus 'paused' is paused", () => {
    expect(isBillingPaused({ billingStatus: "paused" }, ON)).toBe(true);
    for (const s of BILLING_STATUSES.filter((x) => x !== "paused")) {
      expect(isBillingPaused({ billingStatus: s }, ON)).toBe(false);
    }
    // A row that did not select the column is not paused (never a reason to go quiet).
    expect(isBillingPaused({ billingStatus: null }, ON)).toBe(false);
    expect(isBillingPaused({ billingStatus: undefined }, ON)).toBe(false);
  });

  it("billingQuietWhere: an empty fragment when off (so queries are unchanged), a 'not paused' filter when on", () => {
    expect(billingQuietWhere(OFF)).toEqual({});
    expect(Object.keys(billingQuietWhere(OFF))).toHaveLength(0);
    expect(billingQuietWhere(ON)).toEqual({ billingStatus: { not: "paused" } });
  });
});

describe("Sutton FC and every pre-self-join club: exempt is never paused", () => {
  const events: BillingEventInput[] = [
    { type: "card-added" },
    { type: "trial-ended" },
    { type: "grace-ended" },
    { type: "payment-failed" },
    { type: "invoice-paid" },
    { type: "subscription-ended", cancelAtPeriodEnd: true },
    { type: "subscription-ended", cancelAtPeriodEnd: false },
    { type: "subscription-unpaid" },
    { type: "removed-from-group" },
    { type: "re-added" },
    { type: "re-added", subscription: "paying" },
    { type: "re-added", subscription: "unpaid" },
    { type: "plan-free" },
  ];
  for (const env of [ON, OFF]) {
    for (const e of events) {
      it(`${JSON.stringify(e)} with flag ${env === ON ? "on" : "off"} leaves an exempt club exempt`, () => {
        // Far in the future, so every date condition would be met.
        expect(nextBillingState(exempt(), e, new Date("2030-01-01T00:00:00Z"), env)).toBeNull();
      });
    }
  }
  it("an exempt club is not paused, flag on or off", () => {
    expect(isBillingPaused({ billingStatus: "exempt" }, ON)).toBe(false);
    expect(isBillingPaused({ billingStatus: "exempt" }, OFF)).toBe(false);
  });
  it("a club that predates self-join (approvedAt NULL, Sutton FC) never starts a free month, flag on", () => {
    const sutton = exempt({ approvedAt: null });
    expect(nextBillingState(sutton, { type: "approved" }, APPROVED_AT, ON)).toBeNull();
    expect(nextBillingState(sutton, { type: "start-trial" }, APPROVED_AT, ON)).toBeNull();
  });
  it("even a corrupted pre-self-join row (approvedAt NULL, not exempt) is never moved by any event", () => {
    for (const s of ["trial", "grace", "subscribed", "past_due", "paused"] as const) {
      const bad = club({ approvedAt: null, billingStatus: s, billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: GRACE_ENDS, pausedReason: "removed" } });
      for (const e of [...events, { type: "approved" } as const, { type: "start-trial" } as const]) {
        expect(nextBillingState(bad, e, new Date("2030-01-01T00:00:00Z"), ON)).toBeNull();
      }
    }
  });
  it("approval with the flag OFF leaves the club exempt (no trial starts)", () => {
    expect(nextBillingState(exempt(), { type: "approved" }, APPROVED_AT, OFF)).toBeNull();
    expect(nextBillingState(exempt(), { type: "start-trial" }, APPROVED_AT, OFF)).toBeNull();
  });
});

describe("4.2: starting the free month", () => {
  it("approval with the flag on: exempt to trial, creating the billing row", () => {
    expect(nextBillingState(exempt(), { type: "approved" }, APPROVED_AT, ON)).toEqual({
      to: "trial",
      pausedReason: null,
      createsBilling: true,
      resumes: false,
    });
  });
  it("Kemal's 'Start free month' does the same", () => {
    expect(nextBillingState(exempt(), { type: "start-trial" }, APPROVED_AT, ON)?.to).toBe("trial");
  });
  it("plan Free stays exempt", () => {
    expect(nextBillingState(exempt({ billingPlan: "free" }), { type: "approved" }, APPROVED_AT, ON)).toBeNull();
    expect(nextBillingState(exempt({ billingPlan: "free" }), { type: "start-trial" }, APPROVED_AT, ON)).toBeNull();
  });
  it("the free month happens once: a club with a billing row never gets another", () => {
    const hadTrial = exempt({ billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: null, pausedReason: null } });
    expect(nextBillingState(hadTrial, { type: "approved" }, APPROVED_AT, ON)).toBeNull();
    expect(nextBillingState(hadTrial, { type: "start-trial" }, APPROVED_AT, ON)).toBeNull();
  });
  it("re-approval of a club already billed changes nothing", () => {
    for (const s of ["trial", "grace", "subscribed", "past_due", "paused"] as const) {
      expect(nextBillingState(club({ billingStatus: s }), { type: "approved" }, APPROVED_AT, ON)).toBeNull();
    }
  });
});

describe("4.1 and 4.2: the calendar", () => {
  it("trial to grace at day 30, not before", () => {
    expect(nextBillingState(club(), { type: "trial-ended" }, new Date(TRIAL_ENDS.getTime() - 1), ON)).toBeNull();
    expect(nextBillingState(club(), { type: "trial-ended" }, TRIAL_ENDS, ON)).toEqual({
      to: "grace",
      pausedReason: null,
      createsBilling: false,
      resumes: false,
      graceEndsAt: GRACE_ENDS,
    });
  });
  it("grace to paused (no-card) at day 37, not before", () => {
    const g = club({ billingStatus: "grace", billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: GRACE_ENDS, pausedReason: null } });
    expect(nextBillingState(g, { type: "grace-ended" }, new Date(GRACE_ENDS.getTime() - 1), ON)).toBeNull();
    expect(nextBillingState(g, { type: "grace-ended" }, GRACE_ENDS, ON)).toMatchObject({ to: "paused", pausedReason: "no-card" });
  });
  it("grace-ended with no graceEndsAt does nothing (never pauses on a missing date)", () => {
    expect(nextBillingState(club({ billingStatus: "grace" }), { type: "grace-ended" }, new Date("2030-01-01"), ON)).toBeNull();
  });
  it("trial-ended only moves a club in trial", () => {
    for (const s of ["grace", "subscribed", "past_due", "paused"] as const) {
      expect(nextBillingState(club({ billingStatus: s }), { type: "trial-ended" }, GRACE_ENDS, ON)).toBeNull();
    }
  });
});

describe("4.2: cards and payments", () => {
  const NOW = new Date("2026-11-15T12:00:00Z");
  it("card added: trial, grace and paused to subscribed; only paused resumes", () => {
    expect(nextBillingState(club(), { type: "card-added" }, NOW, ON)).toMatchObject({ to: "subscribed", resumes: false });
    expect(nextBillingState(club({ billingStatus: "grace" }), { type: "card-added" }, NOW, ON)).toMatchObject({ to: "subscribed", resumes: false });
    expect(nextBillingState(club({ billingStatus: "paused" }), { type: "card-added" }, NOW, ON)).toMatchObject({ to: "subscribed", resumes: true, pausedReason: null });
  });
  it("payment failed: subscribed to past_due with seven days of grace", () => {
    expect(nextBillingState(club({ billingStatus: "subscribed" }), { type: "payment-failed" }, NOW, ON)).toEqual({
      to: "past_due",
      pausedReason: null,
      createsBilling: false,
      resumes: false,
      graceEndsAt: new Date(NOW.getTime() + 7 * DAY),
      paymentFailedAt: NOW,
    });
  });
  it("invoice paid: past_due and paused to subscribed", () => {
    expect(nextBillingState(club({ billingStatus: "past_due" }), { type: "invoice-paid" }, NOW, ON)).toMatchObject({ to: "subscribed", resumes: false });
    expect(nextBillingState(club({ billingStatus: "paused" }), { type: "invoice-paid" }, NOW, ON)).toMatchObject({ to: "subscribed", resumes: true });
  });
  it("past_due past its grace: paused (payment-failed)", () => {
    const pd = club({ billingStatus: "past_due", billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: NOW, pausedReason: null } });
    expect(nextBillingState(pd, { type: "grace-ended" }, NOW, ON)).toMatchObject({ to: "paused", pausedReason: "payment-failed" });
  });
  it("Stripe gives up: past_due to paused (payment-failed)", () => {
    expect(nextBillingState(club({ billingStatus: "past_due" }), { type: "subscription-unpaid" }, NOW, ON)).toMatchObject({ to: "paused", pausedReason: "payment-failed" });
  });
  it("subscription deleted: cancelled after a cancel, else payment-failed", () => {
    expect(nextBillingState(club({ billingStatus: "subscribed" }), { type: "subscription-ended", cancelAtPeriodEnd: true }, NOW, ON)).toMatchObject({ to: "paused", pausedReason: "cancelled" });
    expect(nextBillingState(club({ billingStatus: "past_due" }), { type: "subscription-ended", cancelAtPeriodEnd: false }, NOW, ON)).toMatchObject({ to: "paused", pausedReason: "payment-failed" });
  });
});

describe("4.2: removal, re-add and plan Free", () => {
  const NOW = new Date("2026-10-10T12:00:00Z");
  it("removed from the group: every billed live state to paused (removed)", () => {
    for (const s of ["trial", "grace", "subscribed", "past_due"] as const) {
      expect(nextBillingState(club({ billingStatus: s }), { type: "removed-from-group" }, NOW, ON)).toMatchObject({ to: "paused", pausedReason: "removed" });
    }
    expect(nextBillingState(club({ billingStatus: "paused" }), { type: "removed-from-group" }, NOW, ON)).toBeNull();
  });
  const removed = club({ billingStatus: "paused", billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: null, pausedReason: "removed" } });
  it("re-added before the trial end, no card: paused (removed) back to trial, resumed", () => {
    expect(nextBillingState(removed, { type: "re-added" }, NOW, ON)).toMatchObject({ to: "trial", resumes: true, pausedReason: null });
    expect(nextBillingState(removed, { type: "re-added", subscription: null }, NOW, ON)).toMatchObject({ to: "trial", resumes: true });
  });
  it("slice B5: re-added after the free month, no card: stays paused, now waiting for a card (no-card), not resumed", () => {
    expect(nextBillingState(removed, { type: "re-added" }, TRIAL_ENDS, ON)).toEqual({
      to: "paused",
      pausedReason: "no-card",
      createsBilling: false,
      resumes: false,
    });
  });
  it("slice B5: re-added while the subscription still pays (un-cancelled): subscribed, resumed, inside or after the free month", () => {
    expect(nextBillingState(removed, { type: "re-added", subscription: "paying" }, NOW, ON)).toMatchObject({ to: "subscribed", resumes: true });
    expect(nextBillingState(removed, { type: "re-added", subscription: "paying" }, TRIAL_ENDS, ON)).toMatchObject({ to: "subscribed", resumes: true });
  });
  it("slice B5: re-added with an UNPAID subscription: stays paused, waiting for the payment (payment-failed)", () => {
    expect(nextBillingState(removed, { type: "re-added", subscription: "unpaid" }, TRIAL_ENDS, ON)).toMatchObject({
      to: "paused",
      pausedReason: "payment-failed",
      resumes: false,
    });
  });
  it("re-added does nothing to a club paused for any other reason, or not paused", () => {
    for (const reason of ["no-card", "payment-failed", "cancelled"]) {
      const other = club({ billingStatus: "paused", billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: null, pausedReason: reason } });
      for (const sub of [undefined, null, "paying", "unpaid"] as const) {
        expect(nextBillingState(other, { type: "re-added", subscription: sub }, NOW, ON)).toBeNull();
      }
    }
    for (const s of ["trial", "grace", "subscribed", "past_due"] as const) {
      expect(nextBillingState(club({ billingStatus: s }), { type: "re-added", subscription: "paying" }, NOW, ON)).toBeNull();
    }
  });
  it("plan Free: any billed state to exempt, resuming a paused club", () => {
    for (const s of ["trial", "grace", "subscribed", "past_due"] as const) {
      expect(nextBillingState(club({ billingStatus: s }), { type: "plan-free" }, NOW, ON)).toMatchObject({ to: "exempt", resumes: false });
    }
    expect(nextBillingState(club({ billingStatus: "paused" }), { type: "plan-free" }, NOW, ON)).toMatchObject({ to: "exempt", resumes: true });
  });
  it("an unknown status in the column is never moved", () => {
    expect(nextBillingState(club({ billingStatus: "bogus" }), { type: "card-added" }, NOW, ON)).toBeNull();
  });
});

describe("4.5: billingContact", () => {
  const member = (userId: string, role: string, over: Partial<{ leftAt: Date | null; phoneNumber: string | null }> = {}) => ({
    userId,
    role,
    leftAt: null,
    phoneNumber: "+447700900001",
    ...over,
  });

  it("the money collector, when a current member with a phone", () => {
    expect(
      billingContact({ paymentHolderId: "elvin" }, [member("kemal", "OWNER"), member("elvin", "PLAYER")]),
    ).toEqual({ userId: "elvin", via: "collector" });
  });
  it("a collector who left falls back to the owner", () => {
    expect(
      billingContact({ paymentHolderId: "elvin" }, [member("kemal", "OWNER"), member("elvin", "PLAYER", { leftAt: new Date() })]),
    ).toEqual({ userId: "kemal", via: "owner" });
  });
  it("a collector with no phone falls back to the owner", () => {
    expect(
      billingContact({ paymentHolderId: "elvin" }, [member("kemal", "OWNER"), member("elvin", "PLAYER", { phoneNumber: null })]),
    ).toEqual({ userId: "kemal", via: "owner" });
  });
  it("a collector who is not a member at all falls back to the owner", () => {
    expect(billingContact({ paymentHolderId: "ghost" }, [member("kemal", "OWNER")])).toEqual({ userId: "kemal", via: "owner" });
  });
  it("no collector: the first current OWNER with a phone", () => {
    expect(
      billingContact({ paymentHolderId: null }, [
        member("admin", "ADMIN"),
        member("gone", "OWNER", { leftAt: new Date() }),
        member("nophone", "OWNER", { phoneNumber: null }),
        member("owner2", "OWNER"),
      ]),
    ).toEqual({ userId: "owner2", via: "owner" });
  });
  it("neither: nobody (no DM)", () => {
    expect(billingContact({ paymentHolderId: null }, [member("admin", "ADMIN")])).toBeNull();
    expect(billingContact({ paymentHolderId: null }, [])).toBeNull();
  });
  it("an empty phone string is no phone", () => {
    expect(billingContact({ paymentHolderId: "elvin" }, [member("elvin", "PLAYER", { phoneNumber: "  " })])).toBeNull();
  });
});

describe("RESUME_QUIET_LOOKBACK_DAYS covers every post-match window", () => {
  it("is at least the scheduler's post-match lookback and the unpaid-list window", async () => {
    const { RESUME_QUIET_LOOKBACK_DAYS } = await import("@/lib/club-billing-rules");
    const { POST_MATCH_LOOKBACK_DAYS, POST_MATCH_END_FLOW_MAX_AGE_DAYS } = await import("@/lib/bot-scheduler");
    const { UNPAID_FOLLOW_UP_RETRY_DAYS } = await import("@/lib/unpaid-rules");
    expect(RESUME_QUIET_LOOKBACK_DAYS).toBeGreaterThanOrEqual(POST_MATCH_LOOKBACK_DAYS);
    expect(RESUME_QUIET_LOOKBACK_DAYS).toBeGreaterThanOrEqual(POST_MATCH_END_FLOW_MAX_AGE_DAYS);
    // unpaid-list.ts looks back 2 + retry days + 1 of slack.
    expect(RESUME_QUIET_LOOKBACK_DAYS).toBeGreaterThanOrEqual(2 + UNPAID_FOLLOW_UP_RETRY_DAYS + 1);
  });
});
