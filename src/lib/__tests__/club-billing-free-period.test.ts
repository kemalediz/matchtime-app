/**
 * CLUB FEE BILLING: the free period is TWO London calendar months
 * (Kemal, 2026-10-12; it was 30 days of 24 hours).
 *
 * One constant, `FREE_PERIOD_MONTHS`, and one function, `freePeriodEnd`,
 * decide the length. Everything else reads the stored `trialEndsAt` or
 * calls them: the billing trial (`trialWindow`), the AI allowance of a new
 * club (`aiAllowanceUsd`) and the copy (`i18n/free-period.ts`).
 *
 * The START is unchanged: `approvedAt` for an approval, `now` for the
 * platform owner's "Start free period".
 */
import { describe, expect, it } from "vitest";
import { formatLondon } from "../london-time";
import { FREE_PERIOD_MONTHS, freePeriodEnd, nextBillingState, trialWindow, type BillingClub } from "../club-billing-rules";
import { billingDmsDue, billingTransitionDue, feeTipDue, reminderAt, type ScheduleClub } from "../club-billing-schedule-rules";
import { monthBounds, monthIndexAt, monthsToOpen } from "../club-billing-cycle-rules";
import { DAILY_CAP_USD, NEW_CLUB_CAP_USD, aiAllowanceUsd, type AllowanceOrg } from "../ai-budget";
import { firstMonthsFree, firstMonthsFreeBadge, freePeriodLength } from "../i18n/free-period";
import { en } from "../i18n/strings.en";
import { tr } from "../i18n/strings.tr";

const ON = { BILLING_ENABLED: "1" };
const london = (d: Date) => formatLondon(d, "yyyy-MM-dd HH:mm:ss.SSS");
const end = (iso: string) => freePeriodEnd(new Date(iso));

describe("the one constant", () => {
  it("is two months", () => {
    expect(FREE_PERIOD_MONTHS).toBe(2);
  });

  it("trialWindow starts where it is told and ends two months on", () => {
    const start = new Date("2026-10-12T13:45:10.250Z");
    expect(trialWindow(start)).toEqual({ trialStartedAt: start, trialEndsAt: freePeriodEnd(start) });
    expect(trialWindow(start).trialStartedAt).toBe(start);
  });
});

