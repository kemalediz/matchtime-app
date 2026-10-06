/**
 * Recognising the answer to "which team won?" without a model
 * (review of PR #214, item 4).
 */
import { describe, it, expect } from "vitest";
import {
  SCORE_ANSWER_UNTAGGED_MS,
  SCORE_ASK_TTL_MS,
  isScoreAnswer,
  isScoreAskOpen,
  messageHasScoreline,
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

  it("stays open for two hours and no longer", () => {
    expect(SCORE_ASK_TTL_MS).toBe(2 * 60 * 60 * 1000);
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

  it('"Yellow?" is a question, not an answer', () => {
    expect(scoreAnswerSide("Yellow?", EN)).toBeNull();
    expect(scoreAnswerSide("@Match Time yellow??", EN)).toBeNull();
    expect(scoreAnswerSide("sarı mı?", TR)).toBeNull();
  });

  it("uses the club's own names", () => {
    expect(scoreAnswerSide("Tigers", ["Lions", "Tigers"])).toBe("YELLOW");
    expect(scoreAnswerSide("yellow", ["Lions", "Tigers"])).toBeNull();
  });
});

describe("who may answer, and for how long (second review, M2)", () => {
  const asked = new Date("2026-10-06T21:00:00Z");
  const ask = { askedAt: asked.toISOString(), askerUserId: "u-elvin" };
  const at = (ms: number) => new Date(asked.getTime() + ms);
  const MIN = 60_000;
  const base = { body: "Yellow", tagged: false, senderUserId: "u-elvin" as string | null, senderIsAdmin: false, ask };

  it("the person who posted the scoreline, untagged, for thirty minutes", () => {
    expect(SCORE_ANSWER_UNTAGGED_MS).toBe(30 * MIN);
    expect(isScoreAnswer({ ...base, now: at(MIN) })).toBe(true);
    expect(isScoreAnswer({ ...base, now: at(30 * MIN) })).toBe(true);
    expect(isScoreAnswer({ ...base, now: at(31 * MIN) })).toBe(false);
  });

  it("an identified admin, untagged, for the same thirty minutes", () => {
    const admin = { ...base, senderUserId: "u-kemal", senderIsAdmin: true };
    expect(isScoreAnswer({ ...admin, now: at(MIN) })).toBe(true);
    expect(isScoreAnswer({ ...admin, now: at(31 * MIN) })).toBe(false);
  });

  it("anybody else only by tagging the bot, while the question is open", () => {
    const other = { ...base, senderUserId: "u-sait" };
    expect(isScoreAnswer({ ...other, now: at(MIN) })).toBe(false);
    expect(isScoreAnswer({ ...other, tagged: true, now: at(MIN) })).toBe(true);
    expect(isScoreAnswer({ ...other, tagged: true, now: at(119 * MIN) })).toBe(true);
    expect(isScoreAnswer({ ...other, tagged: true, now: at(121 * MIN) })).toBe(false);
  });

  it("a sender WhatsApp did not identify only by tagging the bot", () => {
    const unknown = { ...base, senderUserId: null };
    expect(isScoreAnswer({ ...unknown, now: at(MIN) })).toBe(false);
    expect(isScoreAnswer({ ...unknown, tagged: true, now: at(MIN) })).toBe(true);
    // Not even when the QUESTION was put to an unidentified sender:
    // there is no identity to match.
    expect(isScoreAnswer({ ...unknown, ask: { ...ask, askerUserId: null }, now: at(MIN) })).toBe(false);
  });

  it("never a question mark, never before the question, never after it closed", () => {
    expect(isScoreAnswer({ ...base, body: "Yellow?", now: at(MIN) })).toBe(false);
    expect(isScoreAnswer({ ...base, tagged: true, body: "@Match Time yellow?", now: at(MIN) })).toBe(false);
    expect(isScoreAnswer({ ...base, now: at(-MIN) })).toBe(false);
  });
});

describe("does the TEXT have a scoreline? (M1)", () => {
  it.each(["9-6", "it was 6-6 then 9-6 to yellows", "Red 6 Yellow 9", "0-0", "10 - 7 :))", "3 all, well 3-3"])(
    "yes: %s",
    (body) => expect(messageHasScoreline(body)).toBe(true),
  );

  it.each(["good game lads", "yellows won", "yellows got 9", "", "@447700900123 @447700900456 good game", "wrong way round"])(
    "no: %s",
    (body) => expect(messageHasScoreline(body)).toBe(false),
  );
});
