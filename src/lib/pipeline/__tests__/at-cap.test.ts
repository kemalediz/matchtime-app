/**
 * AT THE DAILY AI CAP, A BARE IN/OUT STILL WORKS, WITH NO MODEL CALL.
 *
 * Before this change the floor (`routeFloor`) only spared the ROUTER: a
 * bare "in" routed `self_att` still went to the Sonnet attendance
 * extractor, so at the cap the most important message in the product
 * would have gone silent. These tests pin the deterministic path end to
 * end: floor facts, the router's capped mode, the gate's capped mode, and
 * the attendance engine writing from floor facts without calling a model.
 */
import { describe, expect, it, vi } from "vitest";
import { floorAttendanceFacts, routeBatch } from "../router";
import { gateBatch } from "../gate";
import { AiBudgetExceededError } from "../../ai-budget-context";
import type { PipelineModel } from "../llm";
import {
  runAttendanceEngineBatch,
  type EngineBatchDeps,
  type EngineBatchMessage,
} from "../../attendance-engine-batch";
import type { SquadState } from "../types";

/** A model that must never be reached. */
function forbiddenModel(): PipelineModel & { calls: number } {
  const m = {
    name: "forbidden",
    calls: 0,
    async complete(): Promise<never> {
      m.calls++;
      throw new Error("the model was called at the cap");
    },
  };
  return m;
}

/** What the guard throws when the ledger refuses. */
function cappedModel(): PipelineModel & { calls: number } {
  const m = {
    name: "capped",
    calls: 0,
    async complete(req: { label: string }): Promise<never> {
      m.calls++;
      throw new AiBudgetExceededError("org-1", req.label);
    },
  };
  return m;
}

describe("floorAttendanceFacts: the facts a bare declaration states, read without a model", () => {
  const claim = (over: Record<string, unknown>) => ({
    subject: "sender",
    personRef: "",
    personNamed: false,
    polarity: "in",
    contingent: false,
    conditionOn: "none",
    tense: "present",
    basis: "decision",
    reported: false,
    confidence: 1,
    replaces: "",
    ...over,
  });

  it.each([
    ["in", "in"],
    ["IN 👍", "in"],
    ["I'm in", "in"],
    ["out", "out"],
    ["can't make it", "out"],
    ["var", "in"],
    ["varım", "in"],
    ["yokum", "out"],
    ["gelemiyorum", "out"],
  ])("%j is the sender, %s", (body, polarity) => {
    expect(floorAttendanceFacts(body)).toEqual({
      kind: "attendance",
      claims: [claim({ polarity })],
      affirmation: null,
      sideRequests: [],
    });
  });

  it("a mention and a token is that named person", () => {
    expect(floorAttendanceFacts("@Ehtisham Ul Haq In")).toEqual({
      kind: "attendance",
      claims: [claim({ subject: "other", personRef: "Ehtisham Ul Haq", personNamed: true })],
      affirmation: null,
      sideRequests: [],
    });
  });

  it("two mentions and a token are two people", () => {
    const f = floorAttendanceFacts("@Zair Malik @Jesse out");
    expect(f?.kind).toBe("attendance");
    expect(f && f.kind === "attendance" && f.claims.map((c) => [c.personRef, c.polarity])).toEqual([
      ["Zair Malik", "out"],
      ["Jesse", "out"],
    ]);
  });

  it.each(["in if we have 10", "who's in?", "@Match Time in", "lol", "", "in for tuesday and bringing my brother"])(
    "%j is not a bare declaration: no floor facts",
    (body) => {
      expect(floorAttendanceFacts(body)).toBeNull();
    },
  );
});

describe("routeBatch at the cap", () => {
  const msgs = [
    { id: "a", authorName: "Pete", body: "in" },
    { id: "b", authorName: "Dan", body: "anyone got a spare shin pad" },
    { id: "c", authorName: "Ali", body: "@Match Time who is playing?" },
  ];

  it("keeps the floor's routes and sends everything else to none, never to the extractor", async () => {
    const r = await routeBatch(cappedModel(), msgs, { floor: true });
    const by = Object.fromEntries(r.routes.map((x) => [x.messageId, [x.route, x.source]]));
    expect(by).toEqual({ a: ["self_att", "floor"], b: ["none", "capped"], c: ["none", "capped"] });
    // No `unsure`: that route goes to the extractor, which is another model call.
    expect(r.routes.some((x) => x.route === "unsure")).toBe(false);
  });

  it("uses the floor at the cap even when the floor flag is off", async () => {
    const r = await routeBatch(cappedModel(), msgs, { floor: false });
    expect(r.routes.find((x) => x.messageId === "a")).toMatchObject({ route: "self_att", source: "floor" });
  });

  it("an open question does not rescue a capped none into unsure (that would be a model call)", async () => {
    const r = await routeBatch(cappedModel(), [{ id: "b", authorName: "Dan", body: "👍" }], {
      floor: true,
      awaiting: { id: "x", orgId: "org-1", kind: "bench-slot-offer", askedAt: new Date(), closesAt: null },
    });
    expect(r.routes[0]).toMatchObject({ route: "none", source: "capped" });
  });
});

