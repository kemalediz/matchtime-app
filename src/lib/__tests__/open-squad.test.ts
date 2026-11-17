/**
 * OPEN SQUAD (2026-11-17, the Vets: "the main squad will always expand or
 * shrink without any limits and a bench, as the pitch is quite big to
 * allow anyone"; then "no 7, 8, 9 or 10-a-side, just a simple main squad
 * list" with a minimum of 12 and no maximum).
 *
 * The pure rules: who may take a place (everyone), the one number the club
 * has (its minimum), what an ask or a chase may ask for (only the players
 * short of that minimum), the two sides (whoever is in, split evenly) and
 * a game's name with no size in it.
 */
import { describe, expect, it } from "vitest";
import { canTakeFreePlace } from "../squad-capacity";
import { matchFormatTitle } from "../match-format-title";
import { openSquadMinimum, openSquadPerTeam, placesToFill, shortOfMinimum } from "../open-squad";
import { balanceTeams } from "../team-balancer";

describe("open squad: every IN takes a place", () => {
  it("a full squad, or past it, still takes the IN, whoever is acting and whatever the pick mode", () => {
    for (const confirmed of [0, 13, 14, 15, 30])
      for (const pickMode of ["first-come", "organiser"] as const)
        for (const actorIsAdmin of [false, true])
          expect(
            canTakeFreePlace({ confirmed, maxPlayers: 14, pickMode, actorIsAdmin, isReclaim: false, openBenchOffer: false, openSquad: true }),
          ).toBe(true);
  });

  it("off (the default): today's rule exactly", () => {
    expect(canTakeFreePlace({ confirmed: 14, maxPlayers: 14, pickMode: "first-come", actorIsAdmin: false, isReclaim: false, openBenchOffer: false })).toBe(false);
    expect(canTakeFreePlace({ confirmed: 14, maxPlayers: 14, pickMode: "first-come", actorIsAdmin: false, isReclaim: false, openBenchOffer: false, openSquad: false })).toBe(false);
  });
});

describe("open squad: the minimum is the only number", () => {
  it("the organiser's minimum when set (the Vets: 12)", () => {
    expect(openSquadMinimum({ minPlayers: 12, playersPerTeam: 7 })).toBe(12);
  });
  it("two full sides of the sport's format when none is set", () => {
    expect(openSquadMinimum({ minPlayers: null, playersPerTeam: 7 })).toBe(14);
  });
  it("never below two players", () => {
    expect(openSquadMinimum({ minPlayers: 1, playersPerTeam: 0 })).toBe(2);
  });
  it("short of the minimum: how many more are needed to play, never negative", () => {
    expect(shortOfMinimum(10, 12)).toBe(2);
    expect(shortOfMinimum(12, 12)).toBe(0);
    expect(shortOfMinimum(19, 12)).toBe(0);
  });
});

describe("placesToFill: what an ask or a chase may ask for", () => {
  it("open squad: only the players short of the minimum, whatever the places", () => {
    expect(placesToFill({ openSquad: true, confirmed: 13, maxPlayers: 14, minimum: 12 })).toBe(0);
    expect(placesToFill({ openSquad: true, confirmed: 10, maxPlayers: 14, minimum: 12 })).toBe(2);
    expect(placesToFill({ openSquad: true, confirmed: 20, maxPlayers: 14, minimum: 12 })).toBe(0);
  });
  it("off: the places still open, as always", () => {
    expect(placesToFill({ openSquad: false, confirmed: 13, maxPlayers: 14, minimum: 12 })).toBe(1);
    expect(placesToFill({ openSquad: false, confirmed: 15, maxPlayers: 14, minimum: 12 })).toBe(0);
  });
});

describe("open squad: the teams are whoever is in, split into two even sides", () => {
  const players = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, positions: [], rating: 5 + (i % 5) / 2 }));

  for (const [count, red, yellow] of [
    [12, 6, 6],
    [15, 8, 7],
    [19, 10, 9],
    [22, 11, 11],
  ] as const) {
    it(`${count} make ${red} v ${yellow}, nobody left out`, () => {
      const perTeam = openSquadPerTeam(count);
      const r = balanceTeams({ players: players(count), perTeam, strategy: "rating-only", minPlayers: 12 });
      expect([r.red.length, r.yellow.length]).toEqual([red, yellow]);
    });
  }

  it("position-aware with a 7-a-side composition still places everyone (15 make 8 v 7)", () => {
    const ps = players(15).map((p, i) => ({ ...p, positions: [i % 7 === 0 ? "GK" : i % 2 ? "DEF" : "FWD"] }));
    const r = balanceTeams({
      players: ps,
      perTeam: openSquadPerTeam(15),
      strategy: "position-aware",
      composition: { GK: 1, DEF: 3, MID: 2, FWD: 1 },
      minPlayers: 12,
    });
    expect(r.red.length + r.yellow.length).toBe(15);
    expect(Math.abs(r.red.length - r.yellow.length)).toBe(1);
  });
});

describe("a game's name with no size in it (open squad)", () => {
  it("the Vets: \"Football 7-a-side\" is \"Football\", whatever the match's places", () => {
    expect(matchFormatTitle("Football 7-a-side", 14, { openSquad: true })).toBe("Football");
    expect(matchFormatTitle("Football 7-a-side", 16, { openSquad: true })).toBe("Football");
  });
  it("Turkish: \"7'ye 7 futbol\" is \"futbol\"", () => {
    expect(matchFormatTitle("7'ye 7 futbol", 14, { openSquad: true })).toBe("futbol");
  });
  it("other spellings and a size in the middle", () => {
    expect(matchFormatTitle("Monday 7 aside", 14, { openSquad: true })).toBe("Monday");
    expect(matchFormatTitle("Monday 7-a-side football", 14, { openSquad: true })).toBe("Monday football");
    expect(matchFormatTitle("Vets (7-a-side)", 14, { openSquad: true })).toBe("Vets");
  });
  it("a name with no size is kept; a name that is only a size is kept rather than emptied", () => {
    expect(matchFormatTitle("Monday night vets", 14, { openSquad: true })).toBe("Monday night vets");
    expect(matchFormatTitle("7-a-side", 14, { openSquad: true })).toBe("7-a-side");
  });
  it("off: today's behaviour (the size the game is played at)", () => {
    expect(matchFormatTitle("Football 7-a-side", 16)).toBe("Football 8-a-side");
    expect(matchFormatTitle("Football 7-a-side", 16, { openSquad: false })).toBe("Football 8-a-side");
  });
});
