/**
 * THE UNIFIED ANSWER's context and call (`unified-answer.ts`, UNIFIED_ANSWERS).
 * The privacy rules live in the context builder, by audience: what the model
 * is not told it cannot leak.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import { HAIKU_CALL } from "../llm";
import { answerUnified, buildUnifiedContext, UNIFIED_ANSWER_SYSTEM, type UnifiedAnswerInput } from "../unified-answer";
import type { ClubSnapshot, StatsSnapshot } from "../types";
import { NOW, fullName, world } from "./helpers";

const CLUB: ClubSnapshot = { collectorName: "Elvin Aliyev", feePerPlayer: 6.5, feeSplitTotal: false, teamsReady: "10:00" };
const STATS: StatsSnapshot = {
  fullTableUrl: "https://matchtime.ai/profile/stats",
  ratings: [{ userId: "u-erdal", name: fullName("erdal"), avg: 7.4, games: 9, rank: 1, delta: 1 }],
  mom: [{ userId: "u-sait", name: fullName("sait"), wins: 4 }],
  elo: [],
  teamOfSeason: null,
  mrReliable: [],
  aliases: [],
  chemistry: {},
  appearances: [{ userId: "u-erdal", name: fullName("erdal"), matches: 12 }],
  recordsStart: { matches: new Date("2026-04-07T19:00:00.000Z"), mom: null },
  completedMatches: 14,
  generic: {},
  periods: {},
};

function input(over: Partial<UnifiedAnswerInput> = {}): UnifiedAnswerInput {
  const st = world({ confirmed: ["kemal", "sait", "idris"], bench: ["erdal", "zair"], noPhone: ["idris"] });
  return {
    audience: "players",
    state: { ...st, club: CLUB },
    squadKnown: true,
    stats: STATS,
    results: { since: null, more: false, rows: [{ dayLabel: "Tue 3 Nov", redLabel: "Red", yellowLabel: "Yellow", red: 5, yellow: 3 }] },
    payments: { kind: "counted", chargeable: 13, unpaid: 4, kickoffLabel: "Tue 21:30" },
    ratingProgress: { ok: true, matchName: "Tuesday", matchWhen: "3 Nov", confirmed: 14, ratedCount: 9, momCount: 8, notRated: [fullName("zair")], ratedNoMom: [] },
    history: [{ author: fullName("elvin"), body: "call me on 07943 789944 if late", at: new Date("2026-09-01T10:00:00.000Z") }],
    lastBotPost: null,
    reply: null,
    now: NOW,
    question: "@Match Time how many spaces left?",
    askerUserId: "u-sait",
    askerName: fullName("sait"),
    ...over,
  };
}

describe("the context: the club's data", () => {
  it("holds the squad and bench in order, places left, fee, results, the tables and the asker", () => {
    const { text } = buildUnifiedContext(input());
    expect(text).toContain(`WHO IS ASKING: ${fullName("sait")}, a member, in the players' group`);
    expect(text).toMatch(/In the squad: 3 of 14\. Places left: 11\. On the bench: 2\./);
    expect(text).toContain(`1. ${fullName("erdal")}`);
    expect(text).toContain("£6.50 a player");
    expect(text).toContain("Tue 3 Nov: Red 5, Yellow 3");
    expect(text).toContain(`${fullName("erdal")}: 12 matches`);
    expect(text).toMatch(/recorded for this club: 14/);
    expect(text.trimEnd().endsWith("@Match Time how many spaces left?")).toBe(true);
  });

  it("says who has no number on record, never the number, and scrubs numbers from the chat", () => {
    const { text } = buildUnifiedContext(input());
    expect(text).toContain(`NO PHONE NUMBER ON RECORD (squad and bench): ${fullName("idris")}`);
    expect(text).not.toMatch(/07943|789944/);
    expect(text).toContain("[number hidden]");
  });
});

describe("the context: by audience (privacy)", () => {
  it("the players' group NEVER sees payments, and sees who has rated only by count", () => {
    const { text } = buildUnifiedContext(input());
    expect(text).not.toMatch(/4 of the 13/);
    expect(text).toMatch(/PAYMENTS: not shared in the players' group/);
    expect(text).toMatch(/9 of 14 who played have rated/);
    expect(text).not.toContain(`Not rated yet: ${fullName("zair")}`);
  });

  it("an admin asking in the players' group sees who has rated, still never payments", () => {
    const { text } = buildUnifiedContext(input({ askerUserId: "u-kemal", askerName: fullName("kemal") }));
    expect(text).toContain(`Not rated yet: ${fullName("zair")}`);
    expect(text).not.toMatch(/4 of the 13/);
  });

  it("the organisers see the payment count and who has rated", () => {
    const { text } = buildUnifiedContext(input({ audience: "organisers" }));
    expect(text).toMatch(/4 of the 13 who owe have not paid yet/);
    expect(text).toContain(`Not rated yet: ${fullName("zair")}`);
  });

  it("a club whose organisers post the list: the players' group gets counts, no names", () => {
    const base = input();
    const st = { ...base.state, features: { ...base.state.features, listAnnouncer: "organisers" as const } };
    const { text } = buildUnifiedContext(input({ state: st }));
    expect(text).not.toContain(`1. ${fullName("kemal")}`);
    expect(text).toMatch(/In the squad: 3 of 14/);
    expect(text).toMatch(/organisers post the list/);
    expect(buildUnifiedContext(input({ state: st, audience: "organisers" })).text).toContain(`1. ${fullName("kemal")}`);
  });

  it("a DM shows the asker's own blocks, no group chat, and who lacks a number only to an admin", () => {
    const dm = buildUnifiedContext(input({ audience: "dm", own: ["YOUR STATS:\n- Games played: 5/14"], dmChat: "NOW: Tue" }));
    expect(dm.text).toContain("YOUR STATS:");
    expect(dm.text).not.toContain("call me on");
    expect(dm.text).not.toMatch(/NO PHONE NUMBER ON RECORD/);
    expect(dm.text).not.toMatch(/4 of the 13/);
    expect(buildUnifiedContext(input({ audience: "dm", askerIsAdmin: true })).text).toMatch(/NO PHONE NUMBER ON RECORD/);
  });

  it("stats switched off: no tables at all", () => {
    const base = input();
    const st = { ...base.state, features: { ...base.state.features, statsQa: false } };
    const { text } = buildUnifiedContext(input({ state: st }));
    expect(text).not.toContain("12 matches");
    expect(text).toMatch(/stats answers switched off/);
  });
});

describe("the prompt", () => {
  it("is one plain task with EN and TR examples, no long dashes", () => {
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/Examples, English and Turkish/);
    expect(UNIFIED_ANSWER_SYSTEM).not.toMatch(/[–—]/);
    expect(UNIFIED_ANSWER_SYSTEM).toMatch(/changes nothing/);
  });
});

function stub(answer: string | Error) {
  const reqs: ModelRequest[] = [];
  const model: PipelineModel = {
    name: "stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      reqs.push(req);
      if (answer instanceof Error) throw answer;
      return {
        text: JSON.stringify({ answer }),
        stopReason: "end_turn",
        usage: { inputTokens: 5000, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0006,
        ms: 5,
      };
    },
  };
  return { model, reqs };
}

describe("the call", () => {
  it("one Haiku call, labelled, and a grounded reply is used", async () => {
    const { model, reqs } = stub("11 places left for Tue 21:30.");
    const r = await answerUnified({ ...input(), model });
    expect(r.result).toEqual({ text: "11 places left for Tue 21:30." });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].model).toBe(HAIKU_CALL.model);
    expect(reqs[0].label).toBe("unified-answer");
    expect(r.inputTokens).toBe(5000);
  });

  it("an invented number is refused", async () => {
    const { model } = stub("27 places left.");
    const r = await answerUnified({ ...input(), model });
    expect(r.result).toMatchObject({ rejected: expect.stringMatching(/grounding/) });
  });

  it("a number written as a word gets ONE second call, told to use digits", async () => {
    const answers = ["Eleven places left.", "11 places left."];
    const reqs: ModelRequest[] = [];
    const model: PipelineModel = {
      name: "stub",
      async complete(req) {
        reqs.push(req);
        return { text: JSON.stringify({ answer: answers[reqs.length - 1] }), stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.001, ms: 1 };
      },
    };
    const r = await answerUnified({ ...input(), model });
    expect(r.result).toEqual({ text: "11 places left." });
    expect(r.calls).toBe(2);
    expect(reqs[1].user).toMatch(/WRITE EVERY NUMBER IN DIGITS/);
    expect(r.costUsd).toBeCloseTo(0.002);
  });

  it("any other refusal is final: no second call", async () => {
    const { model, reqs } = stub("27 places left.");
    await answerUnified({ ...input(), model });
    expect(reqs).toHaveLength(1);
  });

  it("never throws", async () => {
    const { model } = stub(new Error("529 Overloaded"));
    const r = await answerUnified({ ...input(), model });
    expect(r.result).toMatchObject({ rejected: expect.stringMatching(/529/) });
  });
});
