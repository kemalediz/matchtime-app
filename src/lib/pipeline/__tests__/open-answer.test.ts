/**
 * THE OPEN ANSWER (Kemal, 2026-11-10): a tagged question that fits none of
 * MatchTime's set answers (topic `other`) is answered by ONE model call,
 * from the context it is given and nothing else.
 *
 * These pin the context builder (what the model is told, and what it is
 * never told) and the call (one Haiku call, a hard token cap, never throws,
 * a failed or ungrounded reply is rejected so the caller keeps today's line).
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import { HAIKU_CALL } from "../llm";
import { HAIKU_SHORT_ANSWER_MAX_TOKENS } from "../../models";
import {
  OPEN_ANSWER_SYSTEM,
  answerOpenQuestion,
  buildOpenAnswerContext,
  type OpenAnswerInput,
} from "../open-answer";
import type { ClubSnapshot, StatsSnapshot } from "../types";
import { NOW, fullName, world } from "./helpers";

const CLUB: ClubSnapshot = { collectorName: "Elvin Aliyev", feePerPlayer: 6.5, feeSplitTotal: false, teamsReady: "10:00" };

const P = (key: string) => ({ userId: `u-${key}`, name: fullName(key) });
const STATS: StatsSnapshot = {
  fullTableUrl: "https://matchtime.ai/profile/stats",
  ratings: [
    { ...P("sait"), avg: 8.2, games: 11, rank: 1, delta: 0 },
    { ...P("idris"), avg: 7.4, games: 9, rank: 2, delta: null },
  ],
  mom: [{ ...P("sait"), wins: 4 }],
  elo: [],
  teamOfSeason: null,
  mrReliable: [],
  aliases: [],
  chemistry: {},
  appearances: [
    { ...P("sait"), matches: 16 },
    { ...P("erdal"), matches: 12 },
    { ...P("zair"), matches: 3 },
  ],
  recordsStart: { matches: new Date("2026-04-07T19:00:00.000Z"), mom: null },
  periods: {},
  generic: {},
  completedMatches: 17,
};

function input(over: Partial<OpenAnswerInput> = {}): OpenAnswerInput {
  return {
    state: { ...world({ confirmed: ["kemal", "sait", "idris"], bench: ["erdal", "zair"] }), club: CLUB },
    stats: STATS,
    audience: "organisers",
    squadKnown: true,
    history: [
      { author: "Elvin Aliyev", body: "we should bring the regulars up from the bench" },
      { author: "MatchTime", body: "Done: Faris out. 13 of 14." },
    ],
    lastBotPost: "Done: Faris out. 13 of 14.",
    reply: null,
    now: NOW,
    question: "@Match Time can you suggest the starting squad?",
    askerName: "Kemal Ediz",
    ...over,
  };
}

describe("the context: what MatchTime knows", () => {
  it("holds the upcoming match, the squad and the bench in order, the places left and how a place is filled", () => {
    const { text } = buildOpenAnswerContext(input());
    expect(text).toContain("Tue 21:30");
    expect(text).toContain("Goals North Cheam");
    expect(text).toMatch(/1\. Kemal Ediz\n[^]*2\. Sait Demir\n[^]*3\. Idris Bello/);
    expect(text).toMatch(/BENCH[^\n]*\n[^]*1\. Erdal Ozkan\n[^]*2\. Zair Malik/);
    expect(text).toContain("3 of 14");
    expect(text).toMatch(/places left: 11/i);
    expect(text).toMatch(/first on the bench/i);
  });

  it("an organiser-pick club says the organisers choose from the bench", () => {
    const base = input();
    const state = { ...base.state, features: { ...base.state.features, benchPickMode: "organiser" as const } };
    expect(buildOpenAnswerContext({ ...base, state }).text).toMatch(/organisers choose/i);
  });

  it("holds the club's setup: admins, collector, fee, teams time", () => {
    const { text } = buildOpenAnswerContext(input());
    expect(text).toMatch(/admins: Kemal Ediz, Elvin Aliyev/i);
    expect(text).toContain("Elvin Aliyev");
    expect(text).toContain("£6.50");
    expect(text).toContain("10:00");
  });

  it("holds the stats tables, appearances included, and how many games MatchTime has recorded", () => {
    const { text } = buildOpenAnswerContext(input());
    expect(text).toContain("Sait Demir: 16 matches");
    expect(text).toContain("Zair Malik: 3 matches");
    expect(text).toMatch(/completed games MatchTime has recorded for this club: 17/i);
  });

  it("holds the recent chat with MatchTime's own lines, oldest first, and the message itself once", () => {
    // The Pi's history already carries the message being answered.
    const base = input();
    const { text } = buildOpenAnswerContext({ ...base, history: [...base.history, { author: "Kemal Ediz", body: base.question }] });
    const chat = text.indexOf("we should bring the regulars up");
    expect(chat).toBeGreaterThan(-1);
    expect(text.indexOf("MatchTime: Done: Faris out")).toBeGreaterThan(chat);
    expect(text.split("can you suggest the starting squad").length - 1).toBe(1);
    expect(text.trimEnd().endsWith("@Match Time can you suggest the starting squad?")).toBe(true);
  });

  it("shows the message it replies to", () => {
    const reply = { at: NOW, text: "who's coming up from the bench?", topic: null, match: null, author: { name: "Elvin Aliyev", userId: "u-elvin" }, matchId: null, found: true };
    const { text } = buildOpenAnswerContext(input({ reply }));
    expect(text).toContain("who's coming up from the bench?");
  });

  it("says plainly when there is no upcoming match", () => {
    const base = input();
    const { text } = buildOpenAnswerContext({ ...base, state: { ...base.state, matchId: null, rows: [] } });
    expect(text).toMatch(/no upcoming match/i);
    expect(text).not.toContain("Goals North Cheam");
  });

  it("says the Turkish club language", () => {
    const base = input();
    const state = { ...base.state, features: { ...base.state.features, language: "tr" as const } };
    expect(buildOpenAnswerContext({ ...base, state }).text).toMatch(/club speaks: Turkish/i);
  });
});

describe("the context: what MatchTime never tells it (privacy)", () => {
  it("never holds a phone number: not an author's, not one written in the chat", () => {
    const { text } = buildOpenAnswerContext(
      input({
        history: [
          { author: "+44 7700 900123", body: "my number is 07700 900456, call me" },
          { author: "Sait Demir", body: "@447700900789 are you coming?" },
        ],
      }),
    );
    expect(text).not.toMatch(/7700\s?900/);
    expect(text).not.toMatch(/447700900789/);
    expect(text).toContain("call me");
  });

  it("never holds who has or has not a number, payments, rating progress or a seed", () => {
    const base = input();
    const state = {
      ...base.state,
      payments: { kind: "unpaid", count: 3 } as never,
      ratingProgress: { ok: true, rated: ["Sait Demir"] } as never,
    };
    const { text } = buildOpenAnswerContext({ ...base, state });
    expect(text).not.toMatch(/paid|owe|phone|number on record|seed|rated by/i);
  });

  it("in the players' group of a club whose organisers announce the list, names nobody in the squad or on the bench", () => {
    const base = input({ audience: "players" });
    const state = { ...base.state, features: { ...base.state.features, listAnnouncer: "organisers" as const } };
    const { text } = buildOpenAnswerContext({ ...base, state });
    expect(text).toMatch(/organisers post the list/i);
    expect(text).toContain("3 of 14");
    expect(text).not.toMatch(/1\. Kemal Ediz/);
    expect(text).not.toMatch(/Erdal Ozkan\n/);
  });

  it("the organisers see the names in their own group even when they announce the list", () => {
    const base = input({ audience: "organisers" });
    const state = { ...base.state, features: { ...base.state.features, listAnnouncer: "organisers" as const } };
    expect(buildOpenAnswerContext({ ...base, state }).text).toMatch(/1\. Kemal Ediz/);
  });

  it("a club with attendance off holds no squad at all", () => {
    const base = input();
    const state = { ...base.state, features: { ...base.state.features, attendance: false } };
    const { text } = buildOpenAnswerContext({ ...base, state });
    expect(text).toMatch(/does not keep a squad/i);
    expect(text).not.toMatch(/1\. Kemal Ediz/);
  });

  it("a squad the batch could not vouch for (squadKnown false) is not shown", () => {
    const { text } = buildOpenAnswerContext(input({ squadKnown: false }));
    expect(text).not.toMatch(/1\. Kemal Ediz/);
    expect(text).toMatch(/squad is not available/i);
  });

  it("a club with stats Q&A off holds no stats", () => {
    const base = input();
    const state = { ...base.state, features: { ...base.state.features, statsQa: false } };
    const { text } = buildOpenAnswerContext({ ...base, state });
    expect(text).not.toContain("16 matches");
    expect(text).not.toMatch(/completed games/i);
  });

  it("the stats are the top of each table only, never another player's nemesis", () => {
    const stats: StatsSnapshot = {
      ...STATS,
      chemistry: { "u-sait": { userId: "u-sait", name: "Sait Demir", bestByWinRate: null, bestByRating: null, nemesis: { name: "Idris Bello", gamesAgainst: 5, wins: 1 } } },
    };
    expect(buildOpenAnswerContext(input({ stats })).text).not.toMatch(/nemesis/i);
  });
});

describe("the prompt", () => {
  it("is one plain task with the rules defined once, no dashes and no 'waiting list'", () => {
    expect(OPEN_ANSWER_SYSTEM).not.toMatch(/[–—]/);
    expect(OPEN_ANSWER_SYSTEM).not.toMatch(/waiting list/i);
    expect(OPEN_ANSWER_SYSTEM).toMatch(/only the CONTEXT/);
    expect(OPEN_ANSWER_SYSTEM.match(/never say you did/gi)?.length ?? 0).toBe(1);
  });

  it("is above Haiku 5.5's cache floor (512 tokens at the measured 2.6 characters a token)", () => {
    expect(OPEN_ANSWER_SYSTEM.length / 2.6).toBeGreaterThan(512);
  });
});

function stub(text: string | (() => never)): { model: PipelineModel; reqs: ModelRequest[] } {
  const reqs: ModelRequest[] = [];
  return {
    reqs,
    model: {
      name: "stub",
      async complete(req: ModelRequest): Promise<ModelResponse> {
        reqs.push(req);
        if (typeof text === "function") text();
        return {
          text: text as string,
          stopReason: "end_turn",
          usage: { inputTokens: 1500, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0.0004,
          ms: 900,
        };
      },
    },
  };
}

describe("the call", () => {
  it("is ONE Haiku call with the shared posture, a hard token cap, the system prompt and the context as the user turn", async () => {
    const { model, reqs } = stub(JSON.stringify({ answer: "A suggestion, by games played: Erdal Ozkan (12) then Zair Malik (3)." }));
    const r = await answerOpenQuestion({ model, ...input() });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].model).toBe(HAIKU_CALL.model);
    expect(reqs[0].thinking).toEqual(HAIKU_CALL.thinking);
    expect(reqs[0].maxTokens).toBe(HAIKU_SHORT_ANSWER_MAX_TOKENS);
    expect(reqs[0].system).toBe(OPEN_ANSWER_SYSTEM);
    expect(reqs[0].label).toBe("open-answer");
    expect(reqs[0].user).toBe(buildOpenAnswerContext(input()).text);
    expect(r.result).toEqual({ text: "A suggestion, by games played: Erdal Ozkan (12) then Zair Malik (3)." });
    expect(r.called).toBe(true);
    expect(r.costUsd).toBeCloseTo(0.0004);
  });

  it("strips dashes used as punctuation", async () => {
    const { model } = stub(JSON.stringify({ answer: "I can't see the weather — kickoff is Tue 21:30." }));
    const r = await answerOpenQuestion({ model, ...input() });
    expect(r.result).toEqual({ text: expect.not.stringMatching(/[–—]/) });
  });

  it("never throws: a failed call is rejected", async () => {
    const { model } = stub(() => {
      throw new Error("529 Overloaded");
    });
    const r = await answerOpenQuestion({ model, ...input() });
    expect(r.result).toEqual({ rejected: expect.stringMatching(/529/) });
  });

  it("an empty or unparseable reply is rejected", async () => {
    for (const body of ["", "not json", JSON.stringify({ answer: "  " })]) {
      const { model } = stub(body);
      const r = await answerOpenQuestion({ model, ...input() });
      expect("rejected" in r.result, body).toBe(true);
    }
  });

  it("a number the context does not hold is rejected (never invent a number)", async () => {
    const { model } = stub(JSON.stringify({ answer: "Erdal Ozkan has played 40 games." }));
    const r = await answerOpenQuestion({ model, ...input() });
    expect(r.result).toEqual({ rejected: expect.stringMatching(/40/) });
  });

  it("a phone number in the reply is rejected", async () => {
    const { model } = stub(JSON.stringify({ answer: "Call Elvin on 07700 900123." }));
    const r = await answerOpenQuestion({ model, ...input() });
    expect("rejected" in r.result).toBe(true);
  });
});
