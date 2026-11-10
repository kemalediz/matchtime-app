/**
 * `runAnswerBatch` for a tagged question that fits no set answer (topic
 * `other`, Kemal 2026-11-10). It used to be owned by nobody (the
 * not-understood line, or HQ's one line). It is now answered by ONE grounded
 * model call from the club's context (`open-answer.ts`), in the players'
 * group and in HQ through the same path, and:
 *
 *   - it never writes anything;
 *   - a failed or refused answer is disowned, so the asker keeps today's line;
 *   - untagged chatter is still never answered;
 *   - a batch whose other writes have not landed still holds it back.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import { runAnswerBatch, type AnswerBatchMessage } from "../answer-batch";
import type { OrgFeatures } from "../../org-features";
import type { ClubSnapshot, Route, SquadState, StatsSnapshot } from "../types";
import { NOW, fullName, world } from "./helpers";
import { answerHqQuestion } from "../../admin-group-question";
import { skipsSquadComposition } from "../../group-copy";
import { passesOrganisersNet } from "../../organisers-list-copy";

const FEATURES = {
  botEnabled: true,
  attendance: true,
  bench: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  reminders: true,
  statsQa: true,
  paymentTracking: true,
  paymentCollection: true,
  squadFromList: false,
  language: "en",
} as OrgFeatures;

const CLUB: ClubSnapshot = { collectorName: "Elvin Aliyev", feePerPlayer: 6.5, feeSplitTotal: false, teamsReady: "10:00" };
const TABLES: Omit<StatsSnapshot, "chemistry" | "generic" | "periods"> = {
  fullTableUrl: "https://matchtime.ai/profile/stats",
  ratings: [],
  mom: [],
  elo: [],
  teamOfSeason: null,
  mrReliable: [],
  aliases: [],
  appearances: [
    { userId: "u-erdal", name: fullName("erdal"), matches: 12 },
    { userId: "u-zair", name: fullName("zair"), matches: 3 },
  ],
  recordsStart: { matches: new Date("2026-04-07T19:00:00.000Z"), mom: null },
  completedMatches: 14,
};

const OTHER = {
  topic: "other",
  personRef: "",
  statedCount: -1,
  table: "none",
  listSize: -1,
  listEnd: "top",
  period: "none",
  periodCount: -1,
  periodUnit: "none",
  feature: "none",
};

const ANSWER = "A suggestion, by games played: Erdal Ozkan (12), then Zair Malik (3). It's the organisers' call.";

/** The extractor reads `other`; the open answer says `answer` (or throws). */
function stubModel(opts: { answer?: string | Error; facts?: Record<string, unknown> } = {}) {
  const reqs: ModelRequest[] = [];
  const model: PipelineModel = {
    name: "stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      reqs.push(req);
      let text: string;
      if (req.label === "open-answer") {
        const a = opts.answer ?? ANSWER;
        if (a instanceof Error) throw a;
        text = JSON.stringify({ answer: a });
      } else {
        text = JSON.stringify(opts.facts ?? OTHER);
      }
      return {
        text,
        stopReason: "end_turn",
        usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0005,
        ms: 10,
      };
    },
  };
  return { model, reqs };
}

const message = (body: string, over: Partial<AnswerBatchMessage> = {}): AnswerBatchMessage => ({
  waMessageId: "wa-1",
  body,
  authorName: fullName("kemal"),
  senderUserId: "u-kemal",
  senderName: fullName("kemal"),
  tagged: true,
  route: "question" as Route,
  gated: false,
  ...over,
});

const BODY = "@Match Time can you suggest the starting squad?";