describe("gateBatch in capped mode never calls the router", () => {
  it("routes by the floor alone and skips the rest", async () => {
    const model = forbiddenModel();
    const g = await gateBatch(
      [
        { waMessageId: "a", body: "out", authorName: "Pete" },
        { waMessageId: "b", body: "@Match Time what time is kickoff", authorName: "Ali" },
      ],
      { capped: true, model, floor: false },
    );
    expect(model.calls).toBe(0);
    expect(g.modelCalled).toBe(false);
    expect(g.analysed).toEqual(["a"]);
    expect(g.skipped).toEqual(["b"]);
    expect(g.routes.find((r) => r.messageId === "a")?.route).toBe("self_att");
  });
});

// ── the attendance engine ─────────────────────────────────────────────

function state(): SquadState {
  return {
    matchId: "match-1",
    maxPlayers: 4,
    kickoffLabel: "Tue 20:00",
    venue: "The Pitch",
    // Dan is already playing, so his OUT is a real drop.
    rows: [{ userId: "u-dan", status: "CONFIRMED" as const, position: 1 }],
    roster: [
      { userId: "u-pete", name: "Pete Power", isAdmin: false, hasPhone: true },
      { userId: "u-dan", name: "Dan Drummer", isAdmin: false, hasPhone: true },
    ],
    openOffers: [],
    teams: [],
    teamLabels: ["Red", "Yellow"],
    completedMatch: null,
    payments: null,
    ratingProgress: null,
    lastBotPost: null,
    features: { attendance: true, paymentTracking: false, statsQa: false, reminders: false, language: "en" },
    smallerFormats: [],
    guestAskedUserIds: [],
  } as SquadState;
}

function msg(over: Partial<EngineBatchMessage> = {}): EngineBatchMessage {
  return {
    waMessageId: "wa-1",
    body: "in",
    authorName: "Pete Power",
    senderUserId: "u-pete",
    senderName: "Pete Power",
    senderIsAdmin: false,
    tagged: false,
    route: "self_att",
    gated: false,
    ...over,
  };
}

function deps(model: PipelineModel, over: Partial<EngineBatchDeps> = {}) {
  const registered: string[] = [];
  const cancelled: string[] = [];
  const d = {
    model,
    loadState: async () => state(),
    openBenchPromptUserIds: async () => [],
    claimGuestNameAsk: async () => true,
    async registerAttendance(userId: string) {
      registered.push(userId);
      return { status: "CONFIRMED" as const, position: 1, slot: 1, confirmedCount: 1, maxPlayers: 4 };
    },
    async cancelAttendance(userId: string) {
      cancelled.push(userId);
      return { status: "DROPPED" as const };
    },
    async resolveOrProvision(name: string) {
      return { userId: `new-real:${name}` };
    },
    ...over,
  } as unknown as EngineBatchDeps;
  return { d, registered, cancelled };
}

const run = (messages: EngineBatchMessage[], d: EngineBatchDeps) =>
  runAttendanceEngineBatch({
    orgId: "org-1",
    now: new Date("2026-09-29T12:00:00Z"),
    messages,
    history: [],
    expectedMatchId: "match-1",
    enabled: true,
    deps: d,
  });

describe("the attendance engine at the cap", () => {
  it("known capped (aiCapped): a bare IN and a bare OUT are written with ZERO model calls", async () => {
    const model = forbiddenModel();
    const { d, registered, cancelled } = deps(model, { aiCapped: true });
    const r = await run(
      [
        msg({ waMessageId: "a", body: "in" }),
        msg({ waMessageId: "b", body: "out", senderUserId: "u-dan", senderName: "Dan Drummer", authorName: "Dan Drummer" }),
      ],
      d,
    );
    expect(model.calls).toBe(0);
    expect(registered).toEqual(["u-pete"]);
    expect(cancelled).toEqual(["u-dan"]);
    expect(r.outcomes.get("a")).toMatchObject({ intent: "in", action: "IN" });
    expect(r.cost.calls).toBe(0);
  });

  it("capped mid-batch: an extractor call the ledger refuses falls back to the floor's facts", async () => {
    const model = cappedModel();
    const { d, registered } = deps(model);
    const r = await run([msg({ waMessageId: "a", body: "IN" })], d);
    expect(registered).toEqual(["u-pete"]);
    expect(r.ownedIds.has("a")).toBe(true);
    // Refused once, and NOT retried: a refusal is not a flaky call.
    expect(model.calls).toBe(1);
  });

  it("a sentence the floor cannot read is NOT guessed at: owned by nobody, no write", async () => {
    const model = forbiddenModel();
    const { d, registered, cancelled } = deps(model, { aiCapped: true });
    const r = await run([msg({ waMessageId: "a", body: "in if we get 10", route: "self_att" })], d);
    expect(model.calls).toBe(0);
    expect(registered).toEqual([]);
    expect(cancelled).toEqual([]);
    expect(r.ownedIds.size).toBe(0);
  });

  it("below the cap nothing changes: the extractor still reads a bare IN", async () => {
    const complete = vi.fn(async () => ({
      text: JSON.stringify({
        claims: [
          {
            subject: "sender",
            personRef: "",
            personNamed: false,
            polarity: "in",
            contingent: false,
            conditionOn: "none",
            tense: "present",
            reported: false,
            confidence: 0.95,
          },
        ],
        affirmation: "none",
        sideRequests: [],
      }),
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0.004,
      ms: 1,
    }));
    const { d, registered } = deps({ name: "fake", complete });
    await run([msg()], d);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(registered).toEqual(["u-pete"]);
  });
});
