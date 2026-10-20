/**
 * THE GENERIC STATS ANSWER'S REQUEST (2026-10-20 rewrite).
 *
 * `answer-batch-stats.test.ts` covers the path end to end (grounding,
 * the safe line). These pin the request itself: the shipped model and
 * thinking posture, structured output, room for Haiku's thinking, and
 * the language instruction in the user turn. The prompt's behaviour is
 * judged by the paid check, `scripts/live-check-stats-generic.ts`.
 */
import { describe, expect, it } from "vitest";
import { HAIKU_CALL, type ModelRequest, type PipelineModel } from "../llm";
import { HAIKU_SHORT_ANSWER_MAX_TOKENS } from "../../models";
import { answerGenericStats, buildGenericStatsContext, STATS_GENERIC_CALL, STATS_GENERIC_SYSTEM } from "../stats-generic";
import type { Member, StatsSnapshot } from "../types";

const SNAP: StatsSnapshot = {
  fullTableUrl: "https://matchtime.ai/profile/stats",
  ratings: [{ userId: "u-ali", name: "Ali Kaya", avg: 8.2, games: 11, rank: 1, delta: 0 }],
  mom: [{ userId: "u-ali", name: "Ali Kaya", wins: 3 }],
  elo: [],
  teamOfSeason: null,
  mrReliable: [],
  aliases: [],
  chemistry: {},
  appearances: [],
  recordsStart: { matches: null, mom: null },
  periods: {},
  generic: {},
} as unknown as StatsSnapshot;
const ROSTER: Member[] = [{ userId: "u-ali", name: "Ali Kaya", isAdmin: false, hasPhone: true }];

function stub(answer: string) {
  const reqs: ModelRequest[] = [];
  const model: PipelineModel = {
    name: "stub",
    async complete(req) {
      reqs.push(req);
      return {
        text: JSON.stringify({ answer }),
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 1,
      };
    },
  };
  return { model, reqs };
}

const ask = (model: PipelineModel, lang: "en" | "tr", question = "who has the most man of the match awards?") =>
  answerGenericStats({ model, snapshot: SNAP, lang, question, personUserId: null, self: false, roster: ROSTER });

describe("the generic stats request", () => {
  it("is the shipped call, with structured output", async () => {
    const { model, reqs } = stub("Ali Kaya: 3.");
    const res = await ask(model, "en");
    expect(res.result).toEqual({ text: "Ali Kaya: 3." });
    const r = reqs[0];
    expect(r.label).toBe("stats-generic");
    expect(r.model).toBe(STATS_GENERIC_CALL.model);
    expect(r.thinking).toEqual(STATS_GENERIC_CALL.thinking);
    expect(r.system).toBe(STATS_GENERIC_SYSTEM);
    expect((r.schema as { required: string[] }).required).toEqual(["answer"]);
  });

  it("leaves room for Haiku's thinking", async () => {
    const { model, reqs } = stub("Ali Kaya: 3.");
    await ask(model, "en");
    if (STATS_GENERIC_CALL.model === HAIKU_CALL.model) {
      expect(reqs[0].maxTokens).toBeGreaterThanOrEqual(HAIKU_SHORT_ANSWER_MAX_TOKENS);
    }
  });

  it("a Turkish group's user turn says to answer in Turkish; an English group's says nothing extra", async () => {
    const tr = stub("Ali Kaya: 3.");
    await ask(tr.model, "tr", "en çok maçın adamı seçilen kim?");
    expect(tr.reqs[0].user).toMatch(/TURKISH/);
    const en = stub("Ali Kaya: 3.");
    await ask(en.model, "en");
    expect(en.reqs[0].user).not.toMatch(/LANGUAGE/);
    expect(en.reqs[0].user.split("\n").slice(-1)[0]).toBe("QUESTION: who has the most man of the match awards?");
  });

  it("the prompt names no club, writes no long dash, and keeps the NO_ANSWER contract the grounding check reads", () => {
    expect(STATS_GENERIC_SYSTEM).toContain("NO_ANSWER");
    expect(STATS_GENERIC_SYSTEM).not.toMatch(/[\u2013\u2014]/);
    expect(STATS_GENERIC_SYSTEM).not.toMatch(/Sutton|FNF|Vets/);
    expect(STATS_GENERIC_SYSTEM).not.toMatch(/football club/i);
  });

  it("a climb in the ratings is said in places, so it cannot be read as rating points", () => {
    const snapshot = { ...SNAP, ratings: [{ userId: "u-ali", name: "Ali Kaya", avg: 8.2, games: 11, rank: 1, delta: 2 }] } as StatsSnapshot;
    const ctx = buildGenericStatsContext({ snapshot, lang: "en", personUserId: null, self: false, roster: ROSTER });
    expect(ctx.text).toContain("1. Ali Kaya: 8.2 from 11 rated matches (up 2 places in the table since the last match)");
  });
});
