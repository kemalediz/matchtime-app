/**
 * `clubSnapshotOf` (club summary, slice A2): a `club` question's setup from
 * the club summary, the values `loadClubSnapshot` read before it was deleted.
 */
import { describe, expect, it } from "vitest";
import { buildClubSummary } from "../../club-summary/derive";
import { FNF, NOW, SUTTON, activity, match } from "../../club-summary/__tests__/fixtures";
import { clubSnapshotOf } from "../club-snapshot";

const sutton = buildClubSummary(SUTTON, NOW);

describe("clubSnapshotOf", () => {
  it("the collector's name, the game's fee when the match has none, and Teams ready", () => {
    expect(clubSnapshotOf(sutton, "m-sutton-10nov")).toEqual({ collectorName: "Kemal", feePerPlayer: 6, feeSplitTotal: false, teamsReady: sutton.routine.teamsReady });
  });

  it("the match's own fee wins over its game's", () => {
    expect(clubSnapshotOf(sutton, "m-sutton-3nov").feePerPlayer).toBe(6);
    const own = buildClubSummary(
      { ...SUTTON, matches: [match({ id: "m-own", activityId: "a-sutton-7", date: new Date("2026-11-10T21:30:00Z"), maxPlayers: 14, feePerPlayer: 7.5 })] },
      NOW,
    );
    expect(clubSnapshotOf(own, "m-own").feePerPlayer).toBe(7.5);
  });

  it("the split-the-total switch is the match's game's", () => {
    const split = buildClubSummary({ ...FNF, activities: [activity({ ...FNF.activities[0], feeSplitTotal: true, feePerPlayer: 80 })] }, NOW);
    expect(clubSnapshotOf(split, "m-fnf-6nov")).toMatchObject({ feePerPlayer: 80, feeSplitTotal: true });
  });

  it("no match: no fee, no split; no collector: null", () => {
    expect(clubSnapshotOf(buildClubSummary(FNF, NOW), null)).toEqual({ collectorName: null, feePerPlayer: null, feeSplitTotal: false, teamsReady: "10:00" });
  });
});
