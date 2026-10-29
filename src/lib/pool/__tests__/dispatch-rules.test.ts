/**
 * Admitting pool offers at DISPATCH (slice L5a; the design is L4's
 * caps.ts header, revised by the review of #400, M3). Under one lock, each
 * poll counts the pool DMs IN FLIGHT or DELIVERED (a job claimed and not
 * released, or sent), admits at most the room (claiming the job), re-checks
 * his caps (delivered and in-flight offers only), every switch, the
 * offer's own state and the game's (cut-off, kickoff, status, its planned
 * expiry), and holds the rest. No night hold (2026-10-29). Nothing is stamped as
 * delivered here: that is the Pi's "sent".
 */
import { describe, expect, it } from "vitest";
import { londonDateTimeToUtc } from "../../london-time";
import { POOL_PLATFORM_CAPS, type OfferLedgerEntry } from "../caps";
import { optedOutOfDms, planPoolAdmission, type PoolJobView } from "../dispatch-rules";

const NOW = londonDateTimeToUtc("2026-10-27", "12:00");
const MIN = 60_000;

let n = 0;
const job = (over: Partial<PoolJobView> = {}): PoolJobView => {
  n++;
  return {
    jobId: `j${n}`,
    offerId: `o${n}`,
    userId: `u${n}`,
    orgId: "club-a",
    clubOpen: true,
    profileActive: true,
    dmOptedOut: false,
    offerOpen: true,
    askOpen: true,
    gameOpen: true,
    ledger: [],
    ...over,
  };
};

describe("room: at most the platform caps, oldest first, the rest held", () => {
  it("admits up to the room and holds the rest", () => {
    const busy = Array.from({ length: POOL_PLATFORM_CAPS.perHour - 2 }, (_, i) => new Date(NOW.getTime() - (i + 1) * MIN));
    const jobs = [job(), job(), job(), job()];
    const plan = planPoolAdmission(jobs, busy, NOW, 10);
    expect(plan.admit).toEqual([jobs[0].jobId, jobs[1].jobId]);
    expect(plan.hold).toEqual([jobs[2].jobId, jobs[3].jobId]);
    expect(plan.cancel).toEqual([]);
  });

  it("never more than the per-poll limit", () => {
    const jobs = [job(), job(), job()];
    const plan = planPoolAdmission(jobs, [], NOW, 2);
    expect(plan.admit).toHaveLength(2);
    expect(plan.hold).toEqual([jobs[2].jobId]);
  });

  it("two claimers in turn (the lock serialises them) cannot spend the same room", () => {
    const busy = Array.from({ length: POOL_PLATFORM_CAPS.perHour - 1 }, (_, i) => new Date(NOW.getTime() - (i + 1) * MIN));
    expect(planPoolAdmission([job()], busy, NOW, 5).admit).toHaveLength(1);
    // The first claimer's claim is committed before the second counts.
    const b = planPoolAdmission([job()], [...busy, NOW], NOW, 5);
    expect(b.admit).toEqual([]);
    expect(b.hold).toHaveLength(1);
  });
});

describe("re-checked at send time: switches, the offer, the game, the person", () => {
  const cases: Array<[string, Partial<PoolJobView>, string]> = [
    ["the switch or the club's flag went off", { clubOpen: false }, "switched-off"],
    ["he paused or stopped meanwhile", { profileActive: false }, "profile-off"],
    ["the offer was answered or ended", { offerOpen: false }, "closed"],
    ["the round closed (filled, cut-off, cancelled)", { askOpen: false }, "closed"],
    ["past the cut-off, kicked off, the game off, or its planned window gone (minor 3)", { gameOpen: false }, "closed"],
  ];
  for (const [name, over, reason] of cases) {
    it(`${name}: cancelled, never sent`, () => {
      const j = job(over);
      const plan = planPoolAdmission([j], [], NOW, 5);
      expect(plan.cancel).toEqual([{ jobId: j.jobId, offerId: j.offerId, reason }]);
      expect(plan.admit).toEqual([]);
    });
  }

  it("his caps, judged now with what reached him meanwhile (another club's offer today)", () => {
    const today: OfferLedgerEntry = { orgId: "club-b", at: new Date(NOW.getTime() - 60 * MIN), outcome: null, resolvedAt: null };
    const j = job({ ledger: [today] });
    expect(planPoolAdmission([j], [], NOW, 5).cancel).toEqual([{ jobId: j.jobId, offerId: j.offerId, reason: "day-cap" }]);
  });

  it("two offers to one person in one poll: the second meets the day cap", () => {
    const first = job({ userId: "ali" });
    const second = job({ userId: "ali", orgId: "club-b" });
    const plan = planPoolAdmission([first, second], [], NOW, 5);
    expect(plan.admit).toEqual([first.jobId]);
    expect(plan.cancel).toEqual([{ jobId: second.jobId, offerId: second.offerId, reason: "day-cap" }]);
  });
});

