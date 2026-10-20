/**
 * ONE EXTRACTION PER MESSAGE PER BATCH (Sutton FC, 2026-10-20).
 *
 * "@Match Time generate the teams" at 08:01 UTC, batch f3898ab5: the
 * router said `balancer`, and then the TEAMS extractor ran TWICE on the
 * same message with the same 1,529-token input and returned the same
 * facts, once for the answer owner and once for the team-ops owner. The
 * analyze route hands every message to every owner in turn
 * (`runAnswerBatch`, then `runScoreBatch`, `runAdminOpsBatch`,
 * `runTeamOpsBatch`), and `balancer` has TWO owners split on a fact the
 * extractor returns (`show` is the answer's, `generate` is team-ops'),
 * so each owner extracted it for itself. Double the cost, ~2 s more.
 *
 * These run the owners the way `route.ts` does, in sequence inside one
 * request (`withAnalyzeBatch` + `withPipelineTrace`), with one model that
 * COUNTS its calls, and pin: each (message, extractor) pair is asked once
 * per request, every owner reads the same facts, and the trace shows one
 * extraction with the owners that shared it.
 */
import { describe, expect, it } from "vitest";
import { withAnalyzeBatch } from "../../analyze-batch-context";
import type { OrgFeatures } from "../../org-features";
import { runTeamOpsBatch } from "../../team-ops-engine-batch";
import { runAnswerBatch } from "../answer-batch";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import { extractForRouteTraced, persistPipelineTraces, withPipelineTrace, type PipelineTrace } from "../trace";
import type { Route } from "../types";
import { NOW, fullName, world } from "./helpers";
import type { QuotedGroupMessage } from "../../reply-context";

const SQUAD = ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat"];
const GEN = "@Match Time generate the teams";
const SHOW = "@Match Time show the teams";
const GEN_FACTS = { action: "generate", includeRefs: [], teamNames: [], swaps: [], moves: [], pairings: [] };
const SHOW_FACTS = { ...GEN_FACTS, action: "show" };

const FEATURES: OrgFeatures = {
  botEnabled: true,
  attendance: true,
  bench: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  reminders: true,
  statsQa: true,
  paymentTracking: false,
  paymentCollection: false,
  squadFromList: false,
  language: "en",
  rollingSquad: false,
  benchPickMode: "first-come",
  badgeAnnouncements: true,
  squadMode: "weekly",
};

/** Answers from a table keyed on the message body (the user turn's last
 *  line), and records every call it was asked to make. */
function countingModel(table: Record<string, unknown>, opts: { failFirst?: boolean } = {}) {
  const calls: string[] = [];
  let failed = false;
  const model: PipelineModel = {
    name: "test-stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const body = req.user.split("\n").slice(-1)[0];
      calls.push(`${req.label}|${body}`);
      if (opts.failFirst && !failed) {
        failed = true;
        throw new Error("529 Overloaded");
      }
      const payload = table[body];
      if (payload === undefined) throw new Error(`no stub for "${body}"`);
      return {
        text: JSON.stringify(payload),
        stopReason: "end_turn",
        usage: { inputTokens: 1529, outputTokens: 46, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.005874,
        ms: 2100,
      };
    },
  };
  return { model, calls };
}

function message(body: string, reply?: QuotedGroupMessage) {
  return {
    ...(reply ? { reply } : {}),
    waMessageId: `wa-${body.slice(-9).replace(/\s/g, "-")}`,
    body,
    authorName: fullName("kemal"),
    senderUserId: "u-kemal",
    senderName: fullName("kemal"),
    tagged: true,
    route: "balancer" as Route,
    gated: false,
  };
}

/** One analyze request: the answer owner, then the team-ops owner, the
 *  order `route.ts` runs them in, and the traces it would save. */
async function analyzeRequest(model: PipelineModel, bodies: string[], reply?: (state: { matchId: string | null }) => QuotedGroupMessage) {
  const state = world({ confirmed: SQUAD });
  const generated: string[] = [];
  const saved = new Map<string, PipelineTrace>();
  const messages = bodies.map((b) => message(b, reply?.(state)));
  const result = await withAnalyzeBatch(() =>
    withPipelineTrace(async () => {
      const answer = await runAnswerBatch({
        orgId: "org-1",
        now: NOW,
        messages,
        history: [],
        expectedMatchId: state.matchId,
        enabled: new Set<Route>(["question", "balancer"]),
        deps: { model, loadState: async () => state, loadFeatures: async () => FEATURES },
      });
      const teamOps = await runTeamOpsBatch({
        orgId: "org-1",
        now: NOW,
        messages,
        history: [],
        enabled: new Set<Route>(["balancer"]),
        deps: {
          model,
          loadState: async () => state,
          loadFeatures: async () => FEATURES,
          selectTeamsMatch: async () => ({ id: state.matchId!, date: NOW }),
          forceConfirm: async () => {},
          generateTeams: async (matchId) => {
            generated.push(matchId);
            return { ok: true, groupPost: "⚽ *Teams*" };
          },
        },
      });
      await persistPipelineTraces(async (id, t) => {
        saved.set(id, t);
      });
      return { answer, teamOps };
    }),
  );
  return { ...result, generated, saved, messages };
}

