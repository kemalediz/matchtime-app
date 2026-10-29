/**
 * The offer's facts, loaded (slice L5a): club and game facts only; the
 * fee rule ("free" only when the club takes no fee at all); counts, never
 * names.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  match: { findUnique: vi.fn(), count: vi.fn() },
  membership: { count: vi.fn() },
}));
vi.mock("../../db", () => ({ db: dbMock }));
vi.mock("../../partner-ask", () => ({ feeLabel: (p: number | null) => (p && p > 0 ? `£${p}` : null) }));

import { loadMatchOfferFacts, poolFeeOf } from "../offer-facts";

describe("poolFeeOf", () => {
  it("the match's fee, else the activity's", () => {
    expect(poolFeeOf({ matchFee: 7, activityFee: 6, feeSplitTotal: false, paymentsOn: true })).toEqual({ kind: "amount", amount: "£7" });
    expect(poolFeeOf({ matchFee: null, activityFee: 6, feeSplitTotal: false, paymentsOn: true })).toEqual({ kind: "amount", amount: "£6" });
  });
  it("a monthly club's week: the club's PAYG price (a pool guest pays per game there), unless the match has its own fee", () => {
    expect(poolFeeOf({ matchFee: null, activityFee: 6, feeSplitTotal: false, paymentsOn: true, monthlyPaygPence: 800 })).toEqual({ kind: "amount", amount: "£8" });
    expect(poolFeeOf({ matchFee: null, activityFee: 60, feeSplitTotal: true, paymentsOn: true, monthlyPaygPence: 800 })).toEqual({ kind: "amount", amount: "£8" });
    expect(poolFeeOf({ matchFee: 7, activityFee: 6, feeSplitTotal: false, paymentsOn: true, monthlyPaygPence: 800 })).toEqual({ kind: "amount", amount: "£7" });
  });
  it("a split total is not a per-player fee: unknown, the line is left out", () => {
    expect(poolFeeOf({ matchFee: null, activityFee: 60, feeSplitTotal: true, paymentsOn: false })).toBeNull();
  });
  it("free only when there is no fee and payments are off", () => {
    expect(poolFeeOf({ matchFee: null, activityFee: null, feeSplitTotal: false, paymentsOn: false })).toEqual({ kind: "free" });
    expect(poolFeeOf({ matchFee: null, activityFee: null, feeSplitTotal: false, paymentsOn: true })).toBeNull();
  });
});

describe("loadMatchOfferFacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.match.findUnique.mockResolvedValue({
      date: new Date("2026-10-30T20:30:00Z"),
      feePerPlayer: null,
      activity: {
        orgId: "fnf",
        venue: "Goals (typed)",
        matchDurationMins: 60,
        feePerPlayer: 6,
        feeSplitTotal: false,
        sport: { preset: "football-7aside", name: "Football 7-a-side", playersPerTeam: 7 },
        venueRef: { name: "Goals North Cheam", formattedAddress: "Cheam Common Rd", lat: 51.37, lng: -0.23, placeId: "pid" },
        org: { name: "FNF", language: "en", playStyle: "casual", paymentCollectionEnabled: true, paymentTrackingEnabled: false },
      },
    });
    dbMock.membership.count.mockResolvedValue(30);
    dbMock.match.count.mockResolvedValue(8);
  });

  it("maps the club and game, guests never counted as members", async () => {
    const f = await loadMatchOfferFacts("m1", new Date("2026-10-27T12:00:00Z"));
    expect(f).toMatchObject({
      club: "FNF",
      sport: "football",
      format: 7,
      venueName: "Goals North Cheam",
      address: "Cheam Common Rd",
      playStyle: "casual",
      members: 30,
      gamesLast8Weeks: 8,
      fee: { kind: "amount", amount: "£6" },
      durationMins: 60,
    });
    expect(f?.mapUrl).toContain("query=51.37%2C-0.23");
    expect(dbMock.membership.count).toHaveBeenCalledWith({ where: { orgId: "fnf", leftAt: null, guestMatchId: null } });
  });

  it("no linked venue: the activity's own text, no address or map; an unknown style is left out", async () => {
    const m = await dbMock.match.findUnique();
    dbMock.match.findUnique.mockResolvedValue({ ...m, activity: { ...m.activity, venueRef: null, org: { ...m.activity.org, playStyle: "weird" } } });
    const f = await loadMatchOfferFacts("m1");
    expect(f).toMatchObject({ venueName: "Goals (typed)", address: null, mapUrl: null, playStyle: null });
  });
});
