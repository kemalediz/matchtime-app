/**
 * THE PLAYERS' GROUP'S DEAD ENDS (2026-11-17), `dead-end-answer.ts`: which
 * outcomes are dead ends (by the outcome's intent, never the words), and the
 * one call that hands them to the unified answer. Made-up people, a stub
 * model, no database.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../pipeline/llm";
import type { AnswerBatchMessage } from "../pipeline/answer-batch";
import type { OrgFeatures } from "../org-features";
import type { Route } from "../pipeline/types";
import { NOW, fullName, world } from "../pipeline/__tests__/helpers";
import { answerDeadEnds, DEAD_END_INTENTS, isDeadEnd } from "../dead-end-answer";

const FEATURES = { botEnabled: true, attendance: true, bench: true, teamBalancing: true, statsQa: false, language: "en" } as OrgFeatures;

/** One answer, or one per message body (the last line of the user turn). */
function stub(answer: string | Error | ((body: string) => string)) {
  const reqs: ModelRequest[] = [];
  const model: PipelineModel = {
    name: "stub",
    async complete(req): Promise<ModelResponse> {
      reqs.push(req);
      if (answer instanceof Error) throw answer;
      const text = typeof answer === "function" ? answer(req.user.trimEnd().split("\n").pop() ?? "") : answer;
      return { text: JSON.stringify({ answer: text }), stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.001, ms: 1 };
    },
  };
  return { model, reqs };
}

const msg = (id: string, body: string, route: Route): AnswerBatchMessage => ({
  waMessageId: id,
  body,
  authorName: fullName("sait"),
  senderUserId: "u-sait",
  senderName: fullName("sait"),
  tagged: true,
  addressed: true,
  route,
  gated: false,
});

describe("which outcomes are dead ends", () => {
  it("the admin extractor's 'other', a team change MatchTime cannot make, and nothing at all", () => {
    expect([...DEAD_END_INTENTS].sort()).toEqual(["not_understood", "request_not_handled", "team_request_unsupported"]);
  });

  it("a dead end only when the message really tagged MatchTime and something canned was said", () => {
    expect(isDeadEnd({ intent: "request_not_handled", reply: "Sorry, I can't do that one yet." }, true)).toBe(true);
    expect(isDeadEnd({ intent: "not_understood", reply: "I didn't catch..." }, true)).toBe(true);
    expect(isDeadEnd({ intent: "request_not_handled", reply: "Sorry" }, false)).toBe(false);
    expect(isDeadEnd({ intent: "unified_answer", reply: "11 places left." }, true)).toBe(false);
    expect(isDeadEnd({ intent: "in", reply: null }, true)).toBe(false);
    expect(isDeadEnd({ intent: "team_request_unsupported", reply: null }, true)).toBe(false);
  });
});

describe("answerDeadEnds", () => {
  const state = world({ confirmed: ["kemal", "sait"], bench: [] });
  const base = {
    orgId: "org-1",
    now: NOW,
    history: [],
    expectedMatchId: state.matchId,
    enabled: new Set<Route>(),
  };
  const deps = (model: PipelineModel) => ({
    model,
    loadState: async () => state,
    loadFeatures: async () => FEATURES,
    loadResults: async () => ({ since: null, more: false, rows: [] }),
    loadClub: async () => ({ collectorName: null, feePerPlayer: null, feeSplitTotal: false, teamsReady: "off" as const }),
    loadStats: async () => ({ fullTableUrl: "", ratings: [], mom: [], elo: [], teamOfSeason: null, mrReliable: [], aliases: [], appearances: [], recordsStart: { matches: null, mom: null }, completedMatches: 0 }),
    loadStatsPeriod: async () => ({ appearances: [], ratings: [], mom: [] }),
    loadChemistry: async () => null,
    loadClubFacts: async () => ({ pool: { open: false, platformOpen: false, clubFlag: false }, partners: { active: 0 } }),
    helpReply: async () => "ℹ️ *MatchTime help*",
  });

  it("each dead end gets its unified answer, whatever route it came on", async () => {
    const { model, reqs } = stub((body) =>
      body.includes("pitch") ? "I can't book pitches. Tag me with help to see what I can do." : "What would you like me to do?",
    );
    const out = await answerDeadEnds({
      ...base,
      messages: [msg("wa-1", "@Match Time book the pitch for Friday", "admin_ops"), msg("wa-2", "@Match Time do the thing", "unsure")],
      deps: deps(model),
    });
    expect(out.get("wa-1")).toEqual({ reply: "I can't book pitches. Tag me with help to see what I can do.", intent: "unified_answer" });
    expect(out.get("wa-2")).toEqual({ reply: "What would you like me to do?", intent: "unified_answer" });
    expect(reqs.map((r) => r.label)).toEqual(["unified-answer", "unified-answer"]);
  });

  it("a failed answer gives nothing back, and never throws: the caller keeps its line", async () => {
    const { model } = stub(new Error("529 overloaded"));
    const out = await answerDeadEnds({ ...base, messages: [msg("wa-1", "@Match Time book the pitch", "admin_ops")], deps: deps(model) });
    expect(out.size).toBe(0);
  });

  it("a state that cannot be read gives nothing back", async () => {
    const { model } = stub("x");
    const out = await answerDeadEnds({
      ...base,
      messages: [msg("wa-1", "@Match Time book the pitch", "admin_ops")],
      deps: { ...deps(model), loadState: async () => Promise.reject(new Error("db down")) },
    });
    expect(out.size).toBe(0);
  });

  it("no messages: no call", async () => {
    const { model, reqs } = stub("x");
    expect((await answerDeadEnds({ ...base, messages: [], deps: deps(model) })).size).toBe(0);
    expect(reqs).toEqual([]);
  });
});
