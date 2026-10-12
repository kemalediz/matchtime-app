/**
 * DOES MATCHTIME ALREADY HAVE A SQUAD TO CARRY OVER? (2026-10-13)
 *
 * The group hello told a newly live rolling club "if you played last
 * time, you're in next time too" when MatchTime had no last time: the
 * first game's list was empty. `hasSquadToCarry` answers with the same
 * rule the seeding uses (`pickSeedSource`, `carryOverExclusion`), so the
 * hello and the 08:00 carry-over can never disagree.
 *
 * AND THE SQUAD MUST BE SUBSTANTIAL (owner decision, 2026-10-13): one
 * player who tapped In on the website before go-live is not "the squad".
 * The standing wording is used only when the players the seeding would
 * carry fill at least HALF of the next game's places (`Match.maxPlayers`,
 * the number the squad-full logic uses). Below that most of the group
 * still has to say In, so the first-game form is used.
 */
import { describe, expect, it } from "vitest";
import { hasSquadToCarry, isSubstantialSquad, type FixtureMatch, type SeedSourceRow } from "../rolling-squad-rules";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-13T12:00:00.000Z");
const FIX = { orgId: "o1", venue: "Pitch", dayOfWeek: 2 };
const OTHER = { orgId: "o1", venue: "Dome", dayOfWeek: 4 };

/** A 10-a-game match unless a case says otherwise. */
const m = (id: string, offsetDays: number, status: string, over: Partial<FixtureMatch> = {}): FixtureMatch => ({
  id,
  date: new Date(NOW.getTime() + offsetDays * DAY),
  status,
  isHistorical: false,
  activity: FIX,
  rollingSeededAt: null,
  maxPlayers: 10,
  ...over,
});

const row = (userId: string, over: Partial<SeedSourceRow> = {}): SeedSourceRow => ({
  userId,
  status: "CONFIRMED",
  position: 1,
  phoneNumber: "+447700900001",
  email: `${userId}@example.invalid`,
  isActive: true,
  membership: { leftAt: null, provisionallyAddedAt: null },
  ...over,
});
/** `n` players the seeding would carry. */
const squad = (n: number, prefix = "p") => Array.from({ length: n }, (_, i) => row(`${prefix}${i}`, { position: i + 1 }));

const rows = (by: Record<string, SeedSourceRow[]>) => new Map(Object.entries(by));
const check = (matches: FixtureMatch[], by: Record<string, SeedSourceRow[]> = {}) =>
  hasSquadToCarry({ matches, rows: rows(by), now: NOW });

const LAST_AND_NEXT = [m("last", -5, "COMPLETED"), m("next", 2, "UPCOMING")];

describe("isSubstantialSquad: at least half of the next game's places", () => {
  const cases: Array<[number, number, boolean]> = [
    [0, 10, false],
    [1, 10, false],
    [4, 10, false],
    [5, 10, true],
    [10, 10, true],
    [14, 10, true],
    // An odd number of places: half of 9 is 4.5, so 4 is under and 5 is over.
    [4, 9, false],
    [5, 9, true],
    [7, 14, true],
    [6, 14, false],
    // No known number of places: never substantial.
    [3, 0, false],
  ];
  for (const [carried, places, want] of cases) {
    it(`${carried} carried of ${places} places: ${want ? "substantial" : "not"}`, () => {
      expect(isSubstantialSquad(carried, places)).toBe(want);
    });
  }
});

