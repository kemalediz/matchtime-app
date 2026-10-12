/**
 * THE FREE PERIOD STARTS AT GO-LIVE (owner decision 2, 2026-10-12; go-live
 * plan 2.6, slice S4b). The PURE rules.
 *
 * A club that is approved but still setting up is silent in its group. Its
 * two free months must not run out while it is silent, so for a club that
 * went through the hold every "first day" is the day it went LIVE:
 *
 *   - the billing free period (`freePeriodStart`, `nextBillingState`);
 *   - the higher AI allowance of a new club (`aiWindowStart`);
 *   - the new club's member DM cap (`newClubDmCap`).
 *
 * A club that never went through the hold has no go-live stamp, and every
 * date below is exactly what it was.
 *
 * No database, no network, no model.
 */
import { describe, expect, it } from "vitest";
import { formatLondon } from "../london-time";
import {
  GRACE_DAYS,
  freePeriodCanStart,
  freePeriodEnd,
  freePeriodStart,
  graceEndsFrom,
  nextBillingState,
  startTrialRefusal,
  trialWindow,
  type BillingClub,
} from "../club-billing-rules";
import { TRIAL_21_DAYS_BEFORE_END, TRIAL_28_DAYS_BEFORE_END, billingDmsDue, billingTransitionDue, reminderAt } from "../club-billing-schedule-rules";
import { beforeGoLiveSpan, countClubMonth, monthBounds, monthIndexAt, monthsToOpen, type CycleActivity, type CycleMatch } from "../club-billing-cycle-rules";
import { DAILY_CAP_USD, NEW_CLUB_CAP_USD, aiAllowanceUsd, aiWindowStart, type AllowanceOrg } from "../ai-budget";
import { NEW_CLUB_DM_WINDOW_DAYS, NEW_CLUB_MEMBER_DMS_PER_DAY, newClubDmCap } from "../club-decision-rules";

const ON = { BILLING_ENABLED: "1" };
const OFF = {};
const DAY = 24 * 60 * 60 * 1000;
const london = (d: Date) => formatLondon(d, "yyyy-MM-dd HH:mm");

// Approved Thu 1 Oct 2026, 10:00 London; live Tue 20 Oct 2026, 19:30 London.
const APPROVED = new Date("2026-10-01T09:00:00Z");
const LIVE = new Date("2026-10-20T18:30:00Z");

function club(over: Partial<BillingClub> = {}): BillingClub {
  return { approvedAt: APPROVED, billingStatus: "exempt", billingPlan: "standard", billing: null, ...over };
}

describe("freePeriodStart: the one definition of a club's first day", () => {
  it("a club that went through the hold: the day it went live", () => {
    expect(freePeriodStart({ approvedAt: APPROVED, liveAt: LIVE })).toEqual(LIVE);
  });

  it("a club that never went through the hold (no go-live stamp): its approval, as before", () => {
    expect(freePeriodStart({ approvedAt: APPROVED, liveAt: null })).toEqual(APPROVED);
    expect(freePeriodStart({ approvedAt: APPROVED })).toEqual(APPROVED);
  });

  it("a club that predates self-join has neither, and no first day", () => {
    expect(freePeriodStart({ approvedAt: null, liveAt: null })).toBeNull();
  });
});

