import { describe, expect, it } from "vitest";
import { formatMinimum, lowNumbersBelow, minimumToPlay, parsePlayersInput } from "../min-players";

describe("formatMinimum", () => {
  it("is two full sides when the organiser set none (today's behaviour)", () => {
    expect(formatMinimum({ minPlayers: null, playersPerTeam: 7 })).toBe(14);
  });
  it("is the organiser's own minimum when set", () => {
    expect(formatMinimum({ minPlayers: 12, playersPerTeam: 7 })).toBe(12);
  });
});

describe("minimumToPlay", () => {
  it("a club with one 7-a-side game and no minimum: 14, as before", () => {
    expect(minimumToPlay({ minPlayers: null, playersPerTeam: 7 }, [])).toBe(14);
  });
  it("a 5-a-side game of the same sport lowers it to 10, as before", () => {
    expect(
      minimumToPlay({ minPlayers: null, playersPerTeam: 7 }, [
        { minPlayers: null, playersPerTeam: 7 },
        { minPlayers: null, playersPerTeam: 5 },
      ]),
    ).toBe(10);
  });
  it("the Vets: 7-a-side, minimum 12", () => {
    expect(minimumToPlay({ minPlayers: 12, playersPerTeam: 7 }, [{ minPlayers: 12, playersPerTeam: 7 }])).toBe(12);
  });
  it("the smaller format's own minimum counts too", () => {
    expect(
      minimumToPlay({ minPlayers: 12, playersPerTeam: 7 }, [{ minPlayers: 9, playersPerTeam: 5 }]),
    ).toBe(9);
  });
  it("never above the game's own minimum when another format is bigger", () => {
    expect(minimumToPlay({ minPlayers: null, playersPerTeam: 5 }, [{ minPlayers: null, playersPerTeam: 7 }])).toBe(10);
  });
});

describe("lowNumbersBelow", () => {
  it("is the places when no minimum is set (today's behaviour)", () => {
    expect(lowNumbersBelow({ minPlayers: null, maxPlayers: 14 })).toBe(14);
  });
  it("is the minimum when set", () => {
    expect(lowNumbersBelow({ minPlayers: 12, maxPlayers: 14 })).toBe(12);
  });
  it("never above the places", () => {
    expect(lowNumbersBelow({ minPlayers: 16, maxPlayers: 14 })).toBe(14);
  });
});

// The range check (even numbers, 2 up to the places) moved to
// flex-format-rules.ts `checkPlayerRange` with the maximum (2026-11-03).

describe("parsePlayersInput (the activities page's boxes)", () => {
  it("empty is two full sides", () => expect(parsePlayersInput("  ")).toEqual({ ok: true, value: null }));
  it("a whole number", () => expect(parsePlayersInput(" 12 ")).toEqual({ ok: true, value: 12 }));
  it("anything else is refused", () => {
    for (const v of ["12.5", "twelve", "-3", "1e2"]) expect(parsePlayersInput(v), v).toEqual({ ok: false });
  });
});
