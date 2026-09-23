/**
 * `runAnswerBatch` on the stats tables (2026-09-23): the targeted read,
 * the grounded generic call, and the clarification round trip.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import { runAnswerBatch, type AnswerBatchDeps, type AnswerBatchMessage } from "../answer-batch";
import type { StatsClarification } from "../awaiting-answer";
import type { OrgFeatures } from "../../org-features";
import type { Route, SquadState, StatsChemistry, StatsSnapshot } from "../types";
import { NOW, fullName, world } from "./helpers";

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
} as OrgFeatures;

type Tables = Omit<StatsSnapshot, "chemistry" | "generic" | "periods">;
const TABLES: Tables = {
  fullTableUrl: "https://matchtime.ai/profile/stats",
  ratings: [
    { userId: "u-mustafa", name: "Mustafa Kaya", avg: 8.1, games: 9, rank: 1, delta: 0 },
    { userId: "u-habib", name: "Habib Rahman", avg: 7.6, games: 5, rank: 2, delta: 3 },
  ],
  mom: [{ userId: "u-sait", name: "Sait Demir", wins: 3 }],
  elo: [],
  teamOfSeason: null,
  mrReliable: [],
  aliases: [],
  appearances: [
    { userId: "u-mojib", name: "Mojib Jalali", matches: 21 },
    { userId: "u-sait", name: "Sait Demir", matches: 19 },
  ],
  recordsStart: { matches: new Date("2026-04-14T20:00:00.000Z"), mom: new Date("2026-04-14T20:00:00.000Z") },
};
const IDRIS_CHEM: StatsChemistry = {
  userId: "u-idris",
  name: "Idris Bello",
  bestByWinRate: { name: "Kemal Ediz", gamesTogether: 7, wins: 5, winRate: 5 / 7 },
  bestByRating: null,
  nemesis: { name: "Zeeshan Khan", gamesAgainst: 5, wins: 1 },
};

/** Keyed on `label|last line of the user turn`, and counted. */
function stubModel(table: Record<string, unknown>) {
  const calls: string[] = [];
  const model: PipelineModel = {
    name: "stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const last = req.user.split("\n").slice(-1)[0];
      calls.push(`${req.label}|${last}`);
      const payload = table[`${req.label}|${last}`] ?? table[last];
      if (payload === undefined) throw new Error(`no stub for ${req.label}|${last}`);
      return {
        text: JSON.stringify(payload),
        stopReason: "end_turn",
        usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.002,
        ms: 10,
      };
    },
  };
  return { model, calls };
}

function msg(o: Partial<AnswerBatchMessage> & { body: string }): AnswerBatchMessage {
  return {
    waMessageId: o.waMessageId ?? "wa-1",
    body: o.body,
    authorName: o.authorName ?? fullName("kemal"),
    senderUserId: o.senderUserId === undefined ? "u-kemal" : o.senderUserId,
    senderName: o.senderName ?? fullName("kemal"),
    tagged: o.tagged ?? true,
    route: (o.route ?? "question") as Route,
    gated: false,
  };
}

async function run(args: {
  messages: AnswerBatchMessage[];
  model: PipelineModel;
  state?: SquadState;
  features?: Partial<OrgFeatures>;
  clarifications?: StatsClarification[];
  loadStats?: AnswerBatchDeps["loadStats"];
  loadChemistry?: AnswerBatchDeps["loadChemistry"];
  loadStatsPeriod?: AnswerBatchDeps["loadStatsPeriod"];
}) {
  const state = args.state ?? world({ confirmed: ["kemal", "elvin"] });
  const statsLoads: string[] = [];
  const chemLoads: string[] = [];
  const periodLoads: string[] = [];
  const res = await runAnswerBatch({
    orgId: "org-1",
    now: NOW,
    messages: args.messages,
    history: [],
    expectedMatchId: state.matchId,
    enabled: new Set<Route>(["question", "balancer"]),
    clarifications: args.clarifications,
    deps: {
      model: args.model,
      loadState: async () => state,
      loadFeatures: async () => ({ ...FEATURES, ...(args.features ?? {}) }),
      loadStats:
        args.loadStats ??
        (async (orgId) => {
          statsLoads.push(orgId);
          return TABLES;
        }),
      loadChemistry:
        args.loadChemistry ??
        (async (_orgId, userId) => {
          chemLoads.push(userId);
          return userId === "u-idris" ? IDRIS_CHEM : null;
        }),
      loadStatsPeriod:
        args.loadStatsPeriod ??
        (async (_orgId, since) => {
          periodLoads.push(since.toISOString());
          return {
            appearances: [{ userId: "u-sait", name: "Sait Demir", matches: 4 }],
            ratings: [],
            mom: [],
          };
        }),
    },
  });
  return { res, statsLoads, chemLoads, periodLoads };
}

