/**
 * "Which team won?": the stored question and WHO may answer it (facts).
 * WHAT an answer says is the score extractor's since 2026-10-30 ("no
 * string parsing"); the word tests that read it here are deleted.
 */
import { describe, it, expect } from "vitest";
import {
  SCORE_ANSWER_UNTAGGED_MS,
  SCORE_ASK_TTL_MS,
  isScoreAnswer,
  isScoreAskOpen,
  messageStatesScore,
  parseScoreAskKey,
  samePair,
  scoreAskKey,
} from "../score-ask";



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

  it("never before the question, and the words are not read (a question mark is the model's to judge)", () => {
    expect(isScoreAnswer({ ...base, now: at(-MIN) })).toBe(false);
    expect(isScoreAnswer({ ...base, body: "Yellow?", now: at(MIN) })).toBe(true);
    expect(isScoreAnswer({ ...base, body: "anything at all", now: at(MIN) })).toBe(true);
  });
});


describe("the extractor's numbers must be numbers the sender wrote (third review, item 1)", () => {
  it.each([
    ["5-3 to Yellows", 5, 3],
    ["final score was 8 8", 8, 8],
    ["9:6 sarı", 9, 6],
    ["10 - 7", 10, 7],
    ["5 3", 5, 3],
    ["5/3", 5, 3],
    ["0-0", 0, 0],
    ["it was 6-6 until 15 minutes then suddenly it turned to 9-6 to yellows", 9, 6],
    ["we won 05-03", 5, 3],
    ["@447700900123 10-7 to red @Match Time", 10, 7],
  ] as const)("%s states %i-%i", (body, first, second) => {
    expect(messageStatesScore(body, first, second)).toBe(true);
  });

  it.each([
    ["good game lads, same time next week 21:30", 0, 0],
    ["see you at 21:30", 3, 3],
    ["great 7 a side tonight, 14 turned up", 0, 0],
    ["we had 3 subs", 3, 3],
    ["9 of us turned up", 9, 6],
    ["good game lads", 0, 0],
    ["@447700900123 @447700900456 good game", 0, 0],
    ["@Match Time that's wrong, look again at 21:30", 0, 0],
    ["10-7", 1, 0],
  ] as const)("%s does NOT state %i-%i", (body, first, second) => {
    expect(messageStatesScore(body, first, second)).toBe(false);
  });
});

