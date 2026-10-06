/**
 * WHOSE NUMBER IS WHOSE (2026-10-07).
 *
 * Sutton FC, 6 October 2026: "it was 6-6 until 15 minutes then suddenly
 * it turned to 9-6 to yellows" was recorded Red 9, Yellow 6, because the
 * extractor returned two numbers with no team and the engine put the
 * first on Red. Every case below is a way a real group states a result;
 * the bodies in the comments are from the club's own history.
 */
import { describe, it, expect } from "vitest";
import { resolveScoreResult, resolveTeamRef } from "../score-teams";
import type { ScoreFacts } from "../types";

const EN: [string, string] = ["Red", "Yellow"];
const TR: [string, string] = ["Kırmızı", "Sarı"];

function facts(first: number, second: number, over: Partial<ScoreFacts> = {}): ScoreFacts {
  return { kind: "score", first, second, ...over };
}

const resolve = (f: ScoreFacts, labels: [string, string] = EN, senderTeam: "RED" | "YELLOW" | null = null) =>
  resolveScoreResult({ facts: f, labels, senderTeam });

describe("a team named with the result", () => {
  it('"9-6 to yellows": the incident', () => {
    expect(resolve(facts(9, 6, { winner: "yellows" }))).toEqual({ kind: "resolved", red: 6, yellow: 9 });
  });

  it('"5-4 to reds"', () => {
    expect(resolve(facts(5, 4, { winner: "reds" }))).toEqual({ kind: "resolved", red: 5, yellow: 4 });
  });

  it('"4-6 to Yellows": the winner takes the bigger number wherever it is written', () => {
    expect(resolve(facts(4, 6, { winner: "Yellows" }))).toEqual({ kind: "resolved", red: 4, yellow: 6 });
  });

  it('"6-5 Yellow wins"', () => {
    expect(resolve(facts(6, 5, { winner: "Yellow" }))).toEqual({ kind: "resolved", red: 5, yellow: 6 });
  });

  it('"reds lost 6-9": the loser takes the smaller number', () => {
    expect(resolve(facts(6, 9, { loser: "reds" }))).toEqual({ kind: "resolved", red: 6, yellow: 9 });
  });
});

describe("a team attached to each number", () => {
  it('"Yellow 9 - 6 Red": the correction that was ignored', () => {
    expect(resolve(facts(9, 6, { firstTeam: "Yellow", secondTeam: "Red" }))).toEqual({
      kind: "resolved",
      red: 6,
      yellow: 9,
    });
  });

  it('"Red 6 Yellow 9"', () => {
    expect(resolve(facts(6, 9, { firstTeam: "Red", secondTeam: "Yellow" }))).toEqual({
      kind: "resolved",
      red: 6,
      yellow: 9,
    });
  });

  it("one label is enough: the other number is the other team's", () => {
    expect(resolve(facts(9, 6, { firstTeam: "yellow" }))).toEqual({ kind: "resolved", red: 6, yellow: 9 });
    expect(resolve(facts(9, 6, { secondTeam: "yellow" }))).toEqual({ kind: "resolved", red: 9, yellow: 6 });
  });
});

describe("Turkish", () => {
  it('"sarılar 9-6 kazandı"', () => {
    expect(resolve(facts(9, 6, { winner: "sarılar" }), TR)).toEqual({ kind: "resolved", red: 6, yellow: 9 });
  });

  it('"kırmızı 6 sarı 9"', () => {
    expect(resolve(facts(6, 9, { firstTeam: "kırmızı", secondTeam: "sarı" }), TR)).toEqual({
      kind: "resolved",
      red: 6,
      yellow: 9,
    });
  });

  it("reads the colour words in either language, whatever the club's language is", () => {
    expect(resolveTeamRef("Sarılar", EN, null)).toBe("YELLOW");
    expect(resolveTeamRef("KIRMIZILAR", EN, null)).toBe("RED");
    expect(resolveTeamRef("the reds", TR, null)).toBe("RED");
    expect(resolveTeamRef("yellow team", TR, null)).toBe("YELLOW");
  });
});

