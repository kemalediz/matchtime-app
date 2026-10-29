/**
 * PR #464 review, round 3 (2026-10-29): the low items.
 *   1. a "4 only" free week hands back a used credit only when they MISSED it;
 *   2. a credit used against a CLOSED month is settled there (frozen): no
 *      endless retry, and not counted as taken back;
 *   3. a game called off again after a bare "paid": the new credit comes off
 *      what they owe this month while they owe more than a game;
 *   4. the second nudge never within 12 hours of the first notice.
 */
import { describe, expect, it } from "vitest";
import { commitmentForMatch, decideMissedCredits } from "../monthly-week-rules";
import { cancelledCreditAppliesNow, freezePaidAmount, liveReleases } from "../month-close-rules";
import { heldNudgeDue } from "../month-signup-rules";

const member = (over: object = {}) =>
  ({ userId: "u", name: "A", kind: "regular", slot: 1, paid: "claimed", absent: false, paygDated: false, freeMiss: true, ...over }) as never;
const used = [{ id: "c", userId: "u", voidedAt: null, voidedById: null, appliedMonthId: "m-next", createdById: null }];

describe("1. a free week's used credit", () => {
  it("played after all: the used credit is kept, as for any regular", () => {
    const res = decideMissedCredits({ rule: "any-miss", members: [member()], rows: [{ userId: "u", name: "A", status: "CONFIRMED", position: 1 }], maxPlayers: 10, existing: used });
    expect(res.releaseElsewhere).toEqual([]);
  });
  it("played after all, rule none: kept too", () => {
    const res = decideMissedCredits({ rule: "none", members: [member()], rows: [{ userId: "u", name: "A", status: "CONFIRMED", position: 1 }], maxPlayers: 10, existing: used });
    expect(res.releaseElsewhere).toEqual([]);
  });
  it("missed it (whatever the rule): handed back", () => {
    for (const rule of ["any-miss", "none"] as const) {
      const res = decideMissedCredits({ rule, members: [member({ paid: "none" })], rows: [{ userId: "u", name: "A", status: "DROPPED", position: 1 }], maxPlayers: 10, existing: used });
      expect(res.releaseElsewhere).toEqual([{ creditId: "c", userId: "u", monthId: "m-next" }]);
    }
  });
  it("freeMiss flips true when the commitment is lowered after the fact", () => {
    expect(commitmentForMatch({ gamesCovered: 5, gamesCommitted: null, playedBefore: 0, earlier: [true] }).freeMiss).toBe(false);
    expect(commitmentForMatch({ gamesCovered: 5, gamesCommitted: 4, playedBefore: 0, earlier: [true] }).freeMiss).toBe(true);
  });
});

describe("2. a release against a closed month", () => {
  it("is settled there: dropped from what is retried", () => {
    const rel = [
      { creditId: "a", userId: "u", monthId: "m-oct" },
      { creditId: "b", userId: "u", monthId: "m-dec" },
    ];
    expect(liveReleases(rel, new Set(["m-oct"]))).toEqual([{ creditId: "b", userId: "u", monthId: "m-dec" }]);
  });
});

describe("3. called off again after a bare paid", () => {
  it("owing more than a game: the credit comes off now", () => {
    // Restored: asked £20, paid £15 (frozen). Off again: £15 is right.
    expect(cancelledCreditAppliesNow({ paid: "claimed", amountDuePence: 2000, paidPence: 1500, sharePence: 500 })).toBe(true);
  });
  it("paid in full: kept for a later month, as before", () => {
    expect(cancelledCreditAppliesNow({ paid: "claimed", amountDuePence: 2000, paidPence: 2000, sharePence: 500 })).toBe(false);
    expect(cancelledCreditAppliesNow({ paid: "confirmed", amountDuePence: 2000, paidPence: null, sharePence: 500 })).toBe(false);
  });
  it("not paid: off now, as before", () => {
    expect(cancelledCreditAppliesNow({ paid: "none", amountDuePence: 2000, paidPence: null, sharePence: 500 })).toBe(true);
  });
  it("freeze is idempotent across restore, cancel, restore", () => {
    const r = { amountDuePence: 1500, paidAt: new Date(), paidAmountPence: null, paidClaimedAt: null, paidClaimedAmountPence: null };
    const f1 = freezePaidAmount(r);
    expect(f1).toEqual({ paidAmountPence: 1500 });
    expect(freezePaidAmount({ ...r, ...f1, amountDuePence: 2000 })).toEqual({});
  });
});

describe("4. the second nudge", () => {
  const kickoff = new Date("2026-11-02T20:30:00Z");
  it("the day before the first game, at least 12 hours after the first notice", () => {
    expect(heldNudgeDue({ now: new Date("2026-11-01T21:00:00Z"), firstKickoff: kickoff, firstNoticeAt: new Date("2026-10-26T10:00:00Z") })).toBe(true);
  });
  it("never within 12 hours of the first notice", () => {
    expect(heldNudgeDue({ now: new Date("2026-11-02T10:00:00Z"), firstKickoff: kickoff, firstNoticeAt: new Date("2026-11-02T09:00:00Z") })).toBe(false);
  });
  it("never more than a day before the game", () => {
    expect(heldNudgeDue({ now: new Date("2026-10-31T12:00:00Z"), firstKickoff: kickoff, firstNoticeAt: new Date("2026-10-26T10:00:00Z") })).toBe(false);
  });
});
