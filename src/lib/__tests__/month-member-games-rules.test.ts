/**
 * "4 only" (2026-10-29, Vets MNF): a regular who commits to fewer games
 * than the month has pays for those games only. The pure money rules.
 * Every name is made up.
 */
import { describe, it, expect } from "vitest";
import { amountDuePence, chargedGames, checkGamesCommitted } from "../squad-month-rules";
import { planPricing, type PricingMember } from "../month-payment-rules";

describe("chargedGames", () => {
  it("is every game covered when nothing was committed", () => {
    expect(chargedGames({ gamesCovered: 5, gamesCommitted: null })).toBe(5);
    expect(chargedGames({ gamesCovered: 5 })).toBe(5);
  });
  it("is the committed count when it is fewer", () => {
    expect(chargedGames({ gamesCovered: 5, gamesCommitted: 4 })).toBe(4);
  });
  it("never more than covered: a late joiner covering 3 who said 4 pays for 3", () => {
    expect(chargedGames({ gamesCovered: 3, gamesCommitted: 4 })).toBe(3);
  });
});

describe("checkGamesCommitted", () => {
  it("NULL is every game", () => {
    expect(checkGamesCommitted(null, 5)).toEqual({ ok: true, value: null });
  });
  it("a count equal to the games covered is stored as every game", () => {
    expect(checkGamesCommitted(5, 5)).toEqual({ ok: true, value: null });
  });
  it("accepts 1 to the games covered", () => {
    expect(checkGamesCommitted(4, 5)).toEqual({ ok: true, value: 4 });
    expect(checkGamesCommitted(1, 5)).toEqual({ ok: true, value: 1 });
  });
  it("refuses more games than the month has", () => {
    expect(checkGamesCommitted(6, 5)).toEqual({ ok: false, error: "more-than-the-month" });
  });
  it("refuses anything that is not a whole number from 1", () => {
    for (const v of [0, -1, 2.5, "4", NaN, 11]) expect(checkGamesCommitted(v, 10).ok).toBe(false);
  });
});

describe("what a 4 only regular owes", () => {
  it("£7.50 a game, 4 of 5 Mondays: £30", () => {
    expect(amountDuePence({ sharePence: 750, gamesCovered: 5, gamesCommitted: 4, creditsApplied: 0 })).toBe(3000);
  });
  it("credits come off the committed games: 4 only with one credit is £22.50", () => {
    expect(amountDuePence({ sharePence: 750, gamesCovered: 5, gamesCommitted: 4, creditsApplied: 1 })).toBe(2250);
  });
  it("pricing takes no more credits than the committed games", () => {
    const m: PricingMember = { userId: "u1", kind: "regular", tier: "standard", waiting: false, out: false, gamesCovered: chargedGames({ gamesCovered: 5, gamesCommitted: 2 }), creditsApplied: 0, paid: "none" };
    const credits = [1, 2, 3].map((i) => ({ id: `c${i}`, userId: "u1", createdAt: new Date(2026, 9, i) }));
    const [row] = planPricing({ members: [m], credits, sharePence: 750, concessionPence: null });
    expect(row.creditIds).toEqual(["c1", "c2"]);
    expect(row.amountDuePence).toBe(0);
  });
});