describe("one 'generate the teams' message costs ONE teams extractor call", () => {
  it("the answer owner and the team-ops owner share one extraction", async () => {
    const { model, calls } = countingModel({ [GEN]: GEN_FACTS });
    const { answer, teamOps, generated, saved, messages } = await analyzeRequest(model, [GEN]);
    const id = messages[0].waMessageId;

    expect(calls).toEqual([`extractor:teams|${GEN}`]);
    // Both owners still decided from the facts: answer left `generate`
    // alone, team-ops owned it and built the teams.
    expect(answer.ownedIds.has(id)).toBe(false);
    expect(teamOps.ownedIds.has(id)).toBe(true);
    expect(generated).toHaveLength(1);
    // Team-ops read the facts, it made no call, so it reports none.
    expect(teamOps.cost.calls).toBe(0);

    const t = saved.get(id)!;
    expect(t.extractions).toHaveLength(1);
    expect(t.extractions[0]).toMatchObject({ owner: "answer", extractor: "teams", sharedWith: ["team_ops"] });
    expect(t.extractions[0].calls).toHaveLength(1);
  });

  it("'show the teams' is still answered, from one call", async () => {
    const { model, calls } = countingModel({ [SHOW]: SHOW_FACTS });
    const { answer, teamOps, messages } = await analyzeRequest(model, [SHOW]);
    expect(calls).toEqual([`extractor:teams|${SHOW}`]);
    expect(answer.ownedIds.has(messages[0].waMessageId)).toBe(true);
    expect(teamOps.ownedIds.has(messages[0].waMessageId)).toBe(false);
  });

  it("two different messages are each extracted once", async () => {
    const { model, calls } = countingModel({ [GEN]: GEN_FACTS, [SHOW]: SHOW_FACTS });
    await analyzeRequest(model, [SHOW, GEN]);
    expect([...calls].sort()).toEqual([`extractor:teams|${GEN}`, `extractor:teams|${SHOW}`].sort());
  });
});

// ── The memo itself, for every extractor ───────────────────────────────

const RAW: Record<string, string> = {
  attendance: JSON.stringify({ claims: [], affirmation: "none", sideRequests: [] }),
  question: JSON.stringify({ topic: "count", personRef: "", table: "other", period: "", since: "", lastMatches: 0 }),
  teams: JSON.stringify(GEN_FACTS),
  score: JSON.stringify({ hasScore: true, first: 7, second: 4 }),
  admin: JSON.stringify({ action: "other", coveredRefs: [], undo: false, matchDay: "" }),
};

function rawModel(text: string, opts: { fail?: number } = {}) {
  let n = 0;
  const model: PipelineModel = {
    name: "fake",
    async complete() {
      n += 1;
      if (opts.fail && n <= opts.fail) throw new Error("529 Overloaded");
      return {
        text,
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.001,
        ms: 3,
      };
    },
  };
  return { model, count: () => n };
}

const m = (id: string, body = "x", over: Record<string, unknown> = {}) => ({
  id,
  body,
  authorName: "Kemal",
  tagged: true,
  history: [],
  lastBotPost: null,
  ...over,
});

const ROUTE_FOR: Record<string, Route> = {
  attendance: "self_att",
  question: "question",
  teams: "balancer",
  score: "score",
  admin: "admin_ops",
};

