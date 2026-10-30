/**
 * AT THE DAILY AI CAP NO REGEX TAKES OVER (2026-10-30, "no string parsing").
 *
 * Until today a bare IN/OUT floor read attendance with no model at the
 * cap. It is gone. The decision (Kemal, via the manager): a message that
 * may be about a place still gets read by the model past the cap, up to a
 * hard ceiling of twice the cap (`withAttendanceOverflow`); beyond that
 * nothing is read, the message is logged and counted. These tests pin the
 * router's and the gate's capped mode and the attendance engine's.
 */
import { describe, expect, it, vi } from "vitest";
import { routeBatch } from "../router";
import { gateBatch } from "../gate";
import {
  AiBudgetExceededError,
  guardedModelCall,
  runWithAiBudget,
  ATTENDANCE_OVERFLOW_MULTIPLIER,
  type AiBudgetLedger,
} from "../../ai-budget-context";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import {
  runAttendanceEngineBatch,
  type EngineBatchDeps,
  type EngineBatchMessage,
} from "../../attendance-engine-batch";
import type { SquadState } from "../types";

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * A club whose spend is already past its cap. The ledger is the database
 * rule in memory (reserve only while spend is under the ceiling), and the
 * model goes through the real guard, so what a call inside or outside the
 * attendance overflow may do is the production rule.
 */
function overCap(opts: { cap: number; spent: number }) {
  const row = { costUsd: opts.spent, calls: 0, refused: 0, labels: [] as string[] };
  const ledger: AiBudgetLedger = {
    async reserve(key, label, o) {
      const ceiling = o?.overflow ? opts.cap * ATTENDANCE_OVERFLOW_MULTIPLIER : opts.cap;
      if (row.costUsd >= ceiling) {
        row.refused++;
        throw new AiBudgetExceededError(key, label);
      }
      row.labels.push(`${label}${o?.overflow ? " (overflow)" : ""}`);
      return { key, day: "2026-10-30", reservedUsd: 0 };
    },
    async settle(_h, cost) {
      row.costUsd += cost;
      row.calls++;
    },
    async release() {},
  };
  return { ledger, row, within: <T>(fn: () => Promise<T>) => runWithAiBudget("org-1", ledger, fn) };
}

/** A router model: answers each line by its body, through the guard. */
function routerModel(byBody: Record<string, string>): PipelineModel & { calls: number } {
  const m = {
    name: "router-fake",
    calls: 0,
    async complete(req: ModelRequest): Promise<ModelResponse> {
      return guardedModelCall(
        req.label,
        async () => {
          m.calls++;
          const rows = [...req.user.matchAll(/^\[(m\d+)\] [^:]*: (.*)$/gm)];
          return {
            text: JSON.stringify({ routes: rows.map((r) => ({ id: r[1], route: byBody[r[2]] ?? "none", to_bot: false })) }),
            stopReason: "end_turn",
            usage,
            costUsd: 0.002,
            ms: 1,
          };
        },
        (r) => r.costUsd,
        0.01,
      );
    },
  };
  return m;
}

describe("routeBatch at the cap", () => {
  const msgs = [
    { id: "a", authorName: "Pete", body: "in" },
    { id: "b", authorName: "Dan", body: "anyone got a spare shin pad" },
    { id: "c", authorName: "Ali", body: "@Match Time who is playing?" },
  ];
  const byBody = { in: "self_att", "anyone got a spare shin pad": "none", "@Match Time who is playing?": "question" };

  it("still asks the model, inside the overflow, and keeps only the attendance routes", async () => {
    const { within, row } = overCap({ cap: 1, spent: 1.2 });
    const model = routerModel(byBody);
    const r = await within(() => routeBatch(model, msgs, { capped: true }));
    const by = Object.fromEntries(r.routes.map((x) => [x.messageId, [x.route, x.source]]));
    expect(by).toEqual({ a: ["self_att", "model"], b: ["none", "model"], c: ["none", "capped"] });
    expect(model.calls).toBe(1);
    expect(row.labels).toEqual(["router (overflow)"]);
  });

  it("a refusal found mid-batch (not known capped) asks once more inside the overflow", async () => {
    const { within, row } = overCap({ cap: 1, spent: 1.2 });
    const model = routerModel(byBody);
    const r = await within(() => routeBatch(model, msgs));
    expect(r.routes.find((x) => x.messageId === "a")).toMatchObject({ route: "self_att" });
    expect(r.routes.find((x) => x.messageId === "c")).toMatchObject({ route: "none", source: "capped" });
    expect(row.refused).toBe(1);
    expect(model.calls).toBe(1);
  });

  it("past twice the cap nothing is read: every message is capped, none is guessed at", async () => {
    const { within } = overCap({ cap: 1, spent: 2 });
    const model = routerModel(byBody);
    const r = await within(() => routeBatch(model, msgs, { capped: true }));
    expect(model.calls).toBe(0);
    expect(r.routes.map((x) => [x.route, x.source])).toEqual([
      ["none", "capped"],
      ["none", "capped"],
      ["none", "capped"],
    ]);
    expect(r.routes.some((x) => x.route === "unsure")).toBe(false);
  });

  it("an open question still rescues a none into unsure at the cap: that is an attendance read", async () => {
    const { within } = overCap({ cap: 1, spent: 1.2 });
    const r = await within(() =>
      routeBatch(routerModel({}), [{ id: "b", authorName: "Dan", body: "👍" }], {
        capped: true,
        awaiting: { id: "x", orgId: "org-1", kind: "bench-slot-offer", askedAt: new Date(), closesAt: null },
      }),
    );
    expect(r.routes[0]).toMatchObject({ route: "unsure", source: "awaiting" });
  });
});