describe("a club that renamed its teams", () => {
  const LIONS: [string, string] = ["Lions", "Tigers"];

  it("matches the club's own names", () => {
    expect(resolve(facts(5, 3, { winner: "tigers" }), LIONS)).toEqual({ kind: "resolved", red: 3, yellow: 5 });
    expect(resolveTeamRef("the Lions", LIONS, null)).toBe("RED");
    expect(resolveTeamRef("lion", LIONS, null)).toBe("RED");
  });

  it("still reads the colour, which is what the bibs are", () => {
    expect(resolveTeamRef("yellows", LIONS, null)).toBe("YELLOW");
  });

  it("the club's name for a team beats the colour word", () => {
    // A club that calls its RED side "Yellow Submarines".
    const ODD: [string, string] = ["Yellow Submarines", "Blues"];
    expect(resolveTeamRef("yellow submarines", ODD, null)).toBe("RED");
    // And a bare "yellow" is then no longer safely anybody's.
    expect(resolveTeamRef("yellow", ODD, null)).toBe("RED");
  });

  it("does not guess between two names that both fit", () => {
    expect(resolveTeamRef("team", ["Team A", "Team B"], null)).toBeNull();
  });
});

describe('"we" and "they" are read from the sender\'s side', () => {
  it('"we won 5-3" from a Yellow player', () => {
    expect(resolve(facts(5, 3, { winner: "us" }), EN, "YELLOW")).toEqual({ kind: "resolved", red: 3, yellow: 5 });
  });

  it('"kaybettik 3-5" from a Red player', () => {
    expect(resolve(facts(3, 5, { loser: "us" }), TR, "RED")).toEqual({ kind: "resolved", red: 3, yellow: 5 });
  });

  it('"they beat us 7-2" from a Red player', () => {
    expect(resolve(facts(7, 2, { winner: "them", loser: "us" }), EN, "RED")).toEqual({
      kind: "resolved",
      red: 2,
      yellow: 7,
    });
  });

  it("asks when the sender was on neither side", () => {
    expect(resolve(facts(5, 3, { winner: "us" }), EN, null)).toEqual({ kind: "ask", why: "unknown_team" });
  });
});

describe("a draw needs no team", () => {
  it('"7-7"', () => {
    expect(resolve(facts(7, 7))).toEqual({ kind: "resolved", red: 7, yellow: 7 });
  });

  it("even with a team named beside it", () => {
    expect(resolve(facts(8, 8, { winner: "Arsenal" }))).toEqual({ kind: "resolved", red: 8, yellow: 8 });
  });
});

describe("it asks rather than guesses", () => {
  it('"10-7 :))": two different numbers and no team', () => {
    expect(resolve(facts(10, 7))).toEqual({ kind: "ask", why: "no_team" });
  });

  it("a team that is neither of ours", () => {
    expect(resolve(facts(3, 1, { winner: "Arsenal" }))).toEqual({ kind: "ask", why: "unknown_team" });
  });

  it("a message that contradicts itself", () => {
    // "Yellow 9 - 6 Red, reds won"
    expect(resolve(facts(9, 6, { firstTeam: "Yellow", secondTeam: "Red", winner: "reds" }))).toEqual({
      kind: "ask",
      why: "conflict",
    });
    // Both numbers given to the same team.
    expect(resolve(facts(9, 6, { firstTeam: "Yellow", secondTeam: "Yellows" }))).toEqual({
      kind: "ask",
      why: "conflict",
    });
  });

  it("agreeing facts are not a conflict", () => {
    expect(resolve(facts(9, 6, { firstTeam: "Yellow", secondTeam: "Red", winner: "yellows" }))).toEqual({
      kind: "resolved",
      red: 6,
      yellow: 9,
    });
  });
});
