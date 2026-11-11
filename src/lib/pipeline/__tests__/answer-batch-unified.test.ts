/**
 * `runAnswerBatch` with UNIFIED_ANSWERS on (Kemal, 2026-11-10), and off.
 *
 * On: the small extractor says list, help, my_stats or anything else. The
 * list is the real squad post (people copy it), byte for byte what it is
 * today; the help is the help; "my stats" is the DM link; everything else is
 * ONE unified answer over the club's data, whose players' context never holds
 * payments (the payment read is not even made in the players' group).
 *
 * Off: the old extractor runs and the unified answer is never called.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import { runAnswerBatch, type AnswerBatchMessage } from "../answer-batch";
import type { OrgFeatures } from "../../org-features";
import type { ClubSnapshot, Route, SquadState, StatsSnapshot } from "../types";
import { NOW, fullName, world } from "./helpers";
import { answerHqQuestion } from "../../admin-group-question";

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
  appearances: [{ userId: "u-erdal", name: fullName("erdal"), matches: 12 }],
  recordsStart: { matches: null, mom: null },
  completedMatches: 14,
};

const OLD_SQUAD = {
  topic: "squad",
  personRef: "",
  statedCount: -1,
  table: "none",
  listSize: -1,
  listEnd: "top",
  period: "none",
  periodCount: -1,
  periodUnit: "none",
  feature: "none",
  badge: "none",
  answersClarification: false,
};

/** A model that answers each label: the old or the new extractor, and the
 *  unified answer. */
function stubModel(opts: { kind?: string; feature?: string; personRef?: string; answer?: string; old?: Record<string, unknown> } = {}) {
  const reqs: ModelRequest[] = [];
  const model: PipelineModel = {
    name: "stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      reqs.push(req);
      let text: string;
      if (req.label === "unified-answer") text = JSON.stringify({ answer: opts.answer ?? "11 places left for Tue 21:30." });
      else if (req.label === "extractor:question-unified")
        text = JSON.stringify({ kind: opts.kind ?? "other", personRef: opts.personRef ?? "", feature: opts.feature ?? "none", badge: "none" });
      else text = JSON.stringify(opts.old ?? OLD_SQUAD);
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
  authorName: fullName("sait"),
  senderUserId: "u-sait",
  senderName: fullName("sait"),
  tagged: true,
  route: "question" as Route,
  gated: false,
  ...over,
});

async function ask(opts: {
  unified: boolean;
  kind?: string;
  feature?: string;
  answer?: string;
  body?: string;
  state?: SquadState;
  audience?: "players" | "organisers";
  senderUserId?: string;
  features?: Partial<OrgFeatures>;
  personRef?: string;
}) {
  const state = opts.state ?? world({ confirmed: ["kemal", "sait", "idris"], bench: ["erdal", "zair"] });
  const { model, reqs } = stubModel(opts);
  const loads: string[] = [];
  const res = await runAnswerBatch({
    orgId: "org-1",
    now: NOW,
    messages: [message(opts.body ?? "@Match Time question", opts.senderUserId ? { senderUserId: opts.senderUserId } : {})],
    history: [],
    expectedMatchId: state.matchId,
    enabled: new Set<Route>(["question"]),
    unified: opts.unified,
    ...(opts.audience ? { audience: opts.audience } : {}),
    deps: {
      model,
      loadState: async () => state,
      loadFeatures: async () => ({ ...FEATURES, ...(opts.features ?? {}) }),
      loadClub: async () => CLUB,
      loadStats: async () => (loads.push("stats"), TABLES),
      loadLastMatchRatings: async () => (loads.push("lastMatchRatings"), { date: new Date("2026-08-25T20:30:00Z"), rows: [{ userId: "u-sait", name: fullName("sait"), avg: 7.4, count: 6 }] }),
      loadOwnStats: async (_o: string, userId: string) => (loads.push(`own:${userId}`), "THE ASKER'S OWN STATS:\n- Average rating: 6.8"),
      loadStatsPeriod: async () => (loads.push("period"), { appearances: [], ratings: [], mom: [] }),
      loadChemistry: async () => (loads.push("chemistry"), null),
      loadResults: async () => (loads.push("results"), { since: null, more: false, rows: [] }),
      loadPayments: async () => (loads.push("payments"), { kind: "counted", chargeable: 13, unpaid: 4, kickoffLabel: "Tue 21:30" }),
      loadRatingProgress: async () => (loads.push("rating"), { ok: true, confirmed: 14, ratedCount: 9, momCount: 8, notRated: [fullName("zair")] }),
      loadClubFacts: async () => (loads.push("clubFacts"), { pool: { open: false, platformOpen: false, clubFlag: false }, partners: { active: 1 } }),
      helpReply: async (req) => `HELP:${req.topic ?? "menu"}`,
    },
  });
  return { res, reqs, loads, outcome: res.outcomes.get("wa-1") };
}