const RATINGS_Q = "@Match Time please share the leaderboard of ratings, top 10";
const RATINGS_FACTS = { topic: "stats", personRef: "", statedCount: -1, table: "ratings", listSize: 10, listEnd: "top" };

describe("the incident message, through the whole batch", () => {
  it("is answered with the ratings table, labelled so the route never recomposes it", async () => {
    const { model } = stubModel({ [RATINGS_Q]: RATINGS_FACTS });
    const { res, statsLoads } = await run({ messages: [msg({ body: RATINGS_Q })], model });
    const o = res.outcomes.get("wa-1")!;
    expect(o.reply).toContain("1. Mustafa Kaya: 8.1 (9 matches)");
    expect(o.intent).toBe("stats_table");
    expect(statsLoads).toEqual(["org-1"]);
  });

  it("is answered with no upcoming match, and for an org with attendance off", async () => {
    const { model } = stubModel({ [RATINGS_Q]: RATINGS_FACTS });
    const noMatch = await run({ messages: [msg({ body: RATINGS_Q })], model, state: world({ noMatch: true }) });
    expect(noMatch.res.outcomes.get("wa-1")?.reply).toContain("Mustafa Kaya");
    const attOff = await run({
      messages: [msg({ body: RATINGS_Q })],
      model,
      state: world({ features: { attendance: false } }),
    });
    expect(attOff.res.outcomes.get("wa-1")?.reply).toContain("Mustafa Kaya");
  });
});

