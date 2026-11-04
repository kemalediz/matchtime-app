/**
 * One definition of a "short" squad for the scheduler (squad-short.ts).
 */
import { describe, it, expect } from "vitest";
import { isSquadShort, placesOpen, shortBelow, squadNumbers } from "@/lib/squad-short";

describe("isSquadShort", () => {
  it("no minimum, the format's own places: short below the places, as before", () => {
    const g = { minPlayers: null, maxPlayers: 14, playersPerTeam: 7 };
    expect(shortBelow(g)).toBe(14);
    expect(isSquadShort(13, g)).toBe(true);
    expect(isSquadShort(14, g)).toBe(false);
  });

  it("FNF: minimum 12, 18 places on a 9-a-side: 12 is on, 11 is short", () => {
    const g = { minPlayers: 12, maxPlayers: 18, playersPerTeam: 9 };
    expect(isSquadShort(12, g)).toBe(false);
    expect(isSquadShort(11, g)).toBe(true);
  });

  it("a 7-a-side switched up to 16, no minimum: 14 is two full sides, not short", () => {
    const g = { minPlayers: null, maxPlayers: 16, playersPerTeam: 7 };
    expect(isSquadShort(14, g)).toBe(false);
    expect(isSquadShort(13, g)).toBe(true);
  });

  it("matches the 10:00 'Low numbers' threshold the Vets' tests pin (minimum 12 of 14)", () => {
    const g = { minPlayers: 12, maxPlayers: 14, playersPerTeam: 7 };
    expect(isSquadShort(13, g)).toBe(false);
    expect(isSquadShort(11, g)).toBe(true);
  });
});

/**
 * B1 (club summary, K1 2026-11-04): one definition of "places open" and
 * "short", read by every consumer. `squadNumbers` is what the summary's
 * `matchNumbers` returns; `placesOpen` is its first half on its own.
 */
describe("placesOpen: the places not yet taken, never negative", () => {
  it("counts the places less the confirmed", () => {
    expect(placesOpen(14, 13)).toBe(1);
    expect(placesOpen(18, 12)).toBe(6);
    expect(placesOpen(14, 0)).toBe(14);
  });

  it("is zero for a full or over-full squad", () => {
    expect(placesOpen(14, 14)).toBe(0);
    expect(placesOpen(14, 16)).toBe(0);
  });

  it("a bad capacity is never more places", () => {
    expect(placesOpen(Number.NaN, 3)).toBe(0);
    expect(placesOpen(-2, 0)).toBe(0);
  });
});

describe("squadNumbers: places open and short, from one rule", () => {
  it("FNF, 12 of 18 with a minimum of 12: 6 places open, not short (the game is on)", () => {
    expect(squadNumbers({ places: 18, confirmed: 12, minPlayers: 12, playersPerTeam: 9 })).toEqual({
      placesOpen: 6,
      shortBelow: 12,
      short: false,
    });
  });

  it("FNF, 10 of 18: 8 places open, short", () => {
    expect(squadNumbers({ places: 18, confirmed: 10, minPlayers: 12, playersPerTeam: 9 })).toEqual({
      placesOpen: 8,
      shortBelow: 12,
      short: true,
    });
  });

  it("the Vets, 13 of 14 with a minimum of 12: 1 place open, not short", () => {
    const n = squadNumbers({ places: 14, confirmed: 13, minPlayers: 12, playersPerTeam: 7 });
    expect(n.placesOpen).toBe(1);
    expect(n.short).toBe(false);
  });

  it("no minimum: short exactly while a place is open, as before", () => {
    for (let c = 0; c <= 15; c++) {
      const n = squadNumbers({ places: 14, confirmed: c, minPlayers: null, playersPerTeam: 7 });
      expect(n.short).toBe(n.placesOpen > 0);
    }
  });

  it("agrees with isSquadShort and shortBelow", () => {
    const g = { minPlayers: 12, maxPlayers: 16, playersPerTeam: 7 };
    for (let c = 0; c <= 17; c++) {
      const n = squadNumbers({ places: 16, confirmed: c, minPlayers: 12, playersPerTeam: 7 });
      expect(n.short).toBe(isSquadShort(c, g));
      expect(n.shortBelow).toBe(shortBelow(g));
    }
  });
});
