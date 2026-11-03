import { describe, expect, it } from "vitest";
import { checkMinPlayers, formatMinimum, lowNumbersBelow, minimumToPlay, parseMinPlayersInput } from "../min-players";

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

describe("checkMinPlayers", () => {
  it("null clears it back to two full sides", () => {
    expect(checkMinPlayers(null, 14)).toEqual({ ok: true, value: null });
  });
  it("accepts a whole number from 2 to the places", () => {
    expect(checkMinPlayers(12, 14)).toEqual({ ok: true, value: 12 });
    expect(checkMinPlayers(14, 14)).toEqual({ ok: true, value: 14 });
    expect(checkMinPlayers(2, 14)).toEqual({ ok: true, value: 2 });
  });
  it("refuses more than the places", () => {
    expect(checkMinPlayers(15, 14)).toEqual({ ok: false, error: "too-high" });
  });
  it("refuses fewer than 2", () => {
    expect(checkMinPlayers(1, 14)).toEqual({ ok: false, error: "too-low" });
    expect(checkMinPlayers(0, 14)).toEqual({ ok: false, error: "too-low" });
  });
  it("refuses what is not a whole number", () => {
    expect(checkMinPlayers(12.5, 14)).toEqual({ ok: false, error: "not-a-number" });
    expect(checkMinPlayers("12", 14)).toEqual({ ok: false, error: "not-a-number" });
    expect(checkMinPlayers(Number.NaN, 14)).toEqual({ ok: false, error: "not-a-number" });
  });
});

describe("parseMinPlayersInput (the activities page's box)", () => {
  it("empty is two full sides", () => expect(parseMinPlayersInput("  ")).toEqual({ ok: true, value: null }));
  it("a whole number", () => expect(parseMinPlayersInput(" 12 ")).toEqual({ ok: true, value: 12 }));
  it("anything else is refused", () => {
    for (const v of ["12.5", "twelve", "-3", "1e2"]) expect(parseMinPlayersInput(v), v).toEqual({ ok: false });
  });
});
