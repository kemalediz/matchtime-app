/**
 * ONE FEE (club summary, slice B5; decision K3, Kemal 2026-11-04).
 *
 * Before B5 "the fee" meant five things (plan D9): the DM answer told the
 * model the match's fee else the game's, the group's club answer the same,
 * the pay page "No fee set yet" without the match's own fee, a guest ask
 * the match's fee, then the PAYG price, then the game's unless split.
 * `feeFact` is the one definition every door reads now.
 *
 * K3: before the collector confirms a match's fee, a player who asks is
 * told the usual fee marked as not confirmed yet; once confirmed, the
 * confirmed fee. Charging still uses only a confirmed fee.
 */
import { describe, expect, it } from "vitest";
import { chargeableFee, feeFact, type FeeInputs } from "../fee-fact";

const base: FeeInputs = { matchFee: null, gameFee: null, splitTotal: false, paygPence: null, collection: false };

describe("feeFact: the fee a player is told, and whether it is confirmed", () => {
  it("the collector's confirmed fee for this match wins over everything", () => {
    const f = feeFact({ ...base, matchFee: 6, gameFee: 5, paygPence: 800, collection: true });
    expect(f).toEqual({ amount: 6, source: "match", confirmed: true, notConfirmedYet: false, splitTotal: false });
  });

  it("before the collector confirms, a club that collects is told the game's usual fee, marked not confirmed yet (K3)", () => {
    const f = feeFact({ ...base, gameFee: 5, collection: true });
    expect(f).toEqual({ amount: 5, source: "game", confirmed: false, notConfirmedYet: true, splitTotal: false });
  });

  it("in a week of a running month the usual fee is the club's pay as you go price (what the collector is then asked to confirm)", () => {
    expect(feeFact({ ...base, gameFee: 6, paygPence: 800, collection: true })).toEqual({
      amount: 8,
      source: "payg",
      confirmed: false,
      notConfirmedYet: true,
      splitTotal: false,
    });
    // A split game has no per-player fee, but the PAYG price is one.
    expect(feeFact({ ...base, gameFee: 60, splitTotal: true, paygPence: 750 }).amount).toBe(7.5);
  });

  it("a club that does not collect through MatchTime has nothing to confirm: its usual fee is stated as it is", () => {
    expect(feeFact({ ...base, gameFee: 5 })).toEqual({ amount: 5, source: "game", confirmed: false, notConfirmedYet: false, splitTotal: false });
    expect(feeFact({ ...base, paygPence: 800 })).toMatchObject({ amount: 8, source: "payg", notConfirmedYet: false });
  });

  it("a split total is not a per-player fee: no amount until the collector enters the total", () => {
    expect(feeFact({ ...base, gameFee: 60, splitTotal: true, collection: true })).toEqual({
      amount: null,
      source: null,
      confirmed: false,
      notConfirmedYet: false,
      splitTotal: true,
    });
    // Once the collector has entered it, the match carries a per-player fee.
    expect(feeFact({ ...base, matchFee: 4.5, gameFee: 60, splitTotal: true, collection: true })).toMatchObject({ amount: 4.5, confirmed: true });
  });

  it("no fee anywhere: no amount, nothing to mark", () => {
    expect(feeFact(base)).toEqual({ amount: null, source: null, confirmed: false, notConfirmedYet: false, splitTotal: false });
  });
});

describe("chargeableFee: only a confirmed fee is ever charged (K3)", () => {
  it("is the confirmed fee, and null for a usual one", () => {
    expect(chargeableFee(feeFact({ ...base, matchFee: 6, collection: true }))).toBe(6);
    expect(chargeableFee(feeFact({ ...base, gameFee: 5, collection: true }))).toBeNull();
    expect(chargeableFee(feeFact({ ...base, paygPence: 800, collection: true }))).toBeNull();
    expect(chargeableFee(feeFact(base))).toBeNull();
  });
});