describe("held club, approved 1 October, live 20 October", () => {
  const { trialStartedAt, trialEndsAt } = trialWindow(freePeriodStart({ approvedAt: APPROVED, liveAt: LIVE })!);

  it("is free until 20 December, the same London time of day, not 1 December", () => {
    expect(trialStartedAt).toEqual(LIVE);
    expect(london(trialEndsAt)).toBe("2026-12-20 19:30");
    // The clocks went back on 25 October, so the end is an hour later in UTC.
    expect(trialEndsAt.toISOString()).toBe("2026-12-20T19:30:00.000Z");
    expect(trialEndsAt.getTime()).toBeGreaterThan(freePeriodEnd(APPROVED).getTime() + 18 * DAY);
  });

  it("the first card reminder is nine days before that, at 09:00 London, and the second two days before", () => {
    expect(london(reminderAt(trialEndsAt, TRIAL_21_DAYS_BEFORE_END))).toBe("2026-12-11 09:00");
    expect(london(reminderAt(trialEndsAt, TRIAL_28_DAYS_BEFORE_END))).toBe("2026-12-18 09:00");
    const sched = { status: "trial", trialEndsAt, graceEndsAt: null, pausedAt: null, pausedReason: null };
    // 1 December, where a free period counted from approval would have ended: nothing is due.
    expect(billingTransitionDue(sched, new Date("2026-12-01T12:00:00Z"))).toBeNull();
    expect(billingDmsDue(sched, new Date("2026-12-01T12:00:00Z"), { trial21Delivered: false })).toEqual([]);
    expect(billingDmsDue(sched, new Date("2026-12-11T08:59:00Z"), { trial21Delivered: false })).toEqual([]);
    expect(billingDmsDue(sched, new Date("2026-12-11T09:00:00Z"), { trial21Delivered: false })).toEqual([
      { kind: "trial-21", cycleKey: trialEndsAt.toISOString(), withTip: true },
    ]);
  });

  it("the grace week runs from that end", () => {
    const sched = { status: "trial", trialEndsAt, graceEndsAt: null, pausedAt: null, pausedReason: null };
    expect(billingTransitionDue(sched, new Date(trialEndsAt.getTime() - 1))).toBeNull();
    expect(billingTransitionDue(sched, trialEndsAt)).toBe("trial-ended");
    const t = nextBillingState(
      club({ billingStatus: "trial", liveAt: LIVE, billing: { trialEndsAt, graceEndsAt: null, pausedReason: null } }),
      { type: "trial-ended" },
      trialEndsAt,
      ON,
    );
    expect(t).toMatchObject({ to: "grace", graceEndsAt: graceEndsFrom(trialEndsAt) });
    expect(london(t!.graceEndsAt!)).toBe("2026-12-27 19:30");
    expect(t!.graceEndsAt!.getTime() - trialEndsAt.getTime()).toBe(GRACE_DAYS * DAY);
  });

  it("the first billing month is anchored on that end: it starts there, and no month exists before it", () => {
    const m1 = monthBounds(trialEndsAt, 1);
    expect(m1.startsAt).toEqual(trialEndsAt);
    expect(london(m1.endsAt)).toBe("2027-01-20 00:00");
    expect(monthIndexAt(trialEndsAt, new Date(trialEndsAt.getTime() - 1))).toBe(0);
    expect(monthsToOpen(trialEndsAt, 0, new Date("2026-12-10T12:00:00Z"))).toEqual([]);
    expect(monthsToOpen(trialEndsAt, 0, trialEndsAt)).toEqual([1]);
  });
});

describe("other go-live days", () => {
  const endOf = (approved: string, live: string) =>
    trialWindow(freePeriodStart({ approvedAt: new Date(approved), liveAt: new Date(live) })!).trialEndsAt;

  it("approved and live on the same day: two months from the go-live, hours later than from the approval", () => {
    const end = endOf("2026-10-12T09:00:00Z", "2026-10-12T13:00:00Z");
    expect(london(end)).toBe("2026-12-12 14:00");
    expect(end.getTime() - freePeriodEnd(new Date("2026-10-12T09:00:00Z")).getTime()).toBe(4 * 60 * 60 * 1000);
  });

  it("live at the very instant of approval: the same end as before", () => {
    expect(endOf("2026-10-12T09:00:00Z", "2026-10-12T09:00:00Z")).toEqual(freePeriodEnd(new Date("2026-10-12T09:00:00Z")));
  });

  it("across the autumn clock change: the same London time, an hour longer", () => {
    // Live Tue 25 Aug 2026, 12:00 BST; free until Sun 25 Oct, 12:00 GMT.
    const end = endOf("2026-08-20T09:00:00Z", "2026-08-25T11:00:00Z");
    expect(london(end)).toBe("2026-10-25 12:00");
    expect(end.toISOString()).toBe("2026-10-25T12:00:00.000Z");
  });

  it("across the spring clock change, onto a time the change skips: an hour later, never early", () => {
    // Live Thu 28 Jan 2027, 01:30 GMT. 01:30 on Sun 28 Mar 2027 does not exist.
    const end = endOf("2027-01-20T09:00:00Z", "2027-01-28T01:30:00Z");
    expect(london(end)).toBe("2027-03-28 02:30");
    expect(end.toISOString()).toBe("2027-03-28T01:30:00.000Z");
  });

  it("live on 31 December: free until 28 February", () => {
    const end = endOf("2026-12-15T09:00:00Z", "2026-12-31T22:00:00Z");
    expect(london(end)).toBe("2027-02-28 22:00");
    // The first billing month is anchored on that end: 28 February to 28 March.
    expect(monthBounds(end, 1).startsAt).toEqual(end);
    expect(london(monthBounds(end, 1).endsAt)).toBe("2027-03-28 00:00");
  });
});