describe("freePeriodEnd: London calendar months, the same London date and time", () => {
  it("a club approved today (Mon 12 Oct 2026, 14:45 BST) is free until Sat 12 Dec, 14:45 GMT", () => {
    const start = new Date("2026-10-12T13:45:10.250Z");
    expect(london(start)).toBe("2026-10-12 14:45:10.250");
    expect(london(freePeriodEnd(start))).toBe("2026-12-12 14:45:10.250");
    // The clocks go back inside the period, so it is 61 days and one hour.
    expect(freePeriodEnd(start).toISOString()).toBe("2026-12-12T14:45:10.250Z");
  });

  it("mid-month, no clock change inside: the same UTC time two months on", () => {
    expect(end("2026-11-05T19:30:00Z").toISOString()).toBe("2027-01-05T19:30:00.000Z");
    expect(end("2026-05-05T18:30:00Z").toISOString()).toBe("2026-07-05T18:30:00.000Z");
  });

  it("31 Aug ends 31 Oct (October has a 31st)", () => {
    // 12:00 BST on 31 Aug; 12:00 GMT on 31 Oct (the clocks went back on the 25th).
    expect(end("2026-08-31T11:00:00Z").toISOString()).toBe("2026-10-31T12:00:00.000Z");
  });

  it("31 Jul ends 30 Sept (clamped to the last day of a shorter month)", () => {
    expect(end("2026-07-31T11:00:00Z").toISOString()).toBe("2026-09-30T11:00:00.000Z");
  });

  it("29, 30 and 31 Dec all end on 28 Feb in a year that is not a leap year", () => {
    expect(end("2026-12-29T10:00:00Z").toISOString()).toBe("2027-02-28T10:00:00.000Z");
    expect(end("2026-12-30T10:00:00Z").toISOString()).toBe("2027-02-28T10:00:00.000Z");
    expect(end("2026-12-31T10:00:00Z").toISOString()).toBe("2027-02-28T10:00:00.000Z");
    // 28 Dec is not clamped.
    expect(end("2026-12-28T10:00:00Z").toISOString()).toBe("2027-02-28T10:00:00.000Z");
    expect(end("2026-12-27T10:00:00Z").toISOString()).toBe("2027-02-27T10:00:00.000Z");
  });

  it("a leap year: 29 Dec ends 29 Feb, 30 and 31 Dec are clamped to it", () => {
    expect(end("2027-12-29T10:00:00Z").toISOString()).toBe("2028-02-29T10:00:00.000Z");
    expect(end("2027-12-30T10:00:00Z").toISOString()).toBe("2028-02-29T10:00:00.000Z");
    expect(end("2027-12-31T10:00:00Z").toISOString()).toBe("2028-02-29T10:00:00.000Z");
  });

  it("the year rolls over: Nov and Dec starts end in Jan and Feb", () => {
    expect(end("2026-11-30T10:00:00Z").toISOString()).toBe("2027-01-30T10:00:00.000Z");
    expect(end("2026-12-01T00:00:00Z").toISOString()).toBe("2027-02-01T00:00:00.000Z");
  });

  it("the London date decides, not the UTC date (23:30 UTC on 30 Jun is 00:30 on 1 Jul in London)", () => {
    const start = new Date("2026-06-30T23:30:00Z");
    expect(london(start)).toBe("2026-07-01 00:30:00.000");
    expect(london(freePeriodEnd(start))).toBe("2026-09-01 00:30:00.000");
  });

  it("across the March clock change: same London time, one hour shorter", () => {
    // 20 Feb 18:00 GMT to 20 Apr 18:00 BST.
    expect(end("2026-02-20T18:00:00Z").toISOString()).toBe("2026-04-20T17:00:00.000Z");
  });

  it("ends ON the March clock change weekend, at a time that weekend skips: never early", () => {
    // 29 Jan 01:30 GMT. Two months on is Sun 29 Mar 2026 at 01:30, a time
    // that does not exist (01:00 jumps to 02:00). The club gets the later
    // reading, 02:30 BST, never an hour less.
    const e = end("2026-01-29T01:30:00Z");
    expect(e.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(london(e)).toBe("2026-03-29 02:30:00.000");
  });

  it("ends ON the March clock change weekend, at an ordinary time", () => {
    expect(end("2026-01-28T12:00:00Z").toISOString()).toBe("2026-03-28T12:00:00.000Z");
    expect(end("2026-01-29T12:00:00Z").toISOString()).toBe("2026-03-29T11:00:00.000Z");
  });

  it("ends ON the October clock change weekend, at a time that happens twice: the later one", () => {
    // 25 Aug 01:30 BST. Sun 25 Oct 2026 has 01:30 twice; the club gets the second.
    const e = end("2026-08-25T00:30:00Z");
    expect(e.toISOString()).toBe("2026-10-25T01:30:00.000Z");
    expect(london(e)).toBe("2026-10-25 01:30:00.000");
    expect(end("2026-08-24T11:00:00Z").toISOString()).toBe("2026-10-24T11:00:00.000Z");
    expect(end("2026-08-25T11:00:00Z").toISOString()).toBe("2026-10-25T12:00:00.000Z");
  });

  it("STARTS on a clock change weekend", () => {
    // Sun 29 Mar 2026 12:00 BST to Fri 29 May 12:00 BST.
    expect(end("2026-03-29T11:00:00Z").toISOString()).toBe("2026-05-29T11:00:00.000Z");
    // Sun 25 Oct 2026 12:00 GMT to Fri 25 Dec 12:00 GMT.
    expect(end("2026-10-25T12:00:00Z").toISOString()).toBe("2026-12-25T12:00:00.000Z");
  });

  it("is always longer than 58 days and never longer than 62 days and an hour", () => {
    const DAY = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 800; i++) {
      const start = new Date(Date.UTC(2026, 0, 1, 0, 0) + i * (DAY + 37 * 60 * 1000));
      const len = freePeriodEnd(start).getTime() - start.getTime();
      expect(len).toBeGreaterThanOrEqual(59 * DAY - 60 * 60 * 1000);
      expect(len).toBeLessThanOrEqual(62 * DAY + 60 * 60 * 1000);
    }
  });

  it("a different length can be asked for (the copy tests use it)", () => {
    expect(freePeriodEnd(new Date("2026-01-31T10:00:00Z"), 1).toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(freePeriodEnd(new Date("2026-01-31T10:00:00Z"), 3).toISOString()).toBe("2026-04-30T09:00:00.000Z");
  });
});

describe("the last free day and the first billed day", () => {
  const APPROVED = new Date("2026-10-12T13:45:00Z");
  const { trialEndsAt } = trialWindow(APPROVED);
  const club = (over: Partial<BillingClub> = {}): BillingClub => ({
    approvedAt: APPROVED,
    billingStatus: "trial",
    billingPlan: "standard",
    billing: { trialEndsAt, graceEndsAt: null, pausedReason: null },
    ...over,
  });
  const sched = (over: Partial<ScheduleClub> = {}): ScheduleClub => ({
    status: "trial",
    trialEndsAt,
    graceEndsAt: null,
    pausedAt: null,
    pausedReason: null,
    ...over,
  });
  const justBefore = new Date(trialEndsAt.getTime() - 1);

  it("approval starts the free period (the flag on)", () => {
    const exempt = club({ billingStatus: "exempt", billing: null });
    expect(nextBillingState(exempt, { type: "approved" }, APPROVED, ON)).toMatchObject({ to: "trial", createsBilling: true });
  });

  it("day 31 (the old end) is still free: nothing is due and nothing moves", () => {
    const day31 = new Date(APPROVED.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(billingTransitionDue(sched(), day31)).toBeNull();
    expect(nextBillingState(club(), { type: "trial-ended" }, day31, ON)).toBeNull();
    expect(billingDmsDue(sched(), new Date("2026-11-12T12:00:00Z"), { trial21Delivered: false })).toEqual([]);
    expect(feeTipDue(sched(), new Date("2026-11-12T12:00:00Z"))).toBeNull();
  });

  it("one millisecond before the end: still free", () => {
    expect(billingTransitionDue(sched(), justBefore)).toBeNull();
    expect(nextBillingState(club(), { type: "trial-ended" }, justBefore, ON)).toBeNull();
    expect(monthIndexAt(trialEndsAt, justBefore)).toBe(0);
    expect(monthsToOpen(trialEndsAt, 0, justBefore)).toEqual([]);
  });

  it("at the end: the free period is over and month 1 opens, from that instant", () => {
    expect(billingTransitionDue(sched(), trialEndsAt)).toBe("trial-ended");
    expect(nextBillingState(club(), { type: "trial-ended" }, trialEndsAt, ON)).toMatchObject({ to: "grace" });
    expect(monthIndexAt(trialEndsAt, trialEndsAt)).toBe(1);
    expect(monthsToOpen(trialEndsAt, 0, trialEndsAt)).toEqual([1]);
    const m1 = monthBounds(trialEndsAt, 1);
    expect(m1.startsAt).toEqual(trialEndsAt);
    // Month 1 runs from Sat 12 Dec 14:45 to 00:00 London on Tue 12 Jan.
    expect(m1.endsAt.toISOString()).toBe("2027-01-12T00:00:00.000Z");
  });

  it("a card on file at the end: billed with it, month 1 from the same instant", () => {
    const withCard = club({ billing: { trialEndsAt, graceEndsAt: null, pausedReason: null, hasCard: true } });
    expect(nextBillingState(withCard, { type: "trial-ended" }, trialEndsAt, ON)).toMatchObject({ to: "subscribed" });
  });

  it("games played in month two are free: no billing month contains them", () => {
    // Weekly games on Tuesdays at 20:00 London, all through month two.
    for (const iso of ["2026-11-17T20:00:00Z", "2026-11-24T20:00:00Z", "2026-12-01T20:00:00Z", "2026-12-08T20:00:00Z"]) {
      const kickoff = new Date(iso);
      expect(kickoff.getTime()).toBeLessThan(trialEndsAt.getTime());
      expect(monthIndexAt(trialEndsAt, kickoff)).toBe(0);
      expect(monthsToOpen(trialEndsAt, 0, kickoff)).toEqual([]);
      const m1 = monthBounds(trialEndsAt, 1);
      expect(kickoff.getTime()).toBeLessThan(m1.startsAt.getTime());
    }
    // The first Tuesday after the end is the first game that can be charged.
    expect(monthIndexAt(trialEndsAt, new Date("2026-12-15T20:00:00Z"))).toBe(1);
  });

  it("a card saved in month two changes nothing: Stop paying there goes back to the free period", () => {
    const paying = club({ billingStatus: "subscribed", billing: { trialEndsAt, graceEndsAt: null, pausedReason: null, hasCard: true } });
    const monthTwo = new Date("2026-12-01T12:00:00Z");
    expect(nextBillingState(paying, { type: "billing-stopped" }, monthTwo, ON)).toMatchObject({ to: "trial" });
  });

  it("the card reminders count back from the end: 9 and 2 London days before, at 10:00", () => {
    expect(london(reminderAt(trialEndsAt, 9))).toBe("2026-12-03 10:00:00.000");
    expect(london(reminderAt(trialEndsAt, 2))).toBe("2026-12-10 10:00:00.000");
    const key = trialEndsAt.toISOString();
    expect(billingDmsDue(sched(), new Date("2026-12-03T09:59:00Z"), { trial21Delivered: false })).toEqual([]);
    expect(billingDmsDue(sched(), new Date("2026-12-03T10:00:00Z"), { trial21Delivered: false })).toEqual([
      { kind: "trial-21", cycleKey: key, withTip: true },
    ]);
    expect(billingDmsDue(sched(), new Date("2026-12-10T10:00:00Z"), { trial21Delivered: true })).toEqual([
      { kind: "trial-28", cycleKey: key, withTip: false },
    ]);
  });
});

describe("the AI allowance of a new club runs for the same free period", () => {
  const org = (over: Partial<AllowanceOrg> = {}): AllowanceOrg => ({
    createdAt: new Date("2026-10-01T00:00:00Z"),
    aiDailyCapUsd: null,
    aiWindowStartAt: null,
    whatsappBotEnabled: true,
    whatsappGroupId: "g@g.us",
    approvalStatus: "approved",
    approvedAt: new Date("2026-10-12T13:45:00Z"),
    billingStatus: "trial",
    ...over,
  });
  const ends = freePeriodEnd(new Date("2026-10-12T13:45:00Z"));

  it("the free allowance for the whole free period, the paying default from its end", () => {
    expect(aiAllowanceUsd(org(), new Date("2026-10-12T13:45:00Z"))).toBe(NEW_CLUB_CAP_USD);
    // Day 31, where the old 30 day window had already closed.
    expect(aiAllowanceUsd(org(), new Date("2026-11-12T13:45:00Z"))).toBe(NEW_CLUB_CAP_USD);
    expect(aiAllowanceUsd(org(), new Date(ends.getTime() - 1))).toBe(NEW_CLUB_CAP_USD);
    expect(aiAllowanceUsd(org(), ends)).toBe(DAILY_CAP_USD);
  });

  it("a club that predates self-join counts from its own window start", () => {
    const old = org({ approvedAt: null, createdAt: new Date("2026-07-31T11:00:00Z") });
    expect(aiAllowanceUsd(old, new Date("2026-09-30T10:59:59Z"))).toBe(NEW_CLUB_CAP_USD);
    expect(aiAllowanceUsd(old, new Date("2026-09-30T11:00:00Z"))).toBe(DAILY_CAP_USD);
  });
});

describe("the copy says the same length the arithmetic uses", () => {
  it("the phrases, English and Turkish", () => {
    expect(freePeriodLength("en")).toBe("two months");
    expect(freePeriodLength("tr")).toBe("iki ay");
    expect(firstMonthsFree("en")).toBe("Your first two months are free");
    expect(firstMonthsFree("tr")).toBe("İlk iki ayınız ücretsiz");
    expect(firstMonthsFreeBadge()).toBe("First two months free");
  });

  it("the phrases follow the number (one month reads as it always did)", () => {
    expect(freePeriodLength("en", 1)).toBe("one month");
    expect(freePeriodLength("tr", 1)).toBe("bir ay");
    expect(firstMonthsFree("en", 1)).toBe("Your first month is free");
    expect(firstMonthsFree("tr", 1)).toBe("İlk ayınız ücretsiz");
    expect(firstMonthsFreeBadge(1)).toBe("First month free");
    expect(firstMonthsFree("en", 3)).toBe("Your first three months are free");
    expect(firstMonthsFree("tr", 3)).toBe("İlk üç ayınız ücretsiz");
    expect(freePeriodLength("en", 24)).toBe("24 months");
    expect(freePeriodLength("tr", 24)).toBe("24 ay");
  });

  const args = { club: "Cron Rovers", group: "Cron Rovers", scheduleUrl: "https://x/s", ratingsUrl: "https://x/r", settingsUrl: "https://x/t" };

  it("the organiser's \"you're live\" DM", () => {
    expect(en.sj_dm_approved(args)).toMatch(/\n\nYour first two months are free\.$/);
    expect(tr.sj_dm_approved(args)).toMatch(/\n\nİlk iki ayınız ücretsiz\.$/);
    expect(en.sj_dm_approved({ ...args, tip: "TIP" })).toMatch(/Your first two months are free\.\n\nTIP$/);
  });

  it("no message still says the free MONTH", () => {
    const samples = (s: typeof en) => [
      s.sj_dm_approved(args),
      s.billing_state_trial({ date: "D", price: "£9.99" }),
      s.billing_state_grace({ date: "D" }),
      s.billing_stop_confirm_free({ date: "D" }),
      s.billing_banner_grace({ date: "D" }),
      s.billing_notice_stopped_free,
      s.billing_dm_plan_billed({ name: "Cole", club: "Cron Rovers", price: "£9.99", date: "D", link: "L" }),
      s.billing_dm_trial_21({ name: "Cole", club: "Cron Rovers", date: "D", price: "£9.99", firstCharge: "F", link: "L", collector: true }),
      s.billing_dm_trial_28({ name: "Cole", club: "Cron Rovers", date: "D", price: "£9.99", link: "L" }),
      s.billing_dm_trial_ended({ name: "Cole", club: "Cron Rovers", date: "D", price: "£9.99", link: "L" }),
      s.info_clubs_fee_body,
    ];
    for (const text of samples(en)) {
      expect(text).not.toMatch(/free month\b/i);
      expect(text).not.toMatch(/first month\b/i);
      expect(text).not.toMatch(/[–—]/);
    }
    for (const text of samples(tr)) {
      expect(text).not.toMatch(/ücretsiz ay\b/i);
      expect(text).not.toMatch(/İlk ayınız/);
      expect(text).not.toMatch(/[–—]/);
    }
  });
});
