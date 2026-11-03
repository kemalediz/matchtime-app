/**
 * THE GAME'S SIZES (2026-11-03): the Vets play 6, 7 or 8 a side by numbers.
 * Pure rules: the range an organiser sets, the sizes it allows, the bench
 * suggestion, who moves on a switch, and how many make the teams.
 */
import { describe, expect, it } from "vitest";
import {
  FORMAT_UP_KEY_PREFIX,
  PLAYERS_CEILING,
  checkPlayerRange,
  decideBenchSuggestion,
  formatUpKey,
  nextSizeUp,
  perTeamFor,
  planResize,
  playerRange,
  sidesInRange,
  teamSides,
  teamsNeeded,
  type ResizeRow,
} from "../flex-format-rules";

const VETS = { minPlayers: 12, maxPlayers: 16, playersPerTeam: 7 };

describe("playerRange and sidesInRange", () => {
  it("the Vets: 12 to 16 with a 7-a-side format is 6, 7 or 8 a side", () => {
    const r = playerRange(VETS);
    expect(r).toEqual({ min: 12, max: 16, normal: 14 });
    expect(sidesInRange(r)).toEqual([6, 7, 8]);
  });

  it("nothing set is only the game's own format, as every club today", () => {
    const r = playerRange({ minPlayers: null, maxPlayers: null, playersPerTeam: 7 });
    expect(r).toEqual({ min: 14, max: 14, normal: 14 });
    expect(sidesInRange(r)).toEqual([7]);
  });

  it("a minimum only (the #515 setting) still allows no bigger game", () => {
    expect(sidesInRange(playerRange({ minPlayers: 12, maxPlayers: null, playersPerTeam: 7 }))).toEqual([6, 7]);
  });

  it("an odd minimum saved before minimums were even still reads safely", () => {
    // 13 is one down: the smallest full format inside it is 7 a side.
    expect(sidesInRange(playerRange({ minPlayers: 13, maxPlayers: null, playersPerTeam: 7 }))).toEqual([7]);
  });

  it("a range never excludes the game's own format", () => {
    const r = playerRange({ minPlayers: 16, maxPlayers: 12, playersPerTeam: 7 });
    expect(r.min).toBeLessThanOrEqual(14);
    expect(r.max).toBeGreaterThanOrEqual(14);
  });
});

describe("checkPlayerRange: even numbers only, around the game's places", () => {
  const normal = 14;
  it("12 and 16 for a 14-place game are fine", () => {
    expect(checkPlayerRange({ min: 12, max: 16, normal })).toEqual({ ok: true, min: 12, max: 16 });
  });
  it("empty is the game's own format", () => {
    expect(checkPlayerRange({ min: null, max: null, normal })).toEqual({ ok: true, min: null, max: null });
  });
  it("the game's own places are stored as empty", () => {
    expect(checkPlayerRange({ min: 14, max: 14, normal })).toEqual({ ok: true, min: null, max: null });
  });
  it("an odd minimum or maximum is refused", () => {
    expect(checkPlayerRange({ min: 13, max: null, normal })).toEqual({ ok: false, error: "odd", field: "min" });
    expect(checkPlayerRange({ min: null, max: 15, normal })).toEqual({ ok: false, error: "odd", field: "max" });
  });
  it("a minimum above the places, or a maximum below them, is refused", () => {
    expect(checkPlayerRange({ min: 16, max: null, normal })).toEqual({ ok: false, error: "min-above-places", field: "min" });
    expect(checkPlayerRange({ min: null, max: 12, normal })).toEqual({ ok: false, error: "max-below-places", field: "max" });
  });
  it("below 2, above the ceiling, or not a whole number is refused", () => {
    expect(checkPlayerRange({ min: 0, max: null, normal })).toEqual({ ok: false, error: "too-low", field: "min" });
    expect(checkPlayerRange({ min: null, max: PLAYERS_CEILING + 2, normal })).toEqual({ ok: false, error: "too-high", field: "max" });
    expect(checkPlayerRange({ min: 12.5, max: null, normal })).toEqual({ ok: false, error: "not-a-number", field: "min" });
    expect(checkPlayerRange({ min: "12", max: null, normal })).toEqual({ ok: false, error: "not-a-number", field: "min" });
  });
});

