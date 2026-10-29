/**
 * PR #464 review (2026-10-29): a week called off IN ADVANCE for a "4 only"
 * regular, and a commitment set after a called-off week was credited.
 * Only games already PLAYED count towards the free weeks, and a credit a
 * week no longer earns is taken back the way a game back on takes it.
 */
import { describe, expect, it } from "vitest";
import { loadCommitmentStates } from "../month-member-commitment";
import { decideCancelledWeekCredits } from "../month-close-rules";
import { carryFromMonthStart, chargedGames, isBreakMonth } from "../squad-month-rules";

const fixture = { orgId: "o", venue: "V", dayOfWeek: 1 };
// Vets MNF, November 2026: five Mondays.
const mondays = ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"].map((d) => new Date(`${d}T20:00:00Z`));

function fakeClient(rows: Array<{ id: string; date: Date; status: string; att: string | null }>) {
  return {
    match: {
      findMany: async () =>
        rows.map((r) => ({
          id: r.id,
          date: r.date,
          status: r.status,
          activity: { ...fixture },
          attendances: r.att ? [{ userId: "u4", status: r.att }] : [],
        })),
    },
  } as never;
}

const month = {
  orgId: "o",
  fixture,
  monthStart: "2026-11-01",
  startsAt: new Date("2026-11-01T00:00:00Z"),
  gamesPlayedBeforeStart: 0,
  members: [{ userId: "u4", gamesCovered: 5, gamesCommitted: 4, joinedAt: new Date("2026-10-28T12:00:00Z"), source: "seed-list" }],
};

describe("PR #464 review: a week called off IN ADVANCE, for a 4 only regular", () => {
  it("A: weeks still to come are not misses, so week 3 called off in advance is the free week", async () => {
    // 1 Nov: weeks 1 and 2 still to come (no rows yet), week 3 already called off.
    const states = await loadCommitmentStates(
      fakeClient([
        { id: "w1", date: mondays[0], status: "UPCOMING", att: null },
        { id: "w2", date: mondays[1], status: "UPCOMING", att: null },
        { id: "w3", date: mondays[2], status: "CANCELLED", att: null },
        { id: "w4", date: mondays[3], status: "UPCOMING", att: null },
        { id: "w5", date: mondays[4], status: "UPCOMING", att: null },
      ]),
      month,
      new Date("2026-11-01T12:00:00Z"),
    );
    // Expected (rule: the first miss is the free one): unknown yet, so no credit.
    // Actual: weeks 1 and 2 are counted as misses => freeMiss false => credit written.
    expect(states.get("u4")!.get("w3")!.freeMiss).toBe(true);
  });

  it("B: week 3 now the free week: a credit written for it earlier is taken back", () => {
    const plan = decideCancelledWeekCredits({
      cancelled: true,
      matchDate: mondays[2],
      monthId: "m",
      members: [{ userId: "u4", regular: true, inClub: true, paid: "none", joinedAt: new Date("2026-10-28T12:00:00Z"), freeMiss: true }],
      existing: [{ id: "c1", userId: "u4", reason: "cancelled-week", voidedAt: null, voidedById: null, appliedMonthId: "m", createdById: null }],
    });
    // He plays 1, 2, 4, 5 (four games, all he committed to) and is charged
    // 4 x £7.50 - 1 credit = £22.50: £7.50 short. The stale credit stands.
    expect(plan.voidIds).toContain("c1");
  });
});

describe("PR #464 review: the setter allows a commitment AFTER a called-off week already credited", () => {
  it("C: 4 only set after week 1 was called off and credited: the credit is taken back", () => {
    const plan = decideCancelledWeekCredits({
      cancelled: true,
      matchDate: mondays[0],
      monthId: "m",
      members: [{ userId: "u4", regular: true, inClub: true, paid: "none", joinedAt: new Date("2026-10-28T12:00:00Z"), freeMiss: true }],
      existing: [{ id: "c1", userId: "u4", reason: "cancelled-week", voidedAt: null, voidedById: null, appliedMonthId: "m", createdById: null }],
    });
    expect(plan.voidIds.length + plan.release.length).toBeGreaterThan(0);
  });
});

describe("sanity (expected to pass)", () => {
  it("chargedGames and the break carry-over", () => {
    expect(chargedGames({ gamesCovered: 5, gamesCommitted: 4 })).toBe(4);
    expect(chargedGames({ gamesCovered: 3, gamesCommitted: 4 })).toBe(3);
    expect(chargedGames({ gamesCovered: 5, gamesCommitted: null })).toBe(5);
    expect(carryFromMonthStart("2027-01-01", ["2026-12"])).toBe("2026-11-01");
    expect(isBreakMonth(["2026-12"], "2026-12-01")).toBe(true);
  });
});

