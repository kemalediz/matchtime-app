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

/**
 * THE LAST MAN OF THE MATCH (2026-11-10). "@Match Time who was the last
 * MoM and for which game it was? How many votes did he get out of how many
 * votes?" is a question about ONE match. The generic answer, and the open
 * answer that shares this context, must hold that match's facts, and a name
 * from its vote count must pass the grounding check.
 */
describe("the last Man of the Match in the generic context", () => {
  const LAST = {
    last: {
      date: new Date("2026-10-20T19:30:00Z"),
      teamLabels: ["Red", "Yellow"] as [string, string],
      score: { red: 7, yellow: 9 },
      winners: [
        { userId: "u-habib", name: "Habib", votes: 2 },
        { userId: "u-mojib", name: "Mojib", votes: 2 },
      ],
      tally: [
        { userId: "u-habib", name: "Habib", votes: 2 },
        { userId: "u-mojib", name: "Mojib", votes: 2 },
        { userId: "u-sait", name: "Sait", votes: 1 },
      ],
      totalVotes: 5,
      pickedByOrganisers: false,
    },
    openVoteDate: null,
  };
  const roster: Member[] = [
    ...ROSTER,
    { userId: "u-habib", name: "Habib", isAdmin: false, hasPhone: true },
    { userId: "u-mojib", name: "Mojib", isAdmin: false, hasPhone: true },
    { userId: "u-sait", name: "Sait", isAdmin: false, hasPhone: true },
  ];

  it("is printed after the tables, with the match, the shared winners and the votes", () => {
    const snapshot = { ...SNAP, lastMom: LAST } as StatsSnapshot;
    const ctx = buildGenericStatsContext({ snapshot, lang: "en", personUserId: null, self: false, roster });
    expect(ctx.text).toContain("LAST MAN OF THE MATCH");
    expect(ctx.text).toContain("Red 7, Yellow 9 (Yellow won)");
    expect(ctx.text).toContain("shared between Habib and Mojib, with 2 votes each of the 5 votes cast");
    expect(ctx.grounding.names).toEqual(expect.arrayContaining(["Habib", "Mojib", "Sait"]));
  });

  it("an answer naming the winners and the votes passes the grounding check", async () => {
    const snapshot = { ...SNAP, lastMom: LAST } as StatsSnapshot;
    const { model } = stub("The last Man of the Match was shared by Habib and Mojib, 2 of 5 votes each, on Tue 20 Oct (Yellow won 9 to 7).");
    const res = await answerGenericStats({
      model,
      snapshot,
      lang: "en",
      question: "who was the last MoM?",
      personUserId: null,
      self: false,
      roster,
    });
    expect("text" in res.result).toBe(true);
  });

  it("a snapshot with no last Man of the Match facts reads exactly as before", () => {
    const ctx = buildGenericStatsContext({ snapshot: SNAP, lang: "en", personUserId: null, self: false, roster: ROSTER });
    expect(ctx.text).not.toContain("LAST MAN OF THE MATCH");
  });
});