describe("nextBillingState: the free period starts ONCE, at whichever of approval and go-live gets there", () => {
  it("went-live starts it for a held club that has just gone live", () => {
    expect(nextBillingState(club({ liveAt: LIVE }), { type: "went-live" }, LIVE, ON)).toMatchObject({ to: "trial", createsBilling: true });
  });

  it("a second start is no change, whichever event tries: the club already has its free period", () => {
    const started = club({ billingStatus: "trial", liveAt: LIVE, billing: { trialEndsAt: freePeriodEnd(LIVE), graceEndsAt: null, pausedReason: null } });
    for (const type of ["went-live", "approved", "start-trial"] as const) {
      expect(nextBillingState(started, { type }, new Date(LIVE.getTime() + 1000), ON), type).toBeNull();
    }
  });

  it("approval got there first (a club that was never held): go-live cannot start a second one", () => {
    const b = { trialEndsAt: freePeriodEnd(APPROVED), graceEndsAt: null, pausedReason: null };
    expect(nextBillingState(club({ billingStatus: "trial", billing: b, liveAt: LIVE }), { type: "went-live" }, LIVE, ON)).toBeNull();
    // Nor once that free period is used up, however the club is billed now.
    for (const billingStatus of ["grace", "subscribed", "past_due", "paused", "exempt"]) {
      expect(nextBillingState(club({ billingStatus, billing: b, liveAt: LIVE }), { type: "went-live" }, LIVE, ON), billingStatus).toBeNull();
    }
  });

  it("a club that is STILL SETTING UP never starts one, by approval, by the owner's button or by go-live", () => {
    for (const type of ["approved", "start-trial", "went-live"] as const) {
      expect(nextBillingState(club({ settingUp: true }), { type }, new Date("2026-10-05T12:00:00Z"), ON), type).toBeNull();
    }
  });

  it("went-live needs the go-live stamp: a club with none is not moved by it", () => {
    expect(nextBillingState(club({ liveAt: null }), { type: "went-live" }, LIVE, ON)).toBeNull();
    expect(nextBillingState(club(), { type: "went-live" }, LIVE, ON)).toBeNull();
  });

  it("went-live holds every line an approval holds: flag off, plan Free, a club that predates self-join", () => {
    expect(nextBillingState(club({ liveAt: LIVE }), { type: "went-live" }, LIVE, OFF)).toBeNull();
    expect(nextBillingState(club({ liveAt: LIVE, billingPlan: "free" }), { type: "went-live" }, LIVE, ON)).toBeNull();
    expect(nextBillingState(club({ liveAt: LIVE, approvedAt: null }), { type: "went-live" }, LIVE, ON)).toBeNull();
  });

  it("THE LATENT TRAP: an approval event for a club that has ALREADY gone live out of the hold starts nothing", () => {
    // Held, went live while billing was off (so no row), billing switched
    // on months later, and something fires "approved". Counted from the old
    // go-live it would land straight in the grace week. It is refused: the
    // owner's Start free period is the way in, and it starts from that day.
    const liveLongAgo = club({ liveAt: LIVE });
    const muchLater = new Date("2027-03-01T12:00:00Z");
    expect(nextBillingState(liveLongAgo, { type: "approved" }, muchLater, ON)).toBeNull();
    expect(nextBillingState(liveLongAgo, { type: "approved" }, LIVE, ON)).toBeNull();
    expect(nextBillingState(liveLongAgo, { type: "start-trial" }, muchLater, ON)).toMatchObject({ to: "trial", createsBilling: true });
  });

  it("freePeriodCanStart is the one test all three share: billing on, exempt, no earlier free period, not Free, came through self-join", () => {
    const yes = { approvedAt: APPROVED, billingStatus: "exempt", billingPlan: "standard", hasBilling: false };
    expect(freePeriodCanStart(yes, ON)).toBe(true);
    expect(freePeriodCanStart({ ...yes, billingPlan: "custom" }, ON)).toBe(true);
    expect(freePeriodCanStart(yes, OFF)).toBe(false);
    expect(freePeriodCanStart({ ...yes, billingPlan: "free" }, ON)).toBe(false);
    expect(freePeriodCanStart({ ...yes, hasBilling: true }, ON)).toBe(false);
    expect(freePeriodCanStart({ ...yes, billingStatus: "trial" }, ON)).toBe(false);
    expect(freePeriodCanStart({ ...yes, approvedAt: null }, ON)).toBe(false);
    // It agrees with the state machine for a club that has just gone live.
    for (const c of [yes, { ...yes, billingPlan: "free" }, { ...yes, hasBilling: true }, { ...yes, billingStatus: "paused" }, { ...yes, approvedAt: null }]) {
      for (const env of [ON, OFF]) {
        const b = c.hasBilling ? { trialEndsAt: freePeriodEnd(APPROVED), graceEndsAt: null, pausedReason: null } : null;
        const moved = nextBillingState({ approvedAt: c.approvedAt, billingStatus: c.billingStatus, billingPlan: c.billingPlan, billing: b, liveAt: LIVE }, { type: "went-live" }, LIVE, env);
        expect(moved !== null, JSON.stringify([c, env])).toBe(freePeriodCanStart(c, env));
      }
    }
  });

  it("a never-held club (no go-live stamp, not setting up) is approved into its free period exactly as before", () => {
    expect(nextBillingState(club(), { type: "approved" }, APPROVED, ON)).toEqual({
      to: "trial",
      pausedReason: null,
      createsBilling: true,
      resumes: false,
    });
    expect(nextBillingState(club({ settingUp: false, liveAt: null }), { type: "start-trial" }, APPROVED, ON)).toMatchObject({ to: "trial", createsBilling: true });
  });

  it("a club that is setting up is never paused for a removal, even if it somehow has a billing row", () => {
    const b = { trialEndsAt: freePeriodEnd(APPROVED), graceEndsAt: null, pausedReason: null };
    expect(nextBillingState(club({ billingStatus: "trial", billing: b, settingUp: true }), { type: "removed-from-group" }, APPROVED, ON)).toBeNull();
    // A live club is paused, as before.
    expect(nextBillingState(club({ billingStatus: "trial", billing: b }), { type: "removed-from-group" }, APPROVED, ON)).toMatchObject({
      to: "paused",
      pausedReason: "removed",
    });
  });
});

