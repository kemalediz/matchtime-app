/**
 * One definition of a "short" squad for the scheduler (squad-short.ts).
 */
import { describe, it, expect } from "vitest";
import { isSquadShort, shortBelow } from "@/lib/squad-short";

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