describe("UNIFIED_ANSWERS on", () => {
  it("asking for the list posts the real squad list, exactly as the old path does", async () => {
    const on = await ask({ unified: true, kind: "list" });
    const off = await ask({ unified: false });
    expect(on.outcome?.reply).toBeTruthy();
    expect(on.outcome?.reply).toBe(off.outcome?.reply);
    expect(on.reqs.map((r) => r.label)).toEqual(["extractor:question-unified"]);
    expect(off.reqs.map((r) => r.label)).toEqual(["extractor:question"]);
  });

  it("help is the help, with its topic", async () => {
    const { outcome } = await ask({ unified: true, kind: "help", feature: "teams" });
    expect(outcome?.reply).toBe("HELP:teams");
    expect(outcome?.intent).toBe("help");
  });

  it("'my stats' is the private DM link, no answer in the group", async () => {
    const { outcome } = await ask({ unified: true, kind: "my_stats" });
    expect(outcome?.statsLinkRequest).toBe(true);
    expect(outcome?.reply).toBeNull();
  });

  it("anything else is ONE unified answer over the club's data", async () => {
    const { outcome, reqs, loads } = await ask({ unified: true, kind: "other" });
    expect(outcome?.reply).toBe("11 places left for Tue 21:30.");
    // Its own intent (2026-11-11), so the organisers-mode net lets it pass.
    expect(outcome?.intent).toBe("unified_answer");
    expect(reqs.map((r) => r.label)).toEqual(["extractor:question-unified", "unified-answer"]);
    expect(reqs.some((r) => r.label === "open-answer" || r.label === "stats-generic")).toBe(false);
    expect(loads).toEqual(expect.arrayContaining(["stats", "period", "results", "clubFacts"]));
  });

  it("the players' group: the payment read is never made, and the context has no payments", async () => {
    const { reqs, loads } = await ask({ unified: true, kind: "other", body: "@Match Time who hasn't paid?", answer: "I don't share payments in the group." });
    expect(loads).not.toContain("payments");
    const user = reqs.find((r) => r.label === "unified-answer")!.user;
    expect(user).not.toMatch(/4 of the 13/);
    expect(user).toMatch(/PAYMENTS: not shared in the players' group/);
  });

  it("the players' group: who has rated is read only when an admin asks", async () => {
    expect((await ask({ unified: true, kind: "other" })).loads).not.toContain("rating");
    expect((await ask({ unified: true, kind: "other", senderUserId: "u-kemal" })).loads).toContain("rating");
  });

  it("the organisers: payments and who has rated are in the context", async () => {
    const { reqs, loads } = await ask({ unified: true, kind: "other", audience: "organisers", answer: "4 of the 13 still owe." });
    expect(loads).toEqual(expect.arrayContaining(["payments", "rating"]));
    expect(reqs.find((r) => r.label === "unified-answer")!.user).toMatch(/4 of the 13 who owe have not paid yet/);
  });

  it("the list with no match to post is answered, not silent", async () => {
    const { outcome, reqs } = await ask({ unified: true, kind: "list", state: world({ noMatch: true }), answer: "There's no game scheduled yet." });
    expect(outcome?.reply).toBe("There's no game scheduled yet.");
    expect(reqs.find((r) => r.label === "unified-answer")!.user).toMatch(/no upcoming match/i);
  });

  it("a refused answer is disowned, so the asker keeps today's line", async () => {
    const { outcome, res } = await ask({ unified: true, kind: "other", answer: "99 places left." });
    expect(outcome).toBeUndefined();
    expect(res.degradations.join(" ")).toMatch(/unified answer not used/);
  });

  it("never writes", async () => {
    expect((await ask({ unified: true, kind: "other" })).res.writes).toEqual([]);
  });

  it("HQ goes through the same step, as the organisers", async () => {
    const state = world({ confirmed: ["kemal", "sait"], bench: ["erdal"] });
    const { model, reqs } = stubModel({ kind: "other", answer: "4 of the 13 still owe." });
    const loads: string[] = [];
    const r = await answerHqQuestion({
      orgId: "org-1",
      lang: "en",
      messageId: "hq-1",
      body: "@Match Time who hasn't paid?",
      senderUserId: "u-kemal",
      senderName: fullName("kemal"),
      now: NOW,
      history: [],
      lastBotPost: null,
      gates: {} as never,
      unified: true,
      deps: {
        model,
        loadState: async () => state,
        loadFeatures: async () => FEATURES,
        loadClub: async () => CLUB,
        loadStats: async () => TABLES,
        loadStatsPeriod: async () => ({ appearances: [], ratings: [], mom: [] }),
        loadResults: async () => ({ since: null, more: false, rows: [] }),
        loadPayments: async () => (loads.push("payments"), { kind: "counted", chargeable: 13, unpaid: 4, kickoffLabel: "Tue 21:30" }),
        loadRatingProgress: async () => ({ ok: false, reason: "no match" }),
        loadClubFacts: async () => ({ pool: { open: false, platformOpen: false, clubFlag: false }, partners: { active: 0 } }),
      },
    });
    expect(r?.replyText).toBe("4 of the 13 still owe.");
    expect(loads).toEqual(["payments"]);
    expect(reqs.find((x) => x.label === "unified-answer")!.user).toMatch(/organisers' own group \(HQ\)/);
  });
});

describe("UNIFIED_ANSWERS on: round 2 (2026-11-11)", () => {
  it("a monthly club's context carries the monthly squad's rules; a weekly club's does not", async () => {
    const monthly = await ask({ unified: true, kind: "other", features: { squadMode: "monthly" } as Partial<OrgFeatures> });
    expect(monthly.reqs.find((r) => r.label === "unified-answer")!.user).toMatch(/MONTHLY squad/);
    const weekly = await ask({ unified: true, kind: "other" });
    expect(weekly.reqs.find((r) => r.label === "unified-answer")!.user).not.toMatch(/MONTHLY squad/);
  });

  it("the ratings each player got in the last match are read for the organisers only", async () => {
    const org = await ask({ unified: true, kind: "other", audience: "organisers", answer: `${fullName("sait")} 7.4.` });
    expect(org.loads).toContain("lastMatchRatings");
    expect(org.reqs.find((r) => r.label === "unified-answer")!.user).toContain(`${fullName("sait")} 7.4 (6 ratings)`);
    const players = await ask({ unified: true, kind: "other" });
    expect(players.loads).not.toContain("lastMatchRatings");
  });

  it("HQ 'what is my rating?': answered there from the asker's own stats, no DM link", async () => {
    const { outcome, reqs, loads } = await ask({ unified: true, kind: "my_stats", audience: "organisers", senderUserId: "u-kemal", answer: "Your average rating is 6.8." });
    expect(outcome?.statsLinkRequest).toBe(false);
    expect(outcome?.reply).toBe("Your average rating is 6.8.");
    expect(loads).toContain("own:u-kemal");
    expect(reqs.find((r) => r.label === "unified-answer")!.user).toContain("THE ASKER'S OWN STATS:");
  });

  it("HQ, a question about the asker's own numbers (personRef me) gets them too", async () => {
    const { loads } = await ask({ unified: true, kind: "other", personRef: "me", audience: "organisers", senderUserId: "u-kemal", answer: "6.8." });
    expect(loads).toContain("own:u-kemal");
  });

  it("the players' group never reads the asker's own block (their stats go by DM)", async () => {
    const { loads } = await ask({ unified: true, kind: "other", personRef: "me", senderUserId: "u-sait" });
    expect(loads.some((l) => l.startsWith("own:"))).toBe(false);
  });
});

describe("UNIFIED_ANSWERS off", () => {
  it("the old extractor runs and nothing unified is called or read", async () => {
    const { reqs, loads } = await ask({ unified: false });
    expect(reqs.map((r) => r.label)).toEqual(["extractor:question"]);
    expect(loads).toEqual([]);
  });

  it("an old 'anything else' still gets the open answer, not the unified one", async () => {
    const reqs: string[] = [];
    const state = world({ confirmed: ["kemal"] });
    const model: PipelineModel = {
      name: "stub",
      async complete(req) {
        reqs.push(req.label);
        return {
          text: JSON.stringify(req.label === "open-answer" ? { answer: "I can't tell that." } : { ...OLD_SQUAD, topic: "other" }),
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 1,
        };
      },
    };
    const res = await runAnswerBatch({
      orgId: "org-1",
      now: NOW,
      messages: [message("@Match Time anything")],
      history: [],
      expectedMatchId: state.matchId,
      enabled: new Set<Route>(["question"]),
      deps: { model, loadState: async () => state, loadFeatures: async () => FEATURES, loadClub: async () => CLUB, loadStats: async () => TABLES },
    });
    expect(res.outcomes.get("wa-1")?.reply).toBe("I can't tell that.");
    expect(reqs).toEqual(["extractor:question", "open-answer"]);
  });
});