async function ask(
  opts: {
    audience?: "players" | "organisers";
    state?: SquadState;
    answer?: string | Error;
    messages?: AnswerBatchMessage[];
    loadStats?: () => Promise<typeof TABLES>;
    expectedMatchId?: string | null;
  } = {},
) {
  const state = opts.state ?? world({ confirmed: ["kemal", "sait", "idris"], bench: ["erdal", "zair"] });
  const { model, reqs } = stubModel({ answer: opts.answer });
  const statsLoads: string[] = [];
  const res = await runAnswerBatch({
    orgId: "org-1",
    now: NOW,
    messages: opts.messages ?? [message(BODY)],
    history: [{ author: fullName("elvin"), body: "we should bring the regulars up from the bench" }],
    expectedMatchId: opts.expectedMatchId === undefined ? state.matchId : opts.expectedMatchId,
    enabled: new Set<Route>(["question", "self_att", "admin_ops"]),
    ...(opts.audience ? { audience: opts.audience } : {}),
    deps: {
      model,
      loadState: async () => state,
      loadFeatures: async () => FEATURES,
      loadClub: async () => CLUB,
      loadStats: async (orgId) => {
        statsLoads.push(orgId);
        return opts.loadStats ? opts.loadStats() : TABLES;
      },
    },
  });
  return { res, reqs, statsLoads, outcome: res.outcomes.get("wa-1") };
}

describe("a tagged question that fits no set answer", () => {
  it("is answered by the grounded open answer, with the club's context", async () => {
    const { res, reqs, outcome, statsLoads } = await ask();
    expect(outcome?.reply).toBe(ANSWER);
    expect(outcome?.intent).toBe("open_answer");
    expect([...res.ownedIds]).toEqual(["wa-1"]);
    const open = reqs.filter((r) => r.label === "open-answer");
    expect(open).toHaveLength(1);
    // The context: the chat, the squad and bench in order, the setup, the stats.
    expect(open[0].user).toContain("we should bring the regulars up from the bench");
    expect(open[0].user).toContain("1. Erdal Ozkan");
    expect(open[0].user).toContain("Elvin Aliyev");
    expect(open[0].user).toContain("Erdal Ozkan: 12 matches");
    expect(open[0].user).toMatch(/recorded for this club: 14/);
    expect(open[0].user.trimEnd().endsWith(BODY)).toBe(true);
    expect(statsLoads).toEqual(["org-1"]);
    // Two calls: the extractor and the answer. Counted in the batch's cost.
    expect(res.cost.calls).toBe(2);
  });

  it("NEVER WRITES: no write, and the outcome's action is a reply", async () => {
    const { res, outcome } = await ask();
    expect(res.writes).toEqual([]);
    expect(outcome?.action).toBe("reply");
  });

  it("a failed call is disowned, so the asker keeps today's line", async () => {
    const { res, outcome } = await ask({ answer: new Error("529 Overloaded") });
    expect(outcome).toBeUndefined();
    expect(res.ownedIds.size).toBe(0);
    expect(res.degradations.join(" ")).toMatch(/open answer not used.*529/);
  });

  it("an answer that invents a number is refused and disowned", async () => {
    const { res, outcome } = await ask({ answer: "Erdal Ozkan has played 40 games." });
    expect(outcome).toBeUndefined();
    expect(res.degradations.join(" ")).toMatch(/grounding check failed/);
  });

  it("is answered without the stats when the stats read throws", async () => {
    const { outcome, reqs } = await ask({
      loadStats: async () => {
        throw new Error("db down");
      },
      answer: "I can't see who the regulars are right now. Kickoff is Tue 21:30.",
    });
    expect(outcome?.reply).toMatch(/Tue 21:30/);
    expect(reqs.find((r) => r.label === "open-answer")!.user).not.toContain("matches");
  });

  it("a club with stats Q&A off reads no stats at all", async () => {
    const st = world({ confirmed: ["kemal"], features: { statsQa: false } });
    const { statsLoads, reqs } = await ask({ state: st, answer: "I can't tell that." });
    expect(statsLoads).toEqual([]);
    expect(reqs.find((r) => r.label === "open-answer")!.user).not.toMatch(/STATS/);
  });

  it("is still answered with no upcoming match, without a squad", async () => {
    const { outcome, reqs } = await ask({ state: world({ noMatch: true }), answer: "There's no game scheduled yet." });
    expect(outcome?.reply).toBe("There's no game scheduled yet.");
    expect(reqs.find((r) => r.label === "open-answer")!.user).toMatch(/no upcoming match/i);
  });

  it("a club that keeps no squad is answered without one", async () => {
    const st = world({ confirmed: ["kemal"], features: { attendance: false } });
    const { outcome, reqs } = await ask({ state: st, answer: "I don't keep the squad here." });
    expect(outcome?.reply).toBe("I don't keep the squad here.");
    expect(reqs.find((r) => r.label === "open-answer")!.user).not.toContain("1. Kemal Ediz");
  });

  it("untagged chatter is never answered (no extractor call, no answer)", async () => {
    const { res, reqs } = await ask({ messages: [message("lol who even are the regulars", { tagged: false, addressed: false })] });
    expect(res.outcomes.size).toBe(0);
    expect(reqs).toEqual([]);
  });

  it("is held back while another writer in the batch has not landed", async () => {
    const { res, reqs } = await ask({
      messages: [message(BODY), message("@Match Time remind me Friday", { waMessageId: "wa-2", route: "admin_ops" as Route })],
    });
    expect(res.outcomes.get("wa-1")).toBeUndefined();
    expect(reqs.filter((r) => r.label === "open-answer")).toEqual([]);
  });

  it("is answered beside an attendance message (its writes landed before this step)", async () => {
    const { outcome } = await ask({
      messages: [message(BODY), message("in", { waMessageId: "wa-2", route: "self_att" as Route, tagged: false })],
    });
    expect(outcome?.reply).toBe(ANSWER);
  });

  it("in the players' group of a club whose organisers announce the list, the model is told no names", async () => {
    const base = world({ confirmed: ["kemal", "sait"], bench: ["erdal"] });
    const st = { ...base, features: { ...base.features, listAnnouncer: "organisers" as const } };
    const { reqs } = await ask({ state: st, audience: "players", answer: "I can't share the list here." });
    const user = reqs.find((r) => r.label === "open-answer")!.user;
    expect(user).not.toContain("1. Kemal Ediz");
    expect(user).toMatch(/organisers post the list/i);
  });

  it("the organisers are told the names in HQ", async () => {
    const base = world({ confirmed: ["kemal", "sait"], bench: ["erdal"] });
    const st = { ...base, features: { ...base.features, listAnnouncer: "organisers" as const } };
    const { reqs } = await ask({ state: st, audience: "organisers", answer: "I can't tell that." });
    expect(reqs.find((r) => r.label === "open-answer")!.user).toContain("1. Kemal Ediz");
  });

  it("its reply is never swapped for the squad post, and stays under the organisers-mode net", () => {
    expect(skipsSquadComposition("open_answer")).toBe(true);
    expect(passesOrganisersNet("open_answer")).toBe(false);
  });
});