describe("no night hold (Kemal, 2026-10-29): an offer at 03:00 London is admitted now", () => {
  const night = londonDateTimeToUtc("2026-10-28", "03:00");
  it("admitted at 03:00, nothing deferred", () => {
    const a = job();
    const plan = planPoolAdmission([a], [], night, 5);
    expect(plan.admit).toEqual([a.jobId]);
    expect(plan).not.toHaveProperty("defer");
  });
  it("his caps still hold at night: an offer already sent to him today refuses", () => {
    const sentToday: OfferLedgerEntry = { orgId: "club-b", at: londonDateTimeToUtc("2026-10-28", "00:30"), outcome: null, resolvedAt: null };
    const a = job({ ledger: [sentToday] });
    expect(planPoolAdmission([a], [], night, 5).cancel).toEqual([{ jobId: a.jobId, offerId: a.offerId, reason: "day-cap" }]);
  });
  it("a switch-off still cancels at night", () => {
    const j = job({ clubOpen: false });
    expect(planPoolAdmission([j], [], night, 5).cancel).toHaveLength(1);
  });
});

describe("the general DM opt-out (decision L6.10): a person who opted out of MatchTime DMs gets no pool offer", () => {
  it("an opted-out person's offer is cancelled at admission, never sent, counted against nobody", () => {
    const jobs = [job({ dmOptedOut: true }), job()];
    const plan = planPoolAdmission(jobs, [], NOW, 10);
    expect(plan.cancel).toEqual([{ jobId: jobs[0].jobId, offerId: jobs[0].offerId, reason: "opted-out" }]);
    expect(plan.admit).toEqual([jobs[1].jobId]);
  });
});

describe("optedOutOfDms", () => {
  const all = (on: boolean, at: Date | null = new Date(NOW.getTime() - 3 * 24 * 3600_000)) => ({
    subMatchInviteDm: on,
    subBenchOfferDm: on,
    subTentativeDm: on,
    subRatingDm: on,
    subReminderDm: on,
    subPrefsUpdatedAt: at,
  });
  it("no club, or every category on: not opted out", () => {
    expect(optedOutOfDms({ memberships: [], poolConsentAt: null })).toBe(false);
    expect(optedOutOfDms({ memberships: [all(true)], poolConsentAt: null })).toBe(false);
  });
  it("only ratings off is not the general opt-out", () => {
    expect(optedOutOfDms({ memberships: [{ ...all(true), subRatingDm: false }], poolConsentAt: null })).toBe(false);
  });
  it("every category off on a live membership: opted out", () => {
    expect(optedOutOfDms({ memberships: [all(true), all(false)], poolConsentAt: new Date(NOW.getTime() - 9 * 24 * 3600_000) })).toBe(true);
  });
  it("a fresh pool consent AFTER the opt-out (Start again on the manage page) is his newer word", () => {
    expect(optedOutOfDms({ memberships: [all(false)], poolConsentAt: NOW })).toBe(false);
    expect(optedOutOfDms({ memberships: [all(false, null)], poolConsentAt: NOW })).toBe(true);
  });
});
