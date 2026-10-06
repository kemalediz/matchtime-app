/**
 * Recognising the answer to "which team won?" without a model
 * (review of PR #214, item 4).
 */
import { describe, it, expect } from "vitest";
import {
  SCORE_ASK_TTL_MS,
  isScoreAskOpen,
  parseScoreAskKey,
  samePair,
  scoreAnswerRef,
  scoreAnswerSide,
  scoreAskKey,
} from "../score-ask";

const EN: [string, string] = ["Red", "Yellow"];
const TR: [string, string] = ["Kırmızı", "Sarı"];

describe("the stored question", () => {
  it("round-trips its numbers through the key", () => {
    const key = scoreAskKey("cmtbro2ct0006tt9kxjbbr0ce", 10, 7);
    expect(parseScoreAskKey(key)).toEqual({ matchId: "cmtbro2ct0006tt9kxjbbr0ce", first: 10, second: 7 });
    expect(parseScoreAskKey("cmtbro2ct0006tt9kxjbbr0ce:badges")).toBeNull();
    expect(parseScoreAskKey("m:score-ask:10-x")).toBeNull();
  });

  it("stays open for a day and no longer", () => {
    const asked = new Date("2026-10-06T21:00:00Z");
    expect(isScoreAskOpen(asked.toISOString(), new Date(asked.getTime() + 60_000))).toBe(true);
    expect(isScoreAskOpen(asked, new Date(asked.getTime() + SCORE_ASK_TTL_MS))).toBe(true);
    expect(isScoreAskOpen(asked, new Date(asked.getTime() + SCORE_ASK_TTL_MS + 1))).toBe(false);
    expect(isScoreAskOpen(asked, new Date(asked.getTime() - 1))).toBe(false);
    expect(isScoreAskOpen("not a date", asked)).toBe(false);
  });

  it("treats 10-7 and 7-10 as the same scoreline", () => {
    expect(samePair({ first: 10, second: 7 }, { first: 7, second: 10 })).toBe(true);
    expect(samePair({ first: 10, second: 7 }, { first: 10, second: 6 })).toBe(false);
  });
});

describe("a message that is nothing but the winning team", () => {
  it.each([
    ["Yellow", "YELLOW"],
    ["yellows", "YELLOW"],
    ["Yellows won", "YELLOW"],
    ["to the reds", "RED"],
    ["@Match Time red", "RED"],
    ["it was yellow!", "YELLOW"],
    ["Red team", "RED"],
    ["reds @Match Time", "RED"],
  ] as const)("%s -> %s", (body, side) => {
    expect(scoreAnswerSide(body, EN)).toBe(side);
  });

  it.each([
    ["Sarı", "YELLOW"],
    ["sarılar kazandı", "YELLOW"],
    ["kırmızılar", "RED"],
    ["Kırmızı takım", "RED"],
  ] as const)("Turkish: %s -> %s", (body, side) => {
    expect(scoreAnswerSide(body, TR)).toBe(side);
  });

  it("is not an answer when it has a number, is long, or names nobody", () => {
    expect(scoreAnswerSide("10-7 to yellow", EN)).toBeNull();
    expect(scoreAnswerRef("yellow 9")).toBeNull();
    expect(scoreAnswerSide("yellow were the better side all night", EN)).toBeNull();
    expect(scoreAnswerSide("good game lads", EN)).toBeNull();
    expect(scoreAnswerSide("we won", EN)).toBeNull();
    expect(scoreAnswerSide("", EN)).toBeNull();
    expect(scoreAnswerSide("Reda", EN)).toBeNull();
  });

  it("uses the club's own names", () => {
    expect(scoreAnswerSide("Tigers", ["Lions", "Tigers"])).toBe("YELLOW");
    expect(scoreAnswerSide("yellow", ["Lions", "Tigers"])).toBeNull();
  });
});