describe("in HQ (answerHqQuestion), the same path", () => {
  it("answers an open question for the organisers", async () => {
    const state = world({ confirmed: ["kemal", "sait"], bench: ["erdal", "zair"] });
    const { model, reqs } = stubModel();
    const out = await answerHqQuestion({
      orgId: "org-1",
      lang: "en",
      messageId: "hq-1",
      body: "@Match Time who are the regulars in this group based on what you know so far?",
      senderUserId: "u-kemal",
      senderName: fullName("kemal"),
      now: NOW,
      history: [{ author: fullName("elvin"), body: "we should bring the regulars up from the bench" }],
      lastBotPost: null,
      hqHelp: "menu",
      deps: { model, loadState: async () => state, loadFeatures: async () => FEATURES, loadClub: async () => CLUB, loadStats: async () => TABLES },
    });
    expect(out).toEqual({ outcome: "hq-answered", replyText: ANSWER });
    expect(reqs.filter((r) => r.label === "open-answer")).toHaveLength(1);
  });

  it("a failed open answer returns null, so HQ says its one line", async () => {
    const state = world({ confirmed: ["kemal"] });
    const { model } = stubModel({ answer: new Error("boom") });
    const out = await answerHqQuestion({
      orgId: "org-1",
      lang: "en",
      messageId: "hq-1",
      body: "@Match Time is it going to be cold tonight?",
      senderUserId: "u-kemal",
      senderName: fullName("kemal"),
      now: NOW,
      history: [],
      lastBotPost: null,
      hqHelp: "menu",
      deps: { model, loadState: async () => state, loadFeatures: async () => FEATURES, loadClub: async () => CLUB, loadStats: async () => TABLES },
    });
    expect(out).toBeNull();
  });
});