describe("gateBatch in capped mode", () => {
  it("routes with the model inside the overflow and skips what is not attendance", async () => {
    const { within } = overCap({ cap: 1, spent: 1.2 });
    const g = await within(() =>
      gateBatch(
        [
          { waMessageId: "a", body: "out", authorName: "Pete" },
          { waMessageId: "b", body: "@Match Time what time is kickoff", authorName: "Ali" },
        ],
        { capped: true, model: routerModel({ out: "self_att", "@Match Time what time is kickoff": "question" }) },
      ),
    );
    expect(g.modelCalled).toBe(true);
    expect(g.analysed).toEqual(["a"]);
    expect(g.skipped).toEqual(["b"]);
    expect(g.routes.find((r) => r.messageId === "b")?.source).toBe("capped");
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

/** An attendance extractor answering one sender claim per message,
 *  through the guard. */
function extractorModel(polarityByBody: Record<string, "in" | "out">): PipelineModel & { calls: number } {
  const m = {
    name: "extractor-fake",
    calls: 0,
    async complete(req: ModelRequest): Promise<ModelResponse> {
      return guardedModelCall(
        req.label,
        async () => {
          m.calls++;
          const body = req.user.split("\n").at(-1)!.trim();
          const polarity = polarityByBody[body];
          const claims = polarity
            ? [{ subject: "sender", personRef: "", personNamed: false, polarity, contingent: false, conditionOn: "none", tense: "present", reported: false, confidence: 0.95 }]
            : [];
          return { text: JSON.stringify({ claims, affirmation: "none", sideRequests: [] }), stopReason: "end_turn", usage, costUsd: 0.003, ms: 1 };
        },
        (r) => r.costUsd,
        0.01,
      );
    },
  };
  return m;
}

describe("the attendance engine at the cap", () => {
  it("known capped (aiCapped): IN and OUT are each read once inside the overflow and written", async () => {
    const { within, row } = overCap({ cap: 1, spent: 1.2 });
    const model = extractorModel({ in: "in", out: "out" });
    const { d, registered, cancelled } = deps(model, { aiCapped: true });
    const r = await within(() =>
      run(
        [
          msg({ waMessageId: "a", body: "in" }),
          msg({ waMessageId: "b", body: "out", senderUserId: "u-dan", senderName: "Dan Drummer", authorName: "Dan Drummer" }),
        ],
        d,
      ),
    );
    expect(model.calls).toBe(2);
    expect(row.labels).toEqual(["extractor:attendance (overflow)", "extractor:attendance (overflow)"]);
    expect(registered).toEqual(["u-pete"]);
    expect(cancelled).toEqual(["u-dan"]);
    expect(r.outcomes.get("a")).toMatchObject({ intent: "in", action: "IN" });
  });

  it("capped mid-batch: a refused read is made once more inside the overflow", async () => {
    const { within, row } = overCap({ cap: 1, spent: 1.2 });
    const model = extractorModel({ IN: "in" });
    const { d, registered } = deps(model);
    const r = await within(() => run([msg({ waMessageId: "a", body: "IN" })], d));
    expect(registered).toEqual(["u-pete"]);
    expect(r.ownedIds.has("a")).toBe(true);
    expect(row.refused).toBe(1);
    expect(model.calls).toBe(1);
  });

  it("past twice the cap nothing is read and nothing is guessed: no write, not owned, counted", async () => {
    const { within } = overCap({ cap: 1, spent: 2 });
    const model = extractorModel({ in: "in" });
    const skips: number[] = [];
    const { d, registered, cancelled } = deps(model, {
      aiCapped: true,
      recordCapSkips: async (_org: string, n: number) => {
        skips.push(n);
      },
    });
    const r = await within(() => run([msg({ waMessageId: "a", body: "in" })], d));
    expect(model.calls).toBe(0);
    expect(registered).toEqual([]);
    expect(cancelled).toEqual([]);
    expect(r.ownedIds.size).toBe(0);
    expect(skips).toEqual([1]);
  });

  it("below the cap nothing changes: the extractor reads a bare IN outside the overflow", async () => {
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