describe("startTrialRefusal: the owner's Start free period button", () => {
  const base = { approvedAt: APPROVED, billingStatus: "exempt", billingPlan: "standard", hadFreeMonth: false };

  it("refuses a club that is still setting up: its free period starts by itself at go-live", () => {
    expect(startTrialRefusal({ ...base, settingUp: true }, ON)).toBe("setting-up");
  });

  it("allows a live club approved before billing was on, as before", () => {
    expect(startTrialRefusal(base, ON)).toBeNull();
    expect(startTrialRefusal({ ...base, settingUp: false }, ON)).toBeNull();
  });
});

describe("the AI allowance of a new club runs from go-live", () => {
  const org = (over: Partial<AllowanceOrg> = {}): AllowanceOrg => ({
    createdAt: new Date("2026-09-20T09:00:00Z"),
    aiDailyCapUsd: null,
    aiWindowStartAt: null,
    whatsappBotEnabled: true,
    whatsappGroupId: "g@g.us",
    approvalStatus: "approved",
    approvedAt: APPROVED,
    billingStatus: "trial",
    ...over,
  });

  it("the window starts at go-live for a held club, at approval for a never-held one", () => {
    expect(aiWindowStart(org({ liveAt: LIVE }))).toEqual(LIVE);
    expect(aiWindowStart(org({ liveAt: null }))).toEqual(APPROVED);
    expect(aiWindowStart(org())).toEqual(APPROVED);
    // The older levers are untouched for a club that predates self-join.
    expect(aiWindowStart(org({ approvedAt: null, aiWindowStartAt: new Date("2026-09-25T00:00:00Z") }))).toEqual(new Date("2026-09-25T00:00:00Z"));
    expect(aiWindowStart(org({ approvedAt: null }))).toEqual(new Date("2026-09-20T09:00:00Z"));
  });

  it("held club: the higher allowance lasts until two months after go-live, to the millisecond", () => {
    const held = org({ liveAt: LIVE });
    const end = freePeriodEnd(LIVE);
    // 5 December is past two months from the approval and still inside the window.
    expect(aiAllowanceUsd(held, new Date("2026-12-05T12:00:00Z"))).toBe(NEW_CLUB_CAP_USD);
    expect(aiAllowanceUsd(held, new Date(end.getTime() - 1))).toBe(NEW_CLUB_CAP_USD);
    expect(aiAllowanceUsd(held, end)).toBe(DAILY_CAP_USD);
  });

  it("never-held club: the boundary is exactly where it was, two months after approval", () => {
    const end = freePeriodEnd(APPROVED);
    expect(end.toISOString()).toBe("2026-12-01T10:00:00.000Z");
    expect(aiAllowanceUsd(org(), new Date(end.getTime() - 1))).toBe(NEW_CLUB_CAP_USD);
    expect(aiAllowanceUsd(org(), end)).toBe(DAILY_CAP_USD);
    expect(aiAllowanceUsd(org({ liveAt: null }), end)).toBe(DAILY_CAP_USD);
  });

  it("while it is setting up the club still spends nothing outside its setup reading", () => {
    const settingUp = { ...org({ whatsappBotEnabled: false, billingStatus: "exempt" }), setupStage: "setting-up" } as AllowanceOrg;
    expect(aiAllowanceUsd(settingUp, new Date("2026-10-05T12:00:00Z"))).toBe(0);
  });
});

