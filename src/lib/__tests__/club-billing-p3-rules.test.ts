/**
 * CLUB FEE BILLING, slice P3: the pure rules the hourly cron adds.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.2, 5.3, 6.
 *
 *   - the cron's own retries of a failed month's invoice: configurable
 *     (BILLING_CRON_RETRIES, default on), days 1, 3 and 5 after the first
 *     attempt, only the latest due day after an outage, never twice;
 *   - a month's DM (receipt, nothing to pay) is only sent while fresh;
 *   - Stop paying that comes due while a club is paused for a failed
 *     payment moves it to paused (cancelled), never back on first.
 */
import { describe, expect, it } from "vitest";
import { nextBillingState, type BillingClub } from "../club-billing-rules";
import {
  CRON_RETRY_DAYS,
  MONTH_DM_MAX_AGE_MS,
  cronRetriesEnabled,
  cronRetryDayDue,
  monthDmFresh,
} from "../club-billing-schedule-rules";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const FIRST = new Date("2026-12-01T10:00:00Z"); // the close's first attempt

describe("BILLING_CRON_RETRIES: OFF unless switched on (Stripe's own retries are the default, 2026-10-05)", () => {
  it("default off (unset or empty); on only for 1, true, on, yes (any case, spaces)", () => {
    expect(cronRetriesEnabled({})).toBe(false);
    expect(cronRetriesEnabled({ BILLING_CRON_RETRIES: "" })).toBe(false);
    expect(cronRetriesEnabled({ BILLING_CRON_RETRIES: "0" })).toBe(false);
    expect(cronRetriesEnabled({ BILLING_CRON_RETRIES: "maybe" })).toBe(false);
    for (const v of ["1", "true", "ON", " yes "]) expect(cronRetriesEnabled({ BILLING_CRON_RETRIES: v }), v).toBe(true);
  });
});

describe("cronRetryDayDue: days 1, 3 and 5 after the first attempt", () => {
  it("the schedule", () => {
    expect([...CRON_RETRY_DAYS]).toEqual([1, 3, 5]);
  });
  it("nothing before day 1; day 1 from 24 hours on; then 3, then 5; nothing after 5", () => {
    expect(cronRetryDayDue(FIRST, new Date(FIRST.getTime() + DAY - HOUR), [])).toBeNull();
    expect(cronRetryDayDue(FIRST, new Date(FIRST.getTime() + DAY), [])).toBe(1);
    expect(cronRetryDayDue(FIRST, new Date(FIRST.getTime() + 2 * DAY), [1])).toBeNull();
    expect(cronRetryDayDue(FIRST, new Date(FIRST.getTime() + 3 * DAY), [1])).toBe(3);
    expect(cronRetryDayDue(FIRST, new Date(FIRST.getTime() + 5 * DAY), [1, 3])).toBe(5);
    expect(cronRetryDayDue(FIRST, new Date(FIRST.getTime() + 9 * DAY), [1, 3, 5])).toBeNull();
  });
  it("once each: a day already tried is never tried again", () => {
    expect(cronRetryDayDue(FIRST, new Date(FIRST.getTime() + DAY + HOUR), [1])).toBeNull();
  });
  it("after an outage only the LATEST due day runs (never days 1 and 3 back to back), and no earlier day afterwards", () => {
    expect(cronRetryDayDue(FIRST, new Date(FIRST.getTime() + 4 * DAY), [])).toBe(3);
    expect(cronRetryDayDue(FIRST, new Date(FIRST.getTime() + 4 * DAY + HOUR), [3])).toBeNull();
    expect(cronRetryDayDue(FIRST, new Date(FIRST.getTime() + 6 * DAY), [])).toBe(5);
  });
});

describe("monthDmFresh: a month's DM goes only while the month was closed or paid in the last 3 days", () => {
  const now = new Date("2026-12-04T11:00:00Z");
  it("closed or paid within 3 days: fresh; both older: not", () => {
    expect(MONTH_DM_MAX_AGE_MS).toBe(3 * DAY);
    expect(monthDmFresh({ closedAt: new Date(now.getTime() - DAY), paidAt: null }, now)).toBe(true);
    expect(monthDmFresh({ closedAt: new Date(now.getTime() - 10 * DAY), paidAt: new Date(now.getTime() - HOUR) }, now)).toBe(true);
    expect(monthDmFresh({ closedAt: new Date(now.getTime() - 4 * DAY), paidAt: new Date(now.getTime() - 4 * DAY) }, now)).toBe(false);
    expect(monthDmFresh({ closedAt: null, paidAt: null }, now)).toBe(false);
  });
});

describe("nextBillingState: billing-stopped while paused for a failed payment (P2 review LOW 4)", () => {
  const club = (pausedReason: string): BillingClub => ({
    approvedAt: new Date("2026-10-02T14:00:00Z"),
    billingStatus: "paused",
    billingPlan: "standard",
    billing: { trialEndsAt: new Date("2026-11-01T14:00:00Z"), graceEndsAt: null, pausedReason },
  });
  const now = new Date("2026-12-10T12:00:00Z");
  it("paused (payment-failed): to paused (cancelled), NOT a resume", () => {
    expect(nextBillingState(club("payment-failed"), { type: "billing-stopped" }, now, { BILLING_ENABLED: "1" })).toMatchObject({
      to: "paused",
      pausedReason: "cancelled",
      resumes: false,
    });
  });
  it("any other pause: no change", () => {
    for (const r of ["no-card", "removed", "cancelled"]) {
      expect(nextBillingState(club(r), { type: "billing-stopped" }, now, { BILLING_ENABLED: "1" }), r).toBeNull();
    }
  });
});
