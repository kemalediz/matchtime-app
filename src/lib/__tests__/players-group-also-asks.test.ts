/**
 * THE "question" SIDE REQUEST IN THE PLAYERS' GROUP (follow-up to #392).
 *
 * #392 taught the attendance extractor a third side request, "question":
 * the message ALSO asks MatchTime for something it holds. HQ answers it.
 * In the players' group it must be:
 *
 *   1. INVISIBLE to every reader that existed before it: the operator
 *      note's `silentDiscard` (a claimless message whose only side request
 *      is "question" is still a silent discard), the engine's reasons, the
 *      intent. Pinned by comparing the outcome against the same message
 *      read with `sideRequests: []`, which is what the extractor returned
 *      before #392.
 *   2. ANSWERED, through the players' group's own question answering
 *      (`runAnswerBatch`), under the same gates as a standalone question:
 *      tagged, the route enabled, the same carve-outs. It is returned
 *      apart from the module's own outcomes, because the attendance engine
 *      owns the message and speaks for it (`alsoAnswered`).
 *
 * Clubs whose organisers announce the list never pass `alsoAsks` (the
 * analyze route decides that), so nothing new reaches them.
 * No database, no model call.
 */
import { describe, expect, it } from "vitest";
import { runAttendanceEngineBatch, type EngineBatchDeps } from "../attendance-engine-batch";
import { silentDiscard } from "../operator-note";
import { appendAfterComposition, joinAlsoAnswered } from "../also-asks-reply";
import { SQUAD_POST_MARKER, composeSquadStatusPost } from "../group-copy";
import { runAnswerBatch, type AnswerBatchMessage } from "../pipeline/answer-batch";
import type { ModelRequest, PipelineModel } from "../pipeline/llm";
import type { Route } from "../pipeline/types";
import type { OrgFeatures } from "../org-features";
import { NOW, fullName, world } from "../pipeline/__tests__/helpers";

const ELEVEN = ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat", "amir"];

/** Answers every call with `payload`, and counts the calls. */
function fixedModel(payload: unknown) {
  const calls: string[] = [];
  const model: PipelineModel = {
    name: "fixed",
    async complete(req: ModelRequest) {
      calls.push(req.label);
      return {
        text: JSON.stringify(payload),
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 1,
      };
    },
  };
  return { model, calls };
}

function engineDeps(model: PipelineModel): EngineBatchDeps {
  return {
    model,
    loadState: async () => world({ confirmed: ELEVEN }),
    openBenchPromptUserIds: async () => [],
    claimGuestNameAsk: async () => true,
    registerAttendance: async () => ({ status: "CONFIRMED" as const, position: 1, slot: 1, confirmedCount: 1, maxPlayers: 14 }),
    cancelAttendance: async () => ({ status: "DROPPED" as const }),
    resolveOrProvision: async (name: string) => ({ userId: `new:${name}` }),
  } as unknown as EngineBatchDeps;
}

async function engineOutcome(route: Route, sideRequests: string[], claims: unknown[] = []) {
  const { model } = fixedModel({ claims, affirmation: "none", sideRequests });
  const state = world({ confirmed: ELEVEN });
  const r = await runAttendanceEngineBatch({
    orgId: "org-1",
    now: NOW,
    expectedMatchId: state.matchId,
    enabled: true,
    history: [],
    messages: [
      {
        waMessageId: "wa-1",
        body: "@Match Time what's the list?",
        authorName: fullName("sait"),
        senderUserId: "u-sait",
        senderName: fullName("sait"),
        senderIsAdmin: false,
        tagged: true,
        route,
        gated: false,
      },
    ],
    deps: engineDeps(model),
  });
  return r.outcomes.get("wa-1")!;
}

describe("the attendance engine: a 'question' side request changes nothing it reports", () => {
  for (const route of ["self_att", "offer", "unsure"] as Route[]) {
    it(`${route}: the outcome is the one a message with no side request gets, plus the flag`, async () => {
      const before = await engineOutcome(route, []);
      const after = await engineOutcome(route, ["question"]);
      expect(after.sideRequestCount).toBe(0);
      expect(after.alsoAsksQuestion).toBe(true);
      expect(before.alsoAsksQuestion).toBe(false);
      const { alsoAsksQuestion: _a, ...a } = after;
      const { alsoAsksQuestion: _b, ...b } = before;
      expect(a).toEqual(b);
      expect(after.reasoning).not.toContain("question");
    });
  }

  it("beside a real side request, only the real one is counted", async () => {
    const o = await engineOutcome("unsure", ["chase", "question"]);
    expect(o.sideRequestCount).toBe(1);
    expect(o.reasoning).toContain("side-request:chase");
    expect(o.reasoning).not.toContain("side-request:question");
  });

  it("a players'-group message with sideRequests ['question'] and no claims is still a silent discard", async () => {
    const o = await engineOutcome("self_att", ["question"]);
    expect(o.claimCount).toBe(0);
    expect(
      silentDiscard({
        waMessageId: o.waMessageId,
        body: "@Match Time what's the list?",
        authorName: fullName("sait"),
        route: o.route,
        disposition: o.disposition,
        spoke: false,
        senderResolved: true,
        claimCount: o.claimCount,
        sideRequestCount: o.sideRequestCount,
        why: o.reasoning,
      }),
    ).toBe(true);
  });
});

