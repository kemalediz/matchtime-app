/**
 * `runAnswerBatch` on RESULTS questions (2026-09-29): the targeted read
 * of the club's recent results happens only when a `score` question
 * asked for several results or a period, once per distinct period, and
 * fails open with a receipt.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import { runAnswerBatch, type AnswerBatchDeps, type AnswerBatchMessage } from "../answer-batch";
import type { OrgFeatures } from "../../org-features";
import type { RecentResults, Route, SquadState } from "../types";
import { NOW, fullName, world } from "./helpers";
import { periodSince } from "../stats-period";

const FEATURES = {
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

function stubModel(table: Record<string, unknown>): PipelineModel {
  return {
    name: "stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const last = req.user.split("\n").slice(-1)[0];
      const payload = table[last];
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
}

const Q = (over: Record<string, unknown>) => ({
  topic: "score",
  personRef: "",
  statedCount: -1,
  table: "none",
  listSize: -1,
  listEnd: "top",
  period: "none",
  periodCount: -1,
  periodUnit: "none",
  ...over,
});

const ROWS: RecentResults = {
  since: null,
  more: false,
  rows: [
    { dayLabel: "Tue 29 Sep", redLabel: "Red", yellowLabel: "Yellow", red: 5, yellow: 4 },
    { dayLabel: "Tue 22 Sep", redLabel: "Red", yellowLabel: "Yellow", red: 2, yellow: 6 },
  ],
};

function msg(body: string, id = "wa-1"): AnswerBatchMessage {
  return {
    waMessageId: id,
    body,
    authorName: fullName("kemal"),
    senderUserId: "u-kemal",
    senderName: fullName("kemal"),
    tagged: true,
    route: "question" as Route,
    gated: false,
  };
}

async function run(messages: AnswerBatchMessage[], model: PipelineModel, loadResults?: AnswerBatchDeps["loadResults"], state?: SquadState) {
  const st = state ?? world({ confirmed: ["kemal"], completedMatch: { id: "m-old", redScore: 5, yellowScore: 4 } });
  const loads: Array<string | null> = [];
  const res = await runAnswerBatch({
    orgId: "org-1",
    now: NOW,
    messages,
    history: [],
    expectedMatchId: st.matchId,
    enabled: new Set<Route>(["question"]),
    deps: {
      model,
      loadState: async () => st,
      loadFeatures: async () => FEATURES,
      loadResults:
        loadResults ??
        (async (orgId, since) => {
          expect(orgId).toBe("org-1");
          loads.push(since ? since.toISOString() : null);
          return { ...ROWS, since };
        }),
    },
  });
  return { res, loads };
}

describe("results questions through the whole batch", () => {
  it("the incident: the last 5 matches reads the club's results and lists them", async () => {
    const body = "@Match Time give us the scores of the last 5 matches";
    const { res, loads } = await run([msg(body)], stubModel({ [body]: Q({ listSize: 5 }) }));
    expect(loads).toEqual([null]);
    expect(res.outcomes.get("wa-1")?.reply).toBe(
      "⚽ Last 2 results:\n• Tue 29 Sep: Red 5 - 4 Yellow. Red won.\n• Tue 22 Sep: Red 2 - 6 Yellow. Yellow won.\nThat's every scored match I have on record.",
    );
  });

  it("a cutting period is read from the clock, in code", async () => {
    const body = "@Match Time results this month";
    const { loads } = await run([msg(body)], stubModel({ [body]: Q({ period: "this", periodUnit: "month" }) }));
    expect(loads).toEqual([periodSince({ kind: "this", unit: "month" }, NOW)!.toISOString()]);
  });

  it("the season is the whole record, read once with two askers", async () => {
    const a = "@Match Time results this season";
    const b = "@Match Time son 5 maçın skorları";
    const { loads } = await run(
      [msg(a, "wa-1"), msg(b, "wa-2")],
      stubModel({ [a]: Q({ period: "season" }), [b]: Q({ listSize: 5 }) }),
    );
    expect(loads).toEqual([null]);
  });

  it("no count and no period does not read: the last match answers it, as before", async () => {
    const body = "@Match Time what was the score";
    const { res, loads } = await run([msg(body)], stubModel({ [body]: Q({}) }));
    expect(loads).toEqual([]);
    expect(res.outcomes.get("wa-1")?.reply).toContain("Red 5 - 4 Yellow");
  });

  it("a failed read disowns the message with a receipt", async () => {
    const body = "@Match Time last 3 results";
    const { res } = await run([msg(body)], stubModel({ [body]: Q({ listSize: 3 }) }), async () => {
      throw new Error("db down");
    });
    expect(res.outcomes.get("wa-1")).toBeUndefined();
    expect(res.degradations.join(" ")).toMatch(/results read failed/);
  });
});