describe("hasSquadToCarry", () => {
  it("a new club, one game ahead and nothing played: no", () => {
    expect(check([m("next", 2, "UPCOMING")])).toBe(false);
    expect(check([])).toBe(false);
  });

  it("0, 1, just under half, exactly half, full: the standing wording needs half the next game's places", () => {
    expect(check(LAST_AND_NEXT, { last: squad(0) })).toBe(false);
    expect(check(LAST_AND_NEXT)).toBe(false);
    expect(check(LAST_AND_NEXT, { last: squad(1) })).toBe(false);
    expect(check(LAST_AND_NEXT, { last: squad(4) })).toBe(false);
    expect(check(LAST_AND_NEXT, { last: squad(5) })).toBe(true);
    expect(check(LAST_AND_NEXT, { last: squad(10) })).toBe(true);
  });

  it("the places are the NEXT game's, not the last one's: a bigger format next week needs a bigger squad", () => {
    const bigger = [m("last", -5, "COMPLETED", { maxPlayers: 10 }), m("next", 2, "UPCOMING", { maxPlayers: 14 })];
    expect(check(bigger, { last: squad(6) })).toBe(false);
    expect(check(bigger, { last: squad(7) })).toBe(true);
    const smaller = [m("last", -5, "COMPLETED", { maxPlayers: 14 }), m("next", 2, "UPCOMING", { maxPlayers: 8 })];
    expect(check(smaller, { last: squad(4) })).toBe(true);
  });

  it("only players the seeding would carry count: the bench, a leaver, a deactivated user and a phoneless guest do not", () => {
    const none = [
      row("bench", { status: "BENCH" }),
      row("dropped", { status: "DROPPED" }),
      row("left", { membership: { leftAt: new Date(), provisionallyAddedAt: null } }),
      row("gone", { membership: null }),
      row("off", { isActive: false }),
      row("guest", { phoneNumber: null, email: "provisional+x@example.invalid" }),
    ];
    expect(check(LAST_AND_NEXT, { last: [...none, ...squad(4)] })).toBe(false);
    expect(check(LAST_AND_NEXT, { last: [...none, ...squad(5)] })).toBe(true);
  });

  it("a game that kicked off before now and is still open counts as played, but one website In on it is not a squad", () => {
    const ms = [m("kicked-off", -0.2, "UPCOMING"), m("next", 7, "UPCOMING")];
    expect(check(ms, { "kicked-off": squad(1) })).toBe(false);
    expect(check(ms, { "kicked-off": squad(5) })).toBe(true);
    expect(check(ms, { "kicked-off": [] })).toBe(false);
  });

  it("a cancelled or historical week is never the source; the week before it is", () => {
    const ms = [m("older", -12, "COMPLETED"), m("cancelled", -5, "CANCELLED"), m("next", 2, "UPCOMING")];
    expect(check(ms, { cancelled: squad(8) })).toBe(false);
    expect(check(ms, { older: squad(8) })).toBe(true);
    expect(check([m("hist", -5, "COMPLETED", { isHistorical: true }), m("next", 2, "UPCOMING")], { hist: squad(8) })).toBe(false);
  });

  it("a game played longer ago than the lookback is not carried, so it is not a squad to carry", () => {
    const ms = [m("long-ago", -30, "COMPLETED"), m("next", 2, "UPCOMING")];
    expect(check(ms, { "long-ago": squad(8) })).toBe(false);
  });

  it("two weekly games: every one with a game coming up must have its squad, or the hello would be false for that game", () => {
    const both = [
      m("tue-last", -5, "COMPLETED"),
      m("tue-next", 2, "UPCOMING"),
      m("thu-last", -3, "COMPLETED", { activity: OTHER }),
      m("thu-next", 4, "UPCOMING", { activity: OTHER }),
    ];
    expect(check(both, { "tue-last": squad(8), "thu-last": squad(8) })).toBe(true);
    expect(check(both, { "tue-last": squad(8), "thu-last": squad(1) })).toBe(false);
    expect(check(both, { "tue-last": squad(8) })).toBe(false);
    // A second weekly game with nothing coming up does not hold the first one back.
    const oneAhead = [m("tue-last", -5, "COMPLETED"), m("tue-next", 2, "UPCOMING"), m("thu-last", -3, "COMPLETED", { activity: OTHER })];
    expect(check(oneAhead, { "tue-last": squad(8) })).toBe(true);
    // ... and its squad does not stand in for the game that IS coming up.
    expect(check([m("thu-last", -3, "COMPLETED", { activity: OTHER }), m("tue-next", 2, "UPCOMING")], { "thu-last": squad(8) })).toBe(false);
  });

  it("the next game was seeded already: its own list is counted against its own places", () => {
    const seeded = m("next", 2, "UPCOMING", { rollingSeededAt: new Date(NOW.getTime() - DAY) });
    expect(check([m("last", -5, "COMPLETED"), seeded], { next: squad(5) })).toBe(true);
    expect(check([m("last", -5, "COMPLETED"), seeded], { next: squad(4) })).toBe(false);
    expect(check([m("last", -5, "COMPLETED"), seeded], { next: [], last: squad(8) })).toBe(false);
  });

  it("no next game generated yet: a game played in the last fortnight is measured against its own places", () => {
    expect(check([m("last", -5, "COMPLETED")], { last: squad(5) })).toBe(true);
    expect(check([m("last", -5, "COMPLETED")], { last: squad(4) })).toBe(false);
    expect(check([m("last", -20, "COMPLETED")], { last: squad(8) })).toBe(false);
  });

  it("a match with no known number of places is never a substantial squad", () => {
    const ms = [m("last", -5, "COMPLETED"), m("next", 2, "UPCOMING", { maxPlayers: undefined })];
    expect(check(ms, { last: squad(8) })).toBe(false);
  });
});