import { freezePaidAmount } from "../month-member-games";

describe("PR #464 review: changing the games of somebody who said paid keeps what they paid", () => {
  const base = { amountDuePence: 3750, paidAt: null, paidAmountPence: null, paidClaimedAt: null, paidClaimedAmountPence: null };
  it("a bare 'paid' claim is written down at what they were asked, before the amount changes", () => {
    expect(freezePaidAmount({ ...base, paidClaimedAt: new Date() })).toEqual({ paidClaimedAmountPence: 3750 });
  });
  it("a confirmed payment with no amount too", () => {
    expect(freezePaidAmount({ ...base, paidAt: new Date() })).toEqual({ paidAmountPence: 3750 });
  });
  it("an amount already written down, or nobody paid, is left alone", () => {
    expect(freezePaidAmount({ ...base, paidClaimedAt: new Date(), paidClaimedAmountPence: 2250 })).toEqual({});
    expect(freezePaidAmount(base)).toEqual({});
    expect(freezePaidAmount({ ...base, amountDuePence: null, paidClaimedAt: new Date() })).toEqual({});
  });
});

import { decideMissedCredits } from "../monthly-week-rules";

describe("PR #464 review, round 2: a missed credit already used against another month, then 4 only set", () => {
  const member = { userId: "u4", name: "Smiler", kind: "regular" as const, slot: 7, paid: "claimed" as const, absent: false, paygDated: false, freeMiss: true };
  const rows = [{ userId: "u4", name: "Smiler", status: "DROPPED" as const, position: 7 }];
  it("is handed back there, as a called-off week's is, so the share is not gained twice", () => {
    const res = decideMissedCredits({
      rule: "any-miss",
      members: [member],
      rows,
      maxPlayers: 10,
      existing: [{ id: "c9", userId: "u4", voidedAt: null, voidedById: null, appliedMonthId: "m-dec", createdById: null }],
    });
    expect(res.create).toEqual([]);
    expect(res.releaseElsewhere).toEqual([{ creditId: "c9", userId: "u4", monthId: "m-dec" }]);
  });
  it("a regular who plays after all keeps a credit already used, as before", () => {
    const res = decideMissedCredits({
      rule: "any-miss",
      members: [{ ...member, freeMiss: undefined }],
      rows: [{ ...rows[0], status: "CONFIRMED" as const }],
      maxPlayers: 10,
      existing: [{ id: "c9", userId: "u4", voidedAt: null, voidedById: null, appliedMonthId: "m-dec", createdById: null }],
    });
    expect(res.voidIds).toEqual([]);
    expect(res.releaseElsewhere).toEqual([]);
  });
});

import { renderPricedList } from "../month-payment";
import { monthKickoffs } from "../month-signup-rules";

describe("PR #464 review, round 2: the priced list's games note", () => {
  const kickoffs = monthKickoffs("2026-11-01", 1, "20:30");
  const member = (userId: string, name: string, slot: number, over: object) => ({
    userId, name, kind: "regular" as const, slot, waiting: false, out: false, paid: "none" as const, paygMatchIds: [],
    tier: "standard", gamesCovered: 5, gamesCommitted: null, creditsApplied: 0, amountDuePence: 3750, paidClaimedAt: null, paidPence: null, ...over,
  });
  const month = {
    id: "m", orgId: "o", activityId: "a", activityName: "Monday", monthStart: "2026-11-01", monthNumber: 11, status: "priced", open: false,
    listOpenedAt: null, kickoffs, startedMidMonth: false, firstKickoff: kickoffs[0], endsAt: null, maxRegulars: 3,
    fixture: { orgId: "o", venue: "V", dayOfWeek: 1 }, matches: [],
    members: [
      member("u1", "Smiler", 1, { gamesCommitted: 4, amountDuePence: 3000 }),
      member("u2", "Late Joiner", 2, { gamesCovered: 3, amountDuePence: 2250 }),
      member("u3", "Dan", 3, {}),
    ],
    sharePerGamePence: 750, concessionPerGamePence: null, venueCostPence: null, payByAt: new Date("2026-10-30T21:00:00Z"),
    pricedAt: new Date(), summarySentAt: null, carriedFrom: null, language: "en",
  };
  it("shows the games only for a regular who committed to fewer", () => {
    const text = renderPricedList(month as never, { collectorName: null, instructions: null })!;
    expect(text).toContain("1. Smiler (£30, 4 games)");
    expect(text).toContain("2. Late Joiner (£22.50)\n");
    expect(text).toContain("3. Dan (£37.50)");
  });
});