describe("nextSizeUp", () => {
  const r = playerRange(VETS);
  it("14 goes to 16 inside the range, 16 goes nowhere", () => {
    expect(nextSizeUp(14, r)).toBe(16);
    expect(nextSizeUp(16, r)).toBeNull();
    expect(nextSizeUp(12, r)).toBe(14);
  });
  it("a game with no maximum never goes up", () => {
    expect(nextSizeUp(14, playerRange({ minPlayers: 12, maxPlayers: null, playersPerTeam: 7 }))).toBeNull();
  });
});

describe("decideBenchSuggestion", () => {
  const range = playerRange(VETS);
  const base = { live: true, teamsOut: false, places: 14, confirmed: 14, bench: 2, range };

  it("a full squad and two on the bench: suggest the next size up", () => {
    expect(decideBenchSuggestion(base)).toEqual({ kind: "suggest", toPlaces: 16 });
  });
  it("one on the bench is not enough for one more each side: re-arm", () => {
    expect(decideBenchSuggestion({ ...base, bench: 1 })).toEqual({ kind: "rearm" });
    expect(decideBenchSuggestion({ ...base, bench: 0 })).toEqual({ kind: "rearm" });
  });
  it("no size up inside the maximum: nothing", () => {
    expect(decideBenchSuggestion({ ...base, places: 16, confirmed: 16 })).toEqual({ kind: "none" });
  });
  it("a squad that is not full yet: nothing (the bench fills it first)", () => {
    expect(decideBenchSuggestion({ ...base, confirmed: 13 })).toEqual({ kind: "none" });
  });
  it("teams out, or the game over or called off: nothing", () => {
    expect(decideBenchSuggestion({ ...base, teamsOut: true })).toEqual({ kind: "none" });
    expect(decideBenchSuggestion({ ...base, live: false })).toEqual({ kind: "none" });
  });
  it("the key is per match and per size", () => {
    expect(formatUpKey("m1", 16)).toBe("m1:format-up:16");
    expect(formatUpKey("m1", 16).startsWith(`m1${FORMAT_UP_KEY_PREFIX}`)).toBe(true);
  });
});

describe("planResize", () => {
  const row = (userId: string, status: ResizeRow["status"], position: number, joinedAt: number, extra: Partial<ResizeRow> = {}): ResizeRow => ({
    userId,
    status,
    position,
    joinedAt,
    ...extra,
  });

  it("up: the bench moves in, in bench order, as many as the new places take", () => {
    const rows = [
      ...Array.from({ length: 14 }, (_, i) => row(`p${i + 1}`, "CONFIRMED", i + 1, i)),
      row("b2", "BENCH", 16, 100),
      row("b1", "BENCH", 15, 101),
      row("b3", "BENCH", 17, 50),
    ];
    expect(planResize({ rows, newPlaces: 16 })).toEqual({ promote: ["b1", "b2"], demote: [] });
  });

  it("up: somebody who asked to be on the bench stays there", () => {
    const rows = [
      ...Array.from({ length: 14 }, (_, i) => row(`p${i + 1}`, "CONFIRMED", i + 1, i)),
      row("b1", "BENCH", 15, 100, { choseBench: true }),
      row("b2", "BENCH", 16, 101),
    ];
    expect(planResize({ rows, newPlaces: 16 })).toEqual({ promote: ["b2"], demote: [] });
  });

  it("down: the last to join goes to the bench first", () => {
    const rows = Array.from({ length: 14 }, (_, i) => row(`p${i + 1}`, "CONFIRMED", i + 1, i * 10));
    expect(planResize({ rows, newPlaces: 12 })).toEqual({ promote: [], demote: ["p14", "p13"] });
  });

  it("down, monthly: pay as you go players go before any regular, however late the regular said IN", () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => row(`r${i + 1}`, "CONFIRMED", i + 1, 1000 + i, { regular: true })),
      row("payg1", "CONFIRMED", 13, 10),
      row("payg2", "CONFIRMED", 14, 20),
    ];
    expect(planResize({ rows, newPlaces: 12 })).toEqual({ promote: [], demote: ["payg2", "payg1"] });
  });

  it("down, monthly: once the pay as you go players are out, the latest regular", () => {
    const rows = [
      ...Array.from({ length: 13 }, (_, i) => row(`r${i + 1}`, "CONFIRMED", i + 1, 1000 + i, { regular: true })),
      row("payg1", "CONFIRMED", 14, 10),
    ];
    expect(planResize({ rows, newPlaces: 12 })).toEqual({ promote: [], demote: ["payg1", "r13"] });
  });

  it("the same size, or room with nobody waiting: nothing moves", () => {
    const rows = Array.from({ length: 13 }, (_, i) => row(`p${i + 1}`, "CONFIRMED", i + 1, i));
    expect(planResize({ rows, newPlaces: 14 })).toEqual({ promote: [], demote: [] });
    expect(planResize({ rows, newPlaces: 16 })).toEqual({ promote: [], demote: [] });
  });

  it("dropped players never move", () => {
    const rows = [row("a", "DROPPED", 1, 0), row("b", "BENCH", 2, 1)];
    expect(planResize({ rows, newPlaces: 2 })).toEqual({ promote: ["b"], demote: [] });
  });
});

