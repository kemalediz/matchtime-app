/**
 * `clubSnapshotOf` (club summary, slice A2): a `club` question's setup from
 * the club summary, the values `loadClubSnapshot` read before it was deleted.
 * Since slice B5 the fee is the match's one fee fact (fee-fact.ts,
 * decision K3), the summary's `fee.forPlayers`.
 */
import { describe, expect, it } from "vitest";
import { buildClubSummary } from "../../club-summary/derive";
import { FNF, NOW, SUTTON, VETS, activity, match } from "../../club-summary/__tests__/fixtures";
import { clubSnapshotOf } from "../club-snapshot";

const sutton = buildClubSummary(SUTTON, NOW);
const NO_FEE = { amount: null, source: null, confirmed: false, notConfirmedYet: false, splitTotal: false };

describe("clubSnapshotOf", () => {
  it("the collector's name, the game's usual fee marked not confirmed yet (Sutton collects), and Teams ready", () => {
    expect(clubSnapshotOf(sutton, "m-sutton-10nov")).toEqual({
      collectorName: "Kemal",
      fee: { amount: 6, source: "game", confirmed: false, notConfirmedYet: true, splitTotal: false },
      teamsReady: sutton.routine.teamsReady,
    });
  });

  it("the match's own confirmed fee wins over its game's", () => {
    expect(clubSnapshotOf(sutton, "m-sutton-3nov").fee).toMatchObject({ amount: 6, source: "match", confirmed: true });
    const own = buildClubSummary(
      { ...SUTTON, matches: [match({ id: "m-own", activityId: "a-sutton-7", date: new Date("2026-11-10T21:30:00Z"), maxPlayers: 14, feePerPlayer: 7.5 })] },
      NOW,
    );
    expect(clubSnapshotOf(own, "m-own").fee).toMatchObject({ amount: 7.5, confirmed: true, notConfirmedYet: false });
  });

  it("a game that splits the total has no per-player fee (B5: it said the game's fee before)", () => {
    const split = buildClubSummary({ ...FNF, activities: [activity({ ...FNF.activities[0], feeSplitTotal: true, feePerPlayer: 80 })] }, NOW);
    expect(clubSnapshotOf(split, "m-fnf-6nov").fee).toEqual({ ...NO_FEE, splitTotal: true });
  });

  it("a week of a running month: the PAYG price, as a guest ask states it", () => {
    expect(clubSnapshotOf(buildClubSummary(VETS, NOW), "m-vets-9nov").fee).toMatchObject({ amount: 8, source: "payg", notConfirmedYet: false });
  });

  it("no match: no fee; no collector: null", () => {
    expect(clubSnapshotOf(buildClubSummary(FNF, NOW), null)).toEqual({ collectorName: null, fee: NO_FEE, teamsReady: "10:00" });
  });
});
