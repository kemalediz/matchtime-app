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
import { resolveScoreResult, resolveTeamRef, resolveWinnerSide } from "../score-teams";
import type { ScoreFacts } from "../types";

const EN: [string, string] = ["Red", "Yellow"];
const TR: [string, string] = ["Kırmızı", "Sarı"];

type Scored = ScoreFacts & { first: number; second: number };
function facts(first: number, second: number, over: Partial<ScoreFacts> = {}): Scored {
  return { kind: "score", ...over, first, second };
}

const resolve = (f: Scored, labels: [string, string] = EN, senderTeam: "RED" | "YELLOW" | null = null) =>
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

  it("ONE name beside the HIGHER number is that team's win", () => {
    // "yellow 9-6"
    expect(resolve(facts(9, 6, { firstTeam: "yellow" }))).toEqual({ kind: "resolved", red: 6, yellow: 9 });
    // "4-6 yellows"
    expect(resolve(facts(4, 6, { secondTeam: "yellows" }))).toEqual({ kind: "resolved", red: 4, yellow: 6 });
  });

  it("ONE name beside the LOWER number, and no winning word, is asked about (review item 5)", () => {
    // "Reds 3-5": the sender's own score first, or a Red win written
    // loser first? Nobody can tell, so nobody guesses.
    expect(resolve(facts(3, 5, { firstTeam: "Reds" }))).toEqual({ kind: "ask", why: "lone_lower" });
    // "9-6 yellow"
    expect(resolve(facts(9, 6, { secondTeam: "yellow" }))).toEqual({ kind: "ask", why: "lone_lower" });
  });

  it("a winning word outranks a lone name's position", () => {
    // "5-3 to Yellows", with the model also reporting that "Yellows" is
    // written beside the 3. The word "to" is the statement; the position
    // is an accident of word order.
    expect(resolve(facts(5, 3, { winner: "Yellows", secondTeam: "Yellows" }))).toEqual({
      kind: "resolved",
      red: 3,
      yellow: 5,
    });
    // "Reds 3-5, reds lost"
    expect(resolve(facts(3, 5, { firstTeam: "Reds", loser: "reds" }))).toEqual({
      kind: "resolved",
      red: 3,
      yellow: 5,
    });
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

  it("a colour that is neither team's name is nobody's (review item 7)", () => {
    // Lions and Tigers might wear blue and white. "Yellow" names
    // neither of them, so it is asked about, never mapped.
    expect(resolveTeamRef("yellows", LIONS, null)).toBeNull();
    expect(resolveTeamRef("red", ["Blue", "White"], null)).toBeNull();
    expect(resolveTeamRef("sarılar", ["Blue", "White"], null)).toBeNull();
    expect(resolveTeamRef("blues", ["Blue", "White"], null)).toBe("RED");
    expect(resolveTeamRef("the whites", ["Blue", "White"], null)).toBe("YELLOW");
    expect(resolve(facts(5, 3, { winner: "yellow" }), ["Blue", "White"])).toEqual({
      kind: "ask",
      why: "unknown_team",
    });
  });

  it("one side still called by its colour keeps that colour's words", () => {
    // Only RED was renamed. "sarılar" is still the Yellow side.
    expect(resolveTeamRef("sarılar", ["Lions", "Yellow"], null)).toBe("YELLOW");
    expect(resolveTeamRef("reds", ["Lions", "Yellow"], null)).toBeNull();
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

describe("whole words with known endings, never prefixes (review item 7)", () => {
  it("does not resolve a longer word that merely starts with a team name", () => {
    expect(resolveTeamRef("Reda's team", EN, null)).toBeNull();
    expect(resolveTeamRef("Reda", EN, null)).toBeNull();
    expect(resolveTeamRef("Reddy", EN, null)).toBeNull();
    expect(resolveTeamRef("Redford", EN, null)).toBeNull();
    expect(resolveTeamRef("yellowish", EN, null)).toBeNull();
  });

  it("does not resolve a shorter word that a team name merely starts with", () => {
    expect(resolveTeamRef("yel", EN, null)).toBeNull();
    expect(resolveTeamRef("re", EN, null)).toBeNull();
    expect(resolveTeamRef("tig", ["Lions", "Tigers"], null)).toBeNull();
  });

  it("English plural and possessive", () => {
    expect(resolveTeamRef("reds", EN, null)).toBe("RED");
    expect(resolveTeamRef("the Yellows", EN, null)).toBe("YELLOW");
    expect(resolveTeamRef("yellow's", EN, null)).toBe("YELLOW");
    expect(resolveTeamRef("yellow team", EN, null)).toBe("YELLOW");
    expect(resolveTeamRef("tiger", ["Lions", "Tigers"], null)).toBe("YELLOW");
  });

  it("Turkish endings of any length on the colour words", () => {
    for (const w of ["kırmızı", "kırmızılar", "kırmızıların", "kırmızıya", "kırmızıdan", "Kırmızı takım", "KIRMIZILAR"]) {
      expect(resolveTeamRef(w, TR, null), w).toBe("RED");
    }
    for (const w of ["sarı", "sarılar", "sarılardan", "sarıların", "sarıya", "sarı takım", "sarı takımı"]) {
      expect(resolveTeamRef(w, TR, null), w).toBe("YELLOW");
    }
  });

  it("Turkish endings on a club's own names: plural freely, a case ending after an apostrophe", () => {
    const ASLAN: [string, string] = ["Aslan", "Kartal"];
    expect(resolveTeamRef("Aslanlar", ASLAN, null)).toBe("RED");
    expect(resolveTeamRef("Kartalların", ASLAN, null)).toBe("YELLOW");
    expect(resolveTeamRef("Kartal'a", ASLAN, null)).toBe("YELLOW");
    expect(resolveTeamRef("Aslan'dan", ASLAN, null)).toBe("RED");
    expect(resolveTeamRef("Aslantürk", ASLAN, null)).toBeNull();
  });
});

describe("who won, when the message has no numbers (review items 3 and 4)", () => {
  const side = (f: Partial<ScoreFacts>, senderTeam: "RED" | "YELLOW" | null = null) =>
    resolveWinnerSide({ facts: { kind: "score", first: null, second: null, ...f }, labels: EN, senderTeam });

  it("reads a named winner or loser", () => {
    expect(side({ winner: "yellows" })).toBe("YELLOW");
    expect(side({ loser: "yellows" })).toBe("RED");
    expect(side({ winner: "us" }, "RED")).toBe("RED");
  });

  it("is null when nobody is named, the name is unknown, or the two disagree", () => {
    expect(side({})).toBeNull();
    expect(side({ winner: "Arsenal" })).toBeNull();
    expect(side({ winner: "yellow", loser: "yellows" })).toBeNull();
    expect(side({ winner: "us" })).toBeNull();
  });
});