describe("the targeted read happens only for a stats question", () => {
  it("not for a count question", async () => {
    const { model } = stubModel({
      "@Match Time how many are we?": { topic: "count", personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top" },
    });
    const { statsLoads } = await run({ messages: [msg({ body: "@Match Time how many are we?" })], model });
    expect(statsLoads).toEqual([]);
  });

  it("a stats question naming no table reads the tables too: it is the appearances table now", async () => {
    const { model } = stubModel({
      "@Match Time who's been most consistent": { topic: "stats", personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top" },
    });
    const { res, statsLoads } = await run({ messages: [msg({ body: "@Match Time who's been most consistent" })], model });
    expect(statsLoads).toEqual(["org-1"]);
    const o = res.outcomes.get("wa-1")!;
    expect(o.reply).toBe("Most appearances since my records began in April 2026:\n1. Mojib Jalali: 21 matches\n2. Sait Demir: 19 matches");
    expect(o.intent).toBe("stats_table");
  });

  it("a failed read disowns the message with a receipt, and costs its neighbours nothing", async () => {
    const { model } = stubModel({ [RATINGS_Q]: RATINGS_FACTS });
    const { res } = await run({
      messages: [msg({ body: RATINGS_Q })],
      model,
      loadStats: async () => {
        throw new Error("db down");
      },
    });
    expect(res.outcomes.get("wa-1")).toBeUndefined();
    expect(res.degradations.join(" ")).toMatch(/stats read failed/);
  });
});

describe("chemistry for a named player", () => {
  const Q = "@Match Time Who is Idris's Chemistry list?";
  it("loads that one player and answers without his nemesis", async () => {
    const { model } = stubModel({ [Q]: { topic: "stats", personRef: "Idris", statedCount: -1, table: "chemistry", listSize: -1, listEnd: "top" } });
    const { res, chemLoads } = await run({ messages: [msg({ body: Q })], model });
    expect(chemLoads).toEqual(["u-idris"]);
    const reply = res.outcomes.get("wa-1")!.reply!;
    expect(reply).toContain("Idris Bello's best team-mates:");
    expect(reply).not.toContain("Zeeshan");
  });
});

describe("the grounded generic path", () => {
  const Q = "@Match Time who has the best win rate?";
  const FACTS = { topic: "stats", personRef: "", statedCount: -1, table: "other", listSize: -1, listEnd: "top" };

  it("a reply whose names and numbers are all in the tables is posted", async () => {
    const { model, calls } = stubModel({
      [Q]: FACTS,
      [`stats-generic|QUESTION: ${Q}`]: { answer: "Mustafa Kaya tops the ratings on 8.1." },
    });
    const { res } = await run({ messages: [msg({ body: Q })], model });
    expect(res.outcomes.get("wa-1")?.reply).toBe("Mustafa Kaya tops the ratings on 8.1.");
    expect(res.outcomes.get("wa-1")?.intent).toBe("stats_generic");
    expect(calls.filter((c) => c.startsWith("stats-generic"))).toHaveLength(1);
  });

  it("an ungrounded reply is replaced by the safe line: our error, never the user's", async () => {
    const { model } = stubModel({
      [Q]: FACTS,
      [`stats-generic|QUESTION: ${Q}`]: { answer: "Habib Rahman wins 92% of his games." },
    });
    const { res } = await run({ messages: [msg({ body: Q })], model });
    const reply = res.outcomes.get("wa-1")!.reply!;
    expect(reply).not.toContain("92");
    expect(reply).toContain("https://matchtime.ai/profile/stats");
    expect(res.degradations.join(" ")).toMatch(/grounding/);
  });

  it("a failed generic call is the safe line too", async () => {
    const { model } = stubModel({ [Q]: FACTS });
    const { res } = await run({ messages: [msg({ body: Q })], model });
    expect(res.outcomes.get("wa-1")?.reply).toContain("https://matchtime.ai/profile/stats");
  });
});

describe("asking, and understanding the answer", () => {
  const Q = "@Match Time Zork's chemistry";
  const ASKED: StatsClarification = {
    id: "am-1",
    orgId: "org-1",
    askerUserId: "u-kemal",
    askerName: fullName("kemal"),
    questionBody: "@Match Time Mo's chemistry",
    askedAt: new Date(NOW.getTime() - 5 * 60 * 1000),
  };

  it("an unknown name is asked about and labelled as an open question", async () => {
    const { model } = stubModel({ [Q]: { topic: "stats", personRef: "Zork", statedCount: -1, table: "chemistry", listSize: -1, listEnd: "top" } });
    const { res } = await run({ messages: [msg({ body: Q })], model });
    const o = res.outcomes.get("wa-1")!;
    expect(o.reply).toBe("Kemal, I don't have a Zork in the squad. Who do you mean?");
    expect(o.intent).toBe("stats_clarification");
  });

  it("the asker's untagged 'Idris' is read as the answer to the original question", async () => {
    const { model, calls } = stubModel({
      [ASKED.questionBody]: { topic: "stats", personRef: "Mo", statedCount: -1, table: "chemistry", listSize: -1, listEnd: "top" },
    });
    const { res } = await run({
      messages: [msg({ body: "Idris", tagged: false })],
      model,
      clarifications: [ASKED],
    });
    const o = res.outcomes.get("wa-1")!;
    expect(o.reply).toContain("Idris Bello's best team-mates:");
    expect(o.intent).toBe("stats_clarified");
    // The ORIGINAL question was re-read; the reply itself never was.
    expect(calls).toEqual([`extractor:question|${ASKED.questionBody}`]);
  });

  it("the same word from somebody else is not an answer to Kemal's question", async () => {
    const { model, calls } = stubModel({});
    const { res } = await run({
      messages: [msg({ body: "Idris", tagged: false, senderUserId: "u-sait", authorName: fullName("sait"), senderName: fullName("sait") })],
      model,
      clarifications: [ASKED],
    });
    expect(res.outcomes.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("an answer that still names nobody is asked about again, not guessed", async () => {
    const { model } = stubModel({
      [ASKED.questionBody]: { topic: "stats", personRef: "Mo", statedCount: -1, table: "chemistry", listSize: -1, listEnd: "top" },
    });
    const { res } = await run({ messages: [msg({ body: "Zork", tagged: false })], model, clarifications: [ASKED] });
    expect(res.outcomes.get("wa-1")?.reply).toBe("Kemal, I don't have a Zork in the squad. Who do you mean?");
    expect(res.outcomes.get("wa-1")?.intent).toBe("stats_clarification");
  });
});

describe("the period (2026-09-23)", () => {
  const KEMAL_Q = "@Match Time who has played most matches in the last 1 year?";
  const KEMAL_FACTS = {
    topic: "stats", personRef: "", statedCount: -1, table: "appearances", listSize: -1, listEnd: "top",
    period: "last", periodCount: 1, periodUnit: "year",
  };

  it("Kemal's message: owned as a stats table, the year read from now, and the records' start said", async () => {
    const { model } = stubModel({ [KEMAL_Q]: KEMAL_FACTS });
    const { res, periodLoads } = await run({ messages: [msg({ body: KEMAL_Q })], model });
    // One year back from NOW, computed by code, never by the model.
    expect(NOW.toISOString()).toBe("2026-09-01T18:00:00.000Z");
    expect(periodLoads).toEqual(["2025-09-01T18:00:00.000Z"]);
    const o = res.outcomes.get("wa-1")!;
    expect(o.intent).toBe("stats_table");
    expect(o.reply).toContain("My records for this club start in April 2026, so for the last year this is everything I have.");
    expect(o.reply).toContain("1. Sait Demir: 4 matches");
  });

  it("is answered with no upcoming match: appearances are a record of the past, not the squad", async () => {
    const { model } = stubModel({ [KEMAL_Q]: KEMAL_FACTS });
    const { res } = await run({ messages: [msg({ body: KEMAL_Q })], model, state: world({ noMatch: true }) });
    expect(res.outcomes.get("wa-1")?.reply).toContain("Sait Demir");
  });

  it("two questions on the same period read it once", async () => {
    const { model } = stubModel({ [KEMAL_Q]: KEMAL_FACTS });
    const { periodLoads } = await run({
      messages: [msg({ body: KEMAL_Q, waMessageId: "wa-1" }), msg({ body: KEMAL_Q, waMessageId: "wa-2" })],
      model,
    });
    expect(periodLoads).toHaveLength(1);
  });

  it("the season and a table the data cannot cut read no period at all", async () => {
    const q1 = "@Match Time most appearances this season";
    const q2 = "@Match Time elo table last month";
    const { model } = stubModel({
      [q1]: { ...KEMAL_FACTS, period: "season", periodCount: -1, periodUnit: "none" },
      [q2]: { ...KEMAL_FACTS, table: "elo", period: "last", periodCount: 1, periodUnit: "month" },
    });
    for (const body of [q1, q2]) {
      const { periodLoads, res } = await run({ messages: [msg({ body })], model });
      expect(periodLoads, body).toEqual([]);
      expect(res.outcomes.get("wa-1")?.reply, body).toBeTruthy();
    }
  });

  it("a failed period read disowns the message with a receipt", async () => {
    const { model } = stubModel({ [KEMAL_Q]: KEMAL_FACTS });
    const { res } = await run({
      messages: [msg({ body: KEMAL_Q })],
      model,
      loadStatsPeriod: async () => {
        throw new Error("db down");
      },
    });
    expect(res.outcomes.get("wa-1")).toBeUndefined();
    expect(res.degradations.join(" ")).toMatch(/stats read failed/);
  });
});
