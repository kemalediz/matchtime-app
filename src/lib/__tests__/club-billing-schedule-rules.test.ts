/**
 * CLUB FEE BILLING, slice B4: when the scheduler acts (pure rules).
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.1 and 6.
 */
import { describe, expect, it } from "vitest";
import { formatLondon } from "../london-time";
import { freePeriodEnd, trialWindow } from "../club-billing-rules";
import { MESSAGE_HOURS_FROM_HOUR, MESSAGE_HOURS_TO_HOUR } from "../message-hours";
import {
  BILLING_DM_FROM_HOUR,
  BILLING_DM_TO_HOUR,
  PAUSED_DM_MAX_AGE_MS,
  billingDmSendAfter,
  billingDmsDue,
  billingTransitionDue,
  feeTipDue,
  isBillingDmHour,
  reminderAt,
  type ScheduleClub,
} from "../club-billing-schedule-rules";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const london = (d: Date) => formatLondon(d, "yyyy-MM-dd HH:mm");

function trialClub(approvedAt: Date, over: Partial<ScheduleClub> = {}): ScheduleClub {
  return { status: "trial", trialEndsAt: trialWindow(approvedAt).trialEndsAt, graceEndsAt: null, pausedAt: null, pausedReason: null, ...over };
}

describe("quiet hours: billing DMs only 09:00 to 23:00 London", () => {
  it("summer (BST): 08:59 no, 09:00 yes, 22:59 yes, 23:00 no", () => {
    expect(isBillingDmHour(new Date("2026-07-01T07:59:00Z"))).toBe(false);
    expect(isBillingDmHour(new Date("2026-07-01T08:00:00Z"))).toBe(true);
    expect(isBillingDmHour(new Date("2026-07-01T21:59:00Z"))).toBe(true);
    expect(isBillingDmHour(new Date("2026-07-01T22:00:00Z"))).toBe(false);
  });

  it("winter (GMT): 09:00 UTC is 09:00 London", () => {
    expect(isBillingDmHour(new Date("2026-12-01T08:59:00Z"))).toBe(false);
    expect(isBillingDmHour(new Date("2026-12-01T09:00:00Z"))).toBe(true);
    expect(isBillingDmHour(new Date("2026-12-01T22:59:00Z"))).toBe(true);
    expect(isBillingDmHour(new Date("2026-12-01T23:00:00Z"))).toBe(false);
    expect(isBillingDmHour(new Date("2026-12-02T00:00:00Z"))).toBe(false);
  });

  it("the billing hours ARE the shared message hours", () => {
    expect(BILLING_DM_FROM_HOUR).toBe(MESSAGE_HOURS_FROM_HOUR);
    expect(BILLING_DM_TO_HOUR).toBe(MESSAGE_HOURS_TO_HOUR);
  });

  it("sendAfter: none in the daytime, today's 09:00 before it, tomorrow's 09:00 from 23:00", () => {
    expect(billingDmSendAfter(new Date("2026-07-01T12:00:00Z"))).toBeNull();
    expect(billingDmSendAfter(new Date("2026-07-01T19:30:00Z"))).toBeNull();
    expect(billingDmSendAfter(new Date("2026-07-01T05:00:00Z"))!.toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(billingDmSendAfter(new Date("2026-07-01T22:00:00Z"))!.toISOString()).toBe("2026-07-02T08:00:00.000Z");
    expect(billingDmSendAfter(new Date("2026-07-01T22:59:00Z"))!.toISOString()).toBe("2026-07-02T08:00:00.000Z");
    // Across the October clock change: Saturday 23:00 BST, then Sunday 09:00 GMT.
    expect(billingDmSendAfter(new Date("2026-10-24T22:00:00Z"))!.toISOString()).toBe("2026-10-25T09:00:00.000Z");
  });
});

describe("day boundaries: the reminders fall at 09:00 London on the right calendar day", () => {
  const cases: Array<[string, string]> = [
    ["approved 10:00 London in October (the free period crosses the clock change)", "2026-10-01T09:00:00Z"],
    ["approved 23:30 London (late evening, BST)", "2026-09-10T22:30:00Z"],
    ["approved 00:15 London (just after midnight, BST)", "2026-09-09T23:15:00Z"],
    ["approved 23:30 London in March (GMT to BST inside the free period)", "2026-03-20T23:30:00Z"],
    ["approved 00:30 London in winter", "2026-12-01T00:30:00Z"],
  ];
  for (const [label, iso] of cases) {
    it(label, () => {
      const approved = new Date(iso);
      const { trialEndsAt } = trialWindow(approved);
      // Two London calendar months on, at the same London time of day.
      expect(trialEndsAt).toEqual(freePeriodEnd(approved));
      expect(formatLondon(trialEndsAt, "dd HH:mm:ss")).toBe(formatLondon(approved, "dd HH:mm:ss"));
      expect(Math.round((trialEndsAt.getTime() - approved.getTime()) / DAY)).toBeGreaterThanOrEqual(59);
      const endDate = formatLondon(trialEndsAt, "yyyy-MM-dd");
      const d21 = reminderAt(trialEndsAt, 9);
      const d28 = reminderAt(trialEndsAt, 2);
      expect(formatLondon(d21, "HH:mm")).toBe("09:00");
      expect(formatLondon(d28, "HH:mm")).toBe("09:00");
      const minusDays = (n: number) => {
        const [y, m, d] = endDate.split("-").map(Number);
        return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
      };
      expect(formatLondon(d21, "yyyy-MM-dd")).toBe(minusDays(9));
      expect(formatLondon(d28, "yyyy-MM-dd")).toBe(minusDays(2));
    });
  }

  it("the worked example: approved Mon 31 Aug 10:00 London, first reminder Thu 22 Oct 09:00 BST, second Thu 29 Oct 09:00 GMT, ends Sat 31 Oct 10:00", () => {
    const { trialEndsAt } = trialWindow(new Date("2026-08-31T09:00:00Z"));
    expect(london(trialEndsAt)).toBe("2026-10-31 10:00");
    expect(reminderAt(trialEndsAt, 9).toISOString()).toBe("2026-10-22T08:00:00.000Z");
    expect(reminderAt(trialEndsAt, 2).toISOString()).toBe("2026-10-29T09:00:00.000Z");
  });
});

describe("billingDmsDue: one DM per state, never two reminders in a row", () => {
  // Approved Mon 31 Aug 2026, 10:00 London: free until Sat 31 Oct, 10:00 London.
  const approved = new Date("2026-08-31T09:00:00Z");
  const club = trialClub(approved);
  const d21 = new Date("2026-10-22T08:00:00Z");
  const d28 = new Date("2026-10-29T09:00:00Z");

  it("nothing before day 21 at 09:00 London", () => {
    expect(billingDmsDue(club, new Date(d21.getTime() - 60_000), { trial21Delivered: false })).toEqual([]);
  });

  it("day 21 at 09:00 London: the day 21 DM, with the tip", () => {
    expect(billingDmsDue(club, d21, { trial21Delivered: false })).toEqual([
      { kind: "trial-21", cycleKey: club.trialEndsAt.toISOString(), withTip: true },
    ]);
  });

  it("day 21 at night: nothing yet (the 09:00 run sends it)", () => {
    expect(billingDmsDue(club, new Date("2026-10-22T22:00:00Z"), { trial21Delivered: false })).toEqual([]);
    // 22:00 London that evening is still daytime now.
    expect(billingDmsDue(club, new Date("2026-10-22T21:00:00Z"), { trial21Delivered: false })).toHaveLength(1);
  });

  it("day 28: the day 28 DM only, without the tip once day 21 reached the contact", () => {
    expect(billingDmsDue(club, d28, { trial21Delivered: true })).toEqual([
      { kind: "trial-28", cycleKey: club.trialEndsAt.toISOString(), withTip: false },
    ]);
  });

  it("a cron down from day 20 to day 29: day 21 is skipped, day 28 goes once and carries the tip", () => {
    const late = new Date("2026-10-30T12:00:00Z");
    expect(billingDmsDue(club, late, { trial21Delivered: false })).toEqual([
      { kind: "trial-28", cycleKey: club.trialEndsAt.toISOString(), withTip: true },
    ]);
  });

  it("no reminder once the free period has ended (the transition is due instead)", () => {
    const after = new Date(club.trialEndsAt.getTime() + HOUR);
    expect(billingDmsDue(club, after, { trial21Delivered: true })).toEqual([]);
    expect(billingTransitionDue(club, after)).toBe("trial-ended");
    expect(billingTransitionDue(club, new Date(club.trialEndsAt.getTime() - 1))).toBeNull();
  });

  it("grace after the free month: the day 30 DM in the daytime of the grace week", () => {
    const grace = { ...club, status: "grace", graceEndsAt: new Date(club.trialEndsAt.getTime() + 7 * DAY) };
    expect(billingDmsDue(grace, new Date("2026-10-31T12:00:00Z"), { trial21Delivered: true })).toEqual([
      { kind: "trial-ended", cycleKey: club.trialEndsAt.toISOString(), withTip: false },
    ]);
    // The trial ended at 10:00 on Sat 31 Oct: at night the state moves, the DM waits.
    expect(billingDmsDue(grace, new Date("2026-10-31T06:00:00Z"), { trial21Delivered: true })).toEqual([]);
  });

  it("grace from being billed again after Free (a fresh 7 days): no day 30 DM (it had its own)", () => {
    const now = new Date("2026-12-10T12:00:00Z");
    const grace = { ...club, status: "grace", graceEndsAt: new Date(now.getTime() + 7 * DAY) };
    expect(billingDmsDue(grace, now, { trial21Delivered: true })).toEqual([]);
  });

  it("grace ends: the transition is due, at any hour", () => {
    const grace = { ...club, status: "grace", graceEndsAt: new Date(club.trialEndsAt.getTime() + 7 * DAY) };
    expect(billingTransitionDue(grace, new Date(grace.graceEndsAt.getTime() + 1))).toBe("grace-ended");
    const pastDue = { ...club, status: "past_due", graceEndsAt: new Date("2026-12-01T03:00:00Z") };
    expect(billingTransitionDue(pastDue, new Date("2026-12-01T03:00:00Z"))).toBe("grace-ended");
    expect(billingTransitionDue({ ...club, status: "subscribed" }, new Date("2027-01-01T00:00:00Z"))).toBeNull();
  });

  it("paused: one DM keyed by the moment of the pause, for 3 days; never after removal from the group", () => {
    const pausedAt = new Date("2026-11-07T09:00:00Z");
    const paused = { ...club, status: "paused", pausedAt, pausedReason: "no-card" };
    const noon = new Date("2026-11-07T12:00:00Z");
    expect(billingDmsDue(paused, noon, { trial21Delivered: true })).toEqual([
      { kind: "paused", cycleKey: pausedAt.toISOString(), withTip: false },
    ]);
    expect(billingDmsDue(paused, new Date(pausedAt.getTime() + PAUSED_DM_MAX_AGE_MS + HOUR), { trial21Delivered: true })).toEqual([]);
    expect(billingDmsDue({ ...paused, pausedReason: "removed" }, noon, { trial21Delivered: true })).toEqual([]);
  });

  it("subscribed, past due and exempt clubs get no scheduled DM", () => {
    const noon = new Date("2026-10-22T12:00:00Z");
    for (const status of ["subscribed", "past_due", "exempt"]) {
      expect(billingDmsDue({ ...club, status }, noon, { trial21Delivered: false })).toEqual([]);
    }
  });
});

describe("feeTipDue: the admin channel's tip, once per free month, from day 21", () => {
  const club = trialClub(new Date("2026-08-31T09:00:00Z"));
  it("from day 21 at 09:00 London until the free month ends, in the daytime", () => {
    expect(feeTipDue(club, new Date("2026-10-22T07:59:00Z"))).toBeNull();
    expect(feeTipDue(club, new Date("2026-10-22T08:00:00Z"))).toEqual({ cycleKey: club.trialEndsAt.toISOString() });
    expect(feeTipDue(club, new Date("2026-10-30T12:00:00Z"))).toEqual({ cycleKey: club.trialEndsAt.toISOString() });
    expect(feeTipDue(club, new Date("2026-10-22T21:59:00Z"))).toEqual({ cycleKey: club.trialEndsAt.toISOString() });
    expect(feeTipDue(club, new Date("2026-10-22T22:00:00Z"))).toBeNull();
    expect(feeTipDue({ ...club, status: "grace" }, new Date("2026-10-31T12:00:00Z"))).toBeNull();
  });
});
