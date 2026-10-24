/**
 * Admitting pool offers at DISPATCH (slice L5a; the design is L4's
 * caps.ts header): planning may overbook, dispatch never does. Under one
 * lock, each poll counts what went, admits at most the room, re-checks
 * each person's caps, every switch and the offer's own state, and holds
 * the rest (never drops them). Quiet hours defer.
 */
import { describe, expect, it } from "vitest";
import { londonDateTimeToUtc } from "../../london-time";
import { POOL_PLATFORM_CAPS, type OfferLedgerEntry } from "../caps";
import { planPoolAdmission, type PoolJobView } from "../dispatch-rules";

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
    admitted: false,
    clubOpen: true,
    profileActive: true,
    offerOpen: true,
    askOpen: true,
    ledger: [],
    ...over,
  };
};

describe("room: at most the platform caps, oldest first, the rest held", () => {
  it("admits up to the room and holds the rest", () => {
    const sentAts = Array.from({ length: POOL_PLATFORM_CAPS.perHour - 2 }, (_, i) => new Date(NOW.getTime() - (i + 1) * MIN));
    const jobs = [job(), job(), job(), job()];
    const plan = planPoolAdmission(jobs, sentAts, NOW, 10);
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
    const sentAts = Array.from({ length: POOL_PLATFORM_CAPS.perHour - 1 }, (_, i) => new Date(NOW.getTime() - (i + 1) * MIN));
    const a = planPoolAdmission([job()], sentAts, NOW, 5);
    expect(a.admit).toHaveLength(1);
    // The first claimer's stamp is committed before the second counts.
    const b = planPoolAdmission([job()], [...sentAts, NOW], NOW, 5);
    expect(b.admit).toEqual([]);
    expect(b.hold).toHaveLength(1);
  });

  it("an offer admitted already (released by the Pi's pacing) passes without using room", () => {
    const full = Array.from({ length: POOL_PLATFORM_CAPS.perHour }, (_, i) => new Date(NOW.getTime() - (i + 1) * MIN));
    const again = job({ admitted: true });
    expect(planPoolAdmission([again], full, NOW, 5).admit).toEqual([again.jobId]);
  });
});

describe("re-checked at send time: switches, the offer, the person", () => {
  const cases: Array<[string, Partial<PoolJobView>, string]> = [
    ["the switch or the club's flag went off", { clubOpen: false }, "switched-off"],
    ["he paused or stopped meanwhile", { profileActive: false }, "profile-off"],
    ["the offer was answered or ended", { offerOpen: false }, "closed"],
    ["the round closed (filled, cut-off, cancelled)", { askOpen: false }, "closed"],
  ];
  for (const [name, over, reason] of cases) {
    it(`${name}: cancelled, never sent`, () => {
      const j = job(over);
      const plan = planPoolAdmission([j], [], NOW, 5);
      expect(plan.cancel).toEqual([{ jobId: j.jobId, offerId: j.offerId, reason }]);
      expect(plan.admit).toEqual([]);
    });
  }
  it("a switch off cancels even an offer already admitted", () => {
    const j = job({ admitted: true, clubOpen: false });
    expect(planPoolAdmission([j], [], NOW, 5).cancel).toHaveLength(1);
  });

  it("his caps, judged now with what went meanwhile (another club's offer today)", () => {
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

describe("quiet hours: deferred to 08:30, never dropped", () => {
  it("at 21:45 every job waits for 08:30, an admitted one re-counts then", () => {
    const late = londonDateTimeToUtc("2026-10-27", "21:45");
    const fresh = job();
    const released = job({ admitted: true });
    const plan = planPoolAdmission([fresh, released], [], late, 5);
    const until = londonDateTimeToUtc("2026-10-28", "08:30");
    expect(plan.defer).toEqual([
      { jobId: fresh.jobId, offerId: fresh.offerId, until, unadmit: false },
      { jobId: released.jobId, offerId: released.offerId, until, unadmit: true },
    ]);
    expect(plan.admit).toEqual([]);
  });
  it("the autumn clock change night: 21:45 BST on Sat 24 Oct waits for 08:30 GMT on Sun 25 Oct", () => {
    const plan = planPoolAdmission([job()], [], new Date("2026-10-24T20:45:00Z"), 5);
    expect(plan.defer[0].until).toEqual(new Date("2026-10-25T08:30:00Z"));
  });
  it("a switch-off still cancels in quiet hours", () => {
    const j = job({ clubOpen: false });
    expect(planPoolAdmission([j], [], londonDateTimeToUtc("2026-10-27", "23:00"), 5).cancel).toHaveLength(1);
  });
});