describe("the new club's member DM cap runs from go-live", () => {
  const WINDOW = NEW_CLUB_DM_WINDOW_DAYS * DAY;

  it("held club: capped for 28 days from the day it went live", () => {
    const held = { approvedAt: APPROVED, liveAt: LIVE };
    // 1 November: more than 28 days after the approval, 12 after go-live.
    expect(newClubDmCap(held, new Date("2026-11-01T12:00:00Z"))).toBe(NEW_CLUB_MEMBER_DMS_PER_DAY);
    expect(newClubDmCap(held, new Date(LIVE.getTime() + WINDOW - 1))).toBe(NEW_CLUB_MEMBER_DMS_PER_DAY);
    expect(newClubDmCap(held, new Date(LIVE.getTime() + WINDOW))).toBeNull();
  });

  it("never-held club: 28 days from approval, exactly as before", () => {
    for (const o of [{ approvedAt: APPROVED }, { approvedAt: APPROVED, liveAt: null }]) {
      expect(newClubDmCap(o, new Date(APPROVED.getTime() + WINDOW - 1))).toBe(NEW_CLUB_MEMBER_DMS_PER_DAY);
      expect(newClubDmCap(o, new Date(APPROVED.getTime() + WINDOW))).toBeNull();
    }
  });

  it("a club that predates self-join is never capped", () => {
    expect(newClubDmCap({ approvedAt: null }, APPROVED)).toBeNull();
    expect(newClubDmCap({ approvedAt: null, liveAt: null }, APPROVED)).toBeNull();
  });
});