// ── The answer, through the players' group's own question answering ──

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

const SQUAD_Q = { topic: "squad", personRef: "", statedCount: -1 };
const OUT_AND_LIST = "@Match Time I'm out, what's the list?";

function m(o: Partial<AnswerBatchMessage> & { waMessageId: string; route: Route }): AnswerBatchMessage {
  return {
    body: OUT_AND_LIST,
    authorName: fullName("sait"),
    senderUserId: "u-sait",
    senderName: fullName("sait"),
    tagged: true,
    gated: false,
    ...o,
  };
}

async function answer(messages: AnswerBatchMessage[], alsoAsks: string[] | undefined, payload: unknown = SQUAD_Q) {
  const { model, calls } = fixedModel(payload);
  const state = world({ confirmed: ELEVEN });
  const res = await runAnswerBatch({
    orgId: "org-1",
    now: NOW,
    messages,
    history: [],
    expectedMatchId: state.matchId,
    enabled: new Set<Route>(["question", "balancer"]),
    deps: { model, loadState: async () => state, loadFeatures: async () => FEATURES },
    ...(alsoAsks ? { alsoAsks: new Set(alsoAsks) } : {}),
  });
  return { res, calls };
}

describe("runAnswerBatch: the question inside an attendance message", () => {
  it("without `alsoAsks` an attendance message is not looked at (as before)", async () => {
    const { res, calls } = await answer([m({ waMessageId: "wa-out", route: "self_att" })], undefined);
    expect(calls).toEqual([]);
    expect(res.ownedIds.size).toBe(0);
    expect(res.alsoAnswered.size).toBe(0);
  });

  it("answered as a question, returned apart: the attendance engine owns the message", async () => {
    const { res, calls } = await answer([m({ waMessageId: "wa-out", route: "self_att" })], ["wa-out"]);
    expect(calls).toEqual(["extractor:question"]);
    expect(res.ownedIds.has("wa-out")).toBe(false);
    expect(res.outcomes.has("wa-out")).toBe(false);
    const a = res.alsoAnswered.get("wa-out");
    expect(a?.reply).toBeTruthy();
    expect(a?.route).toBe("question");
  });

  it("untagged: the same gate as a standalone question, nothing answered and no call", async () => {
    const { res, calls } = await answer([m({ waMessageId: "wa-out", route: "self_att", tagged: false })], ["wa-out"]);
    expect(calls).toEqual([]);
    expect(res.alsoAnswered.size).toBe(0);
  });

  it("a standalone question beside it is answered as before, in its own outcome", async () => {
    const { res } = await answer(
      [
        m({ waMessageId: "wa-out", route: "self_att" }),
        m({ waMessageId: "wa-q", route: "question", body: "@Match Time how many are we?", senderUserId: "u-adam", senderName: fullName("adam") }),
      ],
      ["wa-out"],
    );
    expect(res.ownedIds.has("wa-q")).toBe(true);
    expect(res.alsoAnswered.has("wa-out")).toBe(true);
    expect(res.ownedIds.has("wa-out")).toBe(false);
  });
});

// ── One reply: the change first, then the answer ─────────────────────


describe("joinAlsoAnswered", () => {
  const LIST = composeSquadStatusPost({ confirmed: ["Kemal Ediz", "Elvin Aliyev"], bench: [], maxPlayers: 14 });

  it("nothing answered: the engine's reply, untouched", () => {
    expect(joinAlsoAnswered("Thanks Sait.", null)).toEqual({ reply: "Thanks Sait.", afterComposition: null });
    expect(joinAlsoAnswered(null, { reply: null, intent: "question" })).toEqual({ reply: null, afterComposition: null });
  });

  it("a react-only change: the answer is the reply", () => {
    expect(joinAlsoAnswered(null, { reply: LIST, intent: "question" })).toEqual({ reply: LIST, afterComposition: null });
  });

  it("a squad answer after a line: the line, then the marker the batch pass composes from the database", () => {
    expect(joinAlsoAnswered("Thanks Sait.", { reply: LIST, intent: "question" }).reply).toBe(`Thanks Sait.\n\n${SQUAD_POST_MARKER}`);
  });

  it("any other answer after a line: joined now", () => {
    expect(joinAlsoAnswered("Thanks Sait.", { reply: "Kickoff is 21:30.", intent: "question" }).reply).toBe(
      "Thanks Sait.\n\nKickoff is 21:30.",
    );
  });

  it("a stats table waits until after the squad pass", () => {
    expect(joinAlsoAnswered(null, { reply: "1. Kemal 8.1", intent: "stats_table" })).toEqual({
      reply: null,
      afterComposition: "1. Kemal 8.1",
    });
    expect(appendAfterComposition(null, "x")).toBe("x");
    expect(appendAfterComposition("a", "x")).toBe("a\n\nx");
  });
});
