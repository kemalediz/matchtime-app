/**
 * A TAGGED QUESTION IN A MIXED BATCH IS ANSWERED (Vets sandbox, 2026-11-03,
 * scenario D; the unified answer's since 2026-11-18).
 *
 * "@Match Time what happens if 14 don't confirm?" arrived in a 22-message
 * batch beside INs, and nobody answered it. The mixed-batch hand-back guards
 * against a write that lands AFTER the answer is composed. Attendance writes
 * have already landed when this module loads its state (and in a monthly
 * club with no month they write nothing at all), so beside attendance traffic
 * the question is answered; beside a writer that runs after this step (a
 * score) it still waits.
 *
 * In a monthly club whose month is not started, "we're 0 of 14, need 14
 * more" is not true (the squad starts from the month's list, #501): the
 * unified answer is told so in its records.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import { runAnswerBatch, type AnswerBatchMessage } from "../answer-batch";
import type { OrgFeatures } from "../../org-features";
import type { Route } from "../types";
import { NOW, fullName, world } from "./helpers";

const FEATURES = {
  botEnabled: true,
  attendance: true,
  bench: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  reminders: true,
  statsQa: false,
  paymentTracking: false,
  paymentCollection: false,
  squadFromList: false,
  language: "en",
} as OrgFeatures;

const Q = "@Match Time what happens if 14 don't confirm?";
const ANSWER = "The first on the bench moves up while a place is open.";

function stubModel(kind: string) {
  const reqs: ModelRequest[] = [];
  const model: PipelineModel = {
    name: "stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      reqs.push(req);
      const text =
        req.label === "unified-answer" ? JSON.stringify({ answer: ANSWER }) : JSON.stringify({ kind, personRef: "", feature: "none", badge: "none" });
      return {
        text,
        stopReason: "end_turn",
        usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.002,
        ms: 10,
      };
    },
  };
  return { model, reqs };
}

const msg = (o: Partial<AnswerBatchMessage> & { body: string; route: Route }): AnswerBatchMessage => ({
  waMessageId: o.waMessageId ?? "wa-q",
  body: o.body,
  authorName: fullName("sait"),
  senderUserId: "u-sait",
  senderName: fullName("sait"),
  tagged: o.tagged ?? true,
  route: o.route,
  gated: o.gated ?? false,
});

async function run(opts: { kind: string; neighbours: AnswerBatchMessage[]; monthNotStarted?: boolean }) {
  const st = world({ confirmed: ["kemal", "sait"], bench: ["zair"] });
  const { model, reqs } = stubModel(opts.kind);
  const res = await runAnswerBatch({
    orgId: "org-1",
    now: NOW,
    messages: [msg({ body: Q, route: "question" }), ...opts.neighbours],
    history: [],
    expectedMatchId: st.matchId,
    enabled: new Set<Route>(["question"]),
    ...(opts.monthNotStarted ? { monthNotStarted: true } : {}),
    deps: {
      model,
      loadState: async () => st,
      loadFeatures: async () => FEATURES,
      loadClub: async () => ({ collectorName: null, feePerPlayer: null, feeSplitTotal: false, teamsReady: "off" }),
      loadResults: async () => ({ since: null, more: false, rows: [] }),
      loadClubFacts: async () => ({ pool: { open: false, platformOpen: false, clubFlag: false }, partners: { active: 0 } }),
    },
  });
  return { res, reqs, st };
}

const IN = msg({ body: "IN", route: "self_att", waMessageId: "wa-in", tagged: false });
const OTHER_IN = msg({ body: "David Stark is in", route: "other_att", waMessageId: "wa-other", tagged: false });
const UNSURE = msg({ body: "No need to say IN if we move it to monthly squad", route: "unsure", waMessageId: "wa-unsure", tagged: false });
const SCORE = msg({ body: "we won 5-3", route: "score", waMessageId: "wa-score", tagged: false });

describe("a tagged question beside attendance traffic is answered", () => {
  it("THE SANDBOX FAILURE: a question beside INs, an other_att and an unsure is answered by the unified answer", async () => {
    const { res } = await run({ kind: "other", neighbours: [IN, OTHER_IN, UNSURE] });
    expect([...res.ownedIds]).toEqual(["wa-q"]);
    expect(res.outcomes.get("wa-q")?.reply).toBe(ANSWER);
  });

  it("the list asked for beside an IN is posted, after the IN landed", async () => {
    const { res } = await run({ kind: "list", neighbours: [IN] });
    expect([...res.ownedIds]).toEqual(["wa-q"]);
    expect(res.outcomes.get("wa-q")?.reply).toContain(fullName("kemal"));
  });

  it("UNCHANGED: a question beside a writer that runs AFTER this step (a score) is still handed back", async () => {
    const { res, reqs } = await run({ kind: "other", neighbours: [SCORE] });
    expect([...res.ownedIds]).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/does not own/);
    expect(reqs.map((r) => r.label)).not.toContain("unified-answer");
  });
});

describe("a monthly club whose month is not started", () => {
  it("the unified answer is told the squad comes from the month's list, so the count is not the squad yet", async () => {
    const { res, reqs } = await run({ kind: "other", neighbours: [IN], monthNotStarted: true });
    expect(res.outcomes.get("wa-q")?.reply).toBe(ANSWER);
    const user = reqs.find((r) => r.label === "unified-answer")!.user;
    expect(user).toMatch(/this month's list has not started yet/);
  });
});