describe("games from before go-live are never billable", () => {
  const activity: CycleActivity = { id: "a", dayOfWeek: 2, time: "20:00", venue: "Park", isActive: true, createdAt: new Date("2026-09-01T09:00:00Z") };
  // Tuesdays 6 and 13 October: generated and completed while the club was
  // setting up, and force-completed (post-match flow off) at go-live.
  const before = (id: string, iso: string, over: Partial<CycleMatch> = {}): CycleMatch => ({
    id,
    activityId: "a",
    date: new Date(iso),
    status: "COMPLETED",
    isHistorical: false,
    redScore: null,
    yellowScore: null,
    confirmedCount: 0,
    ...over,
  });
  const setupGames = [
    before("m1", "2026-10-06T19:00:00Z", { confirmedCount: 10 }),
    before("m2", "2026-10-13T19:00:00Z", { redScore: 3, yellowScore: 2 }),
    before("m3", "2026-10-20T17:00:00Z"), // kicked off 90 minutes before the GO
  ];
  const held = { approvalStatus: "approved", liveAt: LIVE };
  const stillSettingUp = { approvalStatus: "approved", liveAt: null, setupStage: "setting-up" };

  it("the span: everything before go-live for a held club, everything so far for one still setting up, nothing for anybody else", () => {
    // Up to AND INCLUDING the go-live instant: a match that kicked off at
    // that very moment is one `goLiveClub` completed quietly as "before".
    expect(beforeGoLiveSpan(held)).toEqual({ from: new Date(0), to: new Date(LIVE.getTime() + 1) });
    expect(beforeGoLiveSpan(stillSettingUp)).toEqual({ from: new Date(0), to: null });
    expect(beforeGoLiveSpan({ approvalStatus: "approved", liveAt: null })).toBeNull();
    expect(beforeGoLiveSpan({ approvalStatus: "approved" })).toBeNull();
  });

  for (const tracksAttendance of [true, false]) {
    const kind = tracksAttendance ? "a club that tracks attendance" : "a club that does NOT track attendance (any ended match counts)";

    it(`${kind}: no billing month reaches back before go-live, so none of them is in any month`, () => {
      const anchor = freePeriodEnd(LIVE);
      for (const index of [1, 2, 3]) {
        const month = monthBounds(anchor, index);
        expect(month.startsAt.getTime()).toBeGreaterThan(LIVE.getTime());
        const count = countClubMonth({ ...month, activities: [activity], matches: setupGames, tracksAttendance });
        expect(count.played, `month ${index}`).toBe(0);
        expect(count.games.flatMap((g) => g.matchIds)).toEqual([]);
      }
    });

    it(`${kind}: even a month that somehow covered them counts none as played`, () => {
      // The impossible row: a free period wrongly counted from approval
      // would make October a billing month. The span still leaves them out.
      const month = { startsAt: new Date("2026-10-01T09:00:00Z"), endsAt: new Date("2026-10-31T23:00:00Z") };
      const bare = countClubMonth({ ...month, activities: [activity], matches: setupGames, tracksAttendance });
      expect(bare.played).toBeGreaterThan(0); // what the span is there to stop
      for (const org of [held, stillSettingUp]) {
        const count = countClubMonth({ ...month, activities: [activity], matches: setupGames, pauseSpans: [beforeGoLiveSpan(org)!], tracksAttendance });
        expect(count.played).toBe(0);
        expect(count.scheduled).toBe(bare.scheduled);
      }
    });
  }

  it("a match that kicked off at the exact go-live instant is before go-live (as the go-live's own quieting has it), one millisecond later is after", () => {
    const month = { startsAt: new Date("2026-10-01T09:00:00Z"), endsAt: new Date("2026-10-31T23:00:00Z") };
    const at = (id: string, d: Date) => before(id, d.toISOString(), { confirmedCount: 10 });
    const count = (m: CycleMatch) =>
      countClubMonth({ ...month, activities: [], matches: [m], pauseSpans: [beforeGoLiveSpan(held)!], tracksAttendance: true }).played;
    expect(count(at("exact", LIVE))).toBe(0);
    expect(count(at("after", new Date(LIVE.getTime() + 1)))).toBe(1);
  });

  it("a game played after go-live in that same month still counts", () => {
    const month = { startsAt: new Date("2026-10-01T09:00:00Z"), endsAt: new Date("2026-10-31T23:00:00Z") };
    const after = before("m4", "2026-10-27T20:00:00Z", { confirmedCount: 10 });
    const count = countClubMonth({ ...month, activities: [activity], matches: [...setupGames, after], pauseSpans: [beforeGoLiveSpan(held)!], tracksAttendance: true });
    expect(count.played).toBe(1);
    expect(count.games.find((g) => g.played)?.matchIds).toEqual(["m4"]);
  });
});