describe("teams: how many make them, and the two sides", () => {
  it("with a minimum, any count from it up makes teams", () => {
    expect(teamsNeeded({ places: 14, range: playerRange(VETS) })).toBe(12);
  });
  it("with no minimum, two full sides as before", () => {
    expect(teamsNeeded({ places: 14, range: playerRange({ minPlayers: null, maxPlayers: null, playersPerTeam: 7 }) })).toBe(14);
    // Sutton switched to its 5-a-side game: that game's own places.
    expect(teamsNeeded({ places: 10, range: playerRange({ minPlayers: null, maxPlayers: null, playersPerTeam: 5 }) })).toBe(10);
  });
  it("a maximum alone lets a bigger match be made one short of full", () => {
    expect(teamsNeeded({ places: 16, range: playerRange({ minPlayers: null, maxPlayers: 16, playersPerTeam: 7 }) })).toBe(14);
  });
  it("13 is 7 against 6; 14 is 7 against 7; more than the places is the places", () => {
    expect(teamSides(13, 7)).toEqual({ red: 7, yellow: 6 });
    expect(teamSides(14, 7)).toEqual({ red: 7, yellow: 7 });
    expect(teamSides(17, 8)).toEqual({ red: 8, yellow: 8 });
  });
  it("the players a side come from the match's own places, when its range allows them", () => {
    const range = playerRange(VETS);
    expect(perTeamFor({ maxPlayers: 16, playersPerTeam: 7, range })).toBe(8);
    expect(perTeamFor({ maxPlayers: 12, playersPerTeam: 7, range })).toBe(6);
    expect(perTeamFor({ maxPlayers: 14, playersPerTeam: 7 })).toBe(7);
    // Outside the range, odd, or nonsense: the format's own, as before.
    expect(perTeamFor({ maxPlayers: 16, playersPerTeam: 7 })).toBe(7);
    expect(perTeamFor({ maxPlayers: 5, playersPerTeam: 5 })).toBe(5);
    expect(perTeamFor({ maxPlayers: 0, playersPerTeam: 7 })).toBe(7);
  });
});

describe("the admin extractor's facts as numbers (the model never doubles)", () => {
  it("player_numbers: a side is doubled, totals kept", async () => {
    const { playerRangeWordsOf } = await import("../flex-format-rules");
    expect(playerRangeWordsOf({ minPlayers: 6, maxPlayers: 8, aSide: true })).toEqual({ minPlayers: 12, maxPlayers: 16, fullTeams: false, matchDay: null });
    expect(playerRangeWordsOf({ minPlayers: 12, matchDay: " Monday " })).toEqual({ minPlayers: 12, maxPlayers: null, fullTeams: false, matchDay: "Monday" });
    expect(playerRangeWordsOf({ fullTeams: true })).toEqual({ minPlayers: null, maxPlayers: null, fullTeams: true, matchDay: null });
  });
  it("switch_format: a side as said, half an even total, nothing for an odd one", async () => {
    const { perSideOf } = await import("../flex-format-rules");
    expect(perSideOf({ size: 8, aSide: true })).toBe(8);
    expect(perSideOf({ size: 16 })).toBe(8);
    expect(perSideOf({ size: 15 })).toBe(0);
    expect(perSideOf({})).toBe(0);
  });
});
