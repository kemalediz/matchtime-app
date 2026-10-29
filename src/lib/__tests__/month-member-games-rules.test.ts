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

// ── The week: "4 only" in a five-Monday month ──────────────────────────

import { buildWeekList, commitmentForMatch, decideMissedCredits, decideMonthlySeed, SEED_NOTE_COMMITTED, type WeekMember } from "../monthly-week-rules";
import { decideCancelledWeekCredits, decideLeaverCredits } from "../month-close-rules";
import { planMonthSeed } from "../squad-month-rules";

const four = (earlier: boolean[], playedBefore = 0) =>
  commitmentForMatch({ gamesCovered: 5, gamesCommitted: 4, playedBefore, earlier });

describe("commitmentForMatch (4 of 5 Mondays)", () => {
  it("no commitment: never extra, every miss counts as today", () => {
    expect(commitmentForMatch({ gamesCovered: 5, gamesCommitted: null, playedBefore: 0, earlier: [true, true, true, true] })).toEqual({ extra: false, freeMiss: false });
  });
  it("week 1: playing as usual, and a miss there is the free week", () => {
    expect(four([])).toEqual({ extra: false, freeMiss: true });
  });
  it("played the first four: the fifth is an away week with no credit", () => {
    expect(four([true, true, true, true])).toEqual({ extra: true, freeMiss: true });
  });
  it("missed week 1 (the free week): a second miss earns a credit", () => {
    expect(four([false])).toEqual({ extra: false, freeMiss: false });
  });
  it("a called-off week uses up the free week first", () => {
    // Week 2 was called off (false): week 3 missed is a paid-for game.
    expect(four([true, false])).toEqual({ extra: false, freeMiss: false });
  });
  it("a mid-month start counts the games already played as played", () => {
    // 2 played before MatchTime, then 2 more: committed games are done.
    expect(four([true, true], 2).extra).toBe(true);
    expect(four([true], 2).extra).toBe(false);
  });
});

const reg = (name: string, over: Partial<WeekMember> = {}): WeekMember => ({
  userId: `u-${name}`,
  name,
  kind: "regular",
  slot: 1,
  paid: "claimed",
  absent: false,
  paygDated: false,
  ...over,
});

describe("a 4 only regular in the weekly flow", () => {
  it("past their committed games they are seeded out, and the row is not the month's", () => {
    const d = decideMonthlySeed({ members: [reg("smiler", { absent: true, extra: true, freeMiss: true })], targetRows: [], maxPlayers: 10 });
    expect(d.write).toEqual([{ userId: "u-smiler", status: "DROPPED", position: 1, monthly: false, note: SEED_NOTE_COMMITTED }]);
  });
  it("who then plays the 5th: no monthly mark, so the game is PAYG, and the list shows PAYG", () => {
    const m = reg("smiler", { absent: true, extra: true, freeMiss: true });
    const d = decideMonthlySeed({ members: [m], targetRows: [{ userId: "u-smiler", status: "CONFIRMED", position: 1 }], maxPlayers: 10 });
    expect(d.markMonthly).toEqual([]);
    const list = buildWeekList({ members: [m], rows: [{ userId: "u-smiler", name: "smiler", status: "CONFIRMED", position: 1 }], maxPlayers: 10 });
    expect(list.slots[0].mark).toBe("payg");
  });
  it("the week they never paid for earns no credit; a paid-for miss does", () => {
    const rows = [{ userId: "u-smiler", name: "smiler", status: "DROPPED" as const, position: 1 }];
    expect(decideMissedCredits({ rule: "any-miss", members: [reg("smiler", { freeMiss: true })], rows, maxPlayers: 10, existing: [] }).create).toEqual([]);
    expect(decideMissedCredits({ rule: "any-miss", members: [reg("smiler")], rows, maxPlayers: 10, existing: [] }).create).toEqual(["u-smiler"]);
  });
});

describe("a 4 only regular and a called-off week", () => {
  const base = { cancelled: true, matchDate: new Date("2026-11-09T20:30:00Z"), monthId: "m1", existing: [] };
  const member = (over: object = {}) => ({ userId: "smiler", regular: true, inClub: true, paid: "claimed" as const, joinedAt: new Date("2026-10-27T10:00:00Z"), ...over });
  it("a week they never paid for being called off owes nothing", () => {
    expect(decideCancelledWeekCredits({ ...base, members: [member({ freeMiss: true })] }).create).toEqual([]);
  });
  it("once the free week is used, a called-off week is a credit as for anybody", () => {
    expect(decideCancelledWeekCredits({ ...base, members: [member()] }).create).toEqual([{ userId: "smiler", applyNow: false }]);
  });
});

describe("a 4 only regular who leaves part-way", () => {
  it("is owed no more than the committed games they did not play", () => {
    const games = [1, 2, 3, 4].map((i) => ({ matchId: `g${i}`, date: new Date(Date.UTC(2026, 10, 2 + 7 * i, 20, 30)) }));
    const res = decideLeaverCredits({
      member: { regular: false, offMonth: true, inClub: true, paid: "confirmed" },
      leftAt: new Date("2026-11-03T12:00:00Z"),
      games,
      existing: [],
      creditedMatchIds: new Set(),
      maxGames: 3,
    });
    expect(res.create).toHaveLength(3);
  });
});

describe("starting a month with a 4 only regular", () => {
  const ctx = { memberUserIds: new Set(["u1", "u2"]), actorUserId: "admin", now: new Date("2026-10-29T12:00:00Z") };
  const input = (rows: object[]) => ({ activityId: "a1", gamesScheduled: 5, gamesPlayed: 0, sharePerGamePence: 750, source: "seed-list" as const, rows: rows as never });
  it("is asked for the committed games only", () => {
    const res = planMonthSeed(input([{ userId: "u1", kind: "regular", gamesCommitted: 4 }, { userId: "u2", kind: "regular" }]), ctx);
    if (!res.ok) throw new Error(res.error);
    expect(res.members.map((m) => [m.gamesCommitted, m.amountDuePence])).toEqual([
      [4, 3000],
      [null, 3750],
    ]);
  });
  it("refuses more games than the month has", () => {
    expect(planMonthSeed(input([{ userId: "u1", kind: "regular", gamesCommitted: 6 }]), ctx)).toMatchObject({ ok: false, error: "bad-games-committed" });
  });
  it("credits carried in never exceed the committed games", () => {
    expect(planMonthSeed(input([{ userId: "u1", kind: "regular", gamesCommitted: 2, creditsCarriedIn: 3 }]), ctx)).toMatchObject({ ok: false, error: "bad-credits" });
  });
});