describe("the per-request memo", () => {
  for (const kind of Object.keys(RAW)) {
    it(`${kind}: asked twice for the same message, the model is called once`, async () => {
      const { model, count } = rawModel(RAW[kind]);
      await withPipelineTrace(async () => {
        const a = await extractForRouteTraced("one", model, ROUTE_FOR[kind], m("wa-1"));
        const b = await extractForRouteTraced("two", model, ROUTE_FOR[kind], m("wa-1"));
        expect(b.facts).toEqual(a.facts);
        // The second reader made no call, so it reports none.
        expect(a.usage).toBeDefined();
        expect(b.usage).toBeUndefined();
      });
      expect(count()).toBe(1);
    });
  }

  it("a different input is a different extraction", async () => {
    const { model, count } = rawModel(RAW.teams);
    await withPipelineTrace(async () => {
      await extractForRouteTraced("answer", model, "balancer", m("wa-1"));
      await extractForRouteTraced("team_ops", model, "balancer", m("wa-1", "x", { lastBotPost: "a quoted post" }));
      await extractForRouteTraced("team_ops", model, "balancer", m("wa-2"));
    });
    expect(count()).toBe(3);
  });

  it("a failed extraction is not shared: the next owner asks again", async () => {
    const { model, count } = rawModel(RAW.teams, { fail: 1 });
    await withPipelineTrace(async () => {
      const a = await extractForRouteTraced("answer", model, "balancer", m("wa-1"));
      expect(a.facts.kind).toBe("none");
      const b = await extractForRouteTraced("team_ops", model, "balancer", m("wa-1"));
      expect(b.facts.kind).toBe("teams");
    });
    expect(count()).toBe(2);
  });

  it("one owner changing its facts does not change another owner's", async () => {
    const { model } = rawModel(RAW.question);
    await withPipelineTrace(async () => {
      const a = await extractForRouteTraced("answer", model, "question", m("wa-1"));
      (a.facts as { personRef: string }).personRef = "Kemal";
      const b = await extractForRouteTraced("other", model, "question", m("wa-1"));
      expect((b.facts as { personRef: string | null }).personRef).not.toBe("Kemal");
    });
  });

  it("two requests never share an extraction", async () => {
    const { model, count } = rawModel(RAW.score);
    await withPipelineTrace(() => extractForRouteTraced("score", model, "score", m("wa-1")));
    await withPipelineTrace(() => extractForRouteTraced("score", model, "score", m("wa-1")));
    expect(count()).toBe(2);
  });
});

// QUOTED-REPLY CONTEXT, SLICE S4 (2026-10-20). A balancer message that is a
// WhatsApp reply: both owners show the extractor the SAME shared group block
// (the quote, narrowed to the match both act on, and the time now), so the
// two still share one call. The quote is part of the memo key: a different
// quote is a different input.
describe("a balancer reply shares one extraction too", () => {
  const post = (matchId: string | null): QuotedGroupMessage => ({
    author: null,
    at: NOW,
    text: "📝 Teams for tonight: Red 1. Kemal ... Yellow 1. Elvin",
    topic: "teamBalancing",
    matchId,
    match: null,
    found: true,
  });

  it("replying to MatchTime's post on this match: one call, and the quote is in it", async () => {
    const seen: string[] = [];
    const { model, calls } = countingModel({ [GEN]: GEN_FACTS });
    const watched: PipelineModel = { name: model.name, complete: async (r) => (seen.push(r.user), model.complete(r)) };
    await analyzeRequest(watched, [GEN], (st) => post(st.matchId));
    expect(calls).toEqual([`extractor:teams|${GEN}`]);
    expect(seen[0]).toContain("THEY ARE REPLYING TO MatchTime's message");
  });

  it("replying to another match's post: both owners show it alike, still one call", async () => {
    const seen: string[] = [];
    const { model, calls } = countingModel({ [GEN]: GEN_FACTS });
    const watched: PipelineModel = { name: model.name, complete: async (r) => (seen.push(r.user), model.complete(r)) };
    await analyzeRequest(watched, [GEN], () => post("an-older-match"));
    expect(calls).toEqual([`extractor:teams|${GEN}`]);
    expect(seen[0]).toContain("THEY ARE REPLYING TO");
  });

  it("the quote is part of the key: the same words with a different quote are asked again", async () => {
    const { model, calls } = countingModel({ [GEN]: GEN_FACTS });
    await withAnalyzeBatch(() =>
      withPipelineTrace(async () => {
        const base = { id: "wa-x", body: GEN, authorName: "K", tagged: true, history: [], lastBotPost: null, now: NOW };
        await extractForRouteTraced("answer", model, "balancer", { ...base, reply: post(null) });
        await extractForRouteTraced("team_ops", model, "balancer", { ...base, reply: post(null) });
        await extractForRouteTraced("team_ops", model, "balancer", { ...base, reply: { ...post(null), text: "another post" } });
      }),
    );
    expect(calls).toHaveLength(2);
  });
});

