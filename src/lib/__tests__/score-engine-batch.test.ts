/**
 * §10 STEP 7 PART 2 — the `score` route, owned end to end.
 *
 * Every test here is an OWNERSHIP test before it is a behaviour test,
 * because ownership is where this step can hurt somebody. The rule this
 * file inherits from steps 5, 6 and 7-part-1: every failure mode lands
 * on "the analyzer decides this message", which is today's behaviour and
 * therefore cannot be a regression.
 *
 * The four properties that matter most, in order:
 *
 *   1. NOTHING IS OWNED BY DEFAULT. Flag off → not one model call.
 *   2. NO TAG IS REQUIRED. `score` is deliberately excluded from
 *      `ACTIONY_INTENTS`, so requiring one would be the regression, not
 *      the safeguard — every real "we won 5-3" is untagged.
 *   3. THE ACK NEVER OUTRUNS THE WRITE. A recording that threw says
 *      nothing at all (§3.2 S7, the 2026-05-15 Erdal incident).
 *   4. THE APPLY LAYER TOUCHES NOTHING ELSE. A write of any other kind
 *      makes the whole batch own nothing, loudly.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../pipeline/llm";
import type { EloDelta, PlayerEloInput } from "../elo";
import type { EngineResult, Route, SquadState } from "../pipeline/types";
import { NOW, fullName, world, type WorldOpts } from "../pipeline/__tests__/helpers";
import {
  runScoreBatch,
  describeScoreBatch,
  SCORE_ROUTES,
  type ScoreBatchMessage,
  type ScoreBatchDeps,
} from "../score-engine-batch";

// ── Fixtures ───────────────────────────────────────────────────────────

const PLAYED = ["kemal", "elvin", "sait", "mustafa"];

function playedWorld(over: WorldOpts = {}): SquadState {
  return world({
    confirmed: ["kemal", "elvin"],
    completedMatch: {
      id: "done-1",
      participantUserIds: PLAYED.map((k) => `u-${k}`),
    },
    ...over,
  });
}

/** A model that answers from a table keyed on the message body, and
 *  COUNTS its calls — "the flag is off so nothing was spent" is only
 *  true if nobody called it. */
function stubModel(table: Record<string, unknown>, opts: { throwOn?: string } = {}) {
  const calls: string[] = [];
  const model: PipelineModel = {
    name: "test-stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const body = req.user.split("\n").slice(-1)[0];
      calls.push(`${req.label}|${body}`);
      if (opts.throwOn && body.includes(opts.throwOn)) throw new Error("529 Overloaded");
      const payload = table[body];
      if (payload === undefined) throw new Error(`no stub for "${body}"`);
      return {
        text: JSON.stringify(payload),
        stopReason: "end_turn",
        usage: { inputTokens: 900, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0011,
        ms: 500,
      };
    },
  };
  return { model, calls };
}

interface Recorder {
  recorded: Array<{ matchId: string; red: number; yellow: number }>;
  elo: EloDelta[][];
  deps: ScoreBatchDeps;
}

function recorder(
  model: PipelineModel,
  state: SquadState,
  over: Partial<ScoreBatchDeps> = {},
  eloInputs: PlayerEloInput[] = [
    { userId: "u-kemal", team: "RED", matchRating: 1000 },
    { userId: "u-elvin", team: "YELLOW", matchRating: 1000 },
  ],
): Recorder {
  const recorded: Array<{ matchId: string; red: number; yellow: number }> = [];
  const elo: EloDelta[][] = [];
  return {
    recorded,
    elo,
    deps: {
      model,
      loadState: async () => state,
      recordScore: async (a) => {
        recorded.push(a);
      },
      loadEloInputs: async () => eloInputs,
      applyEloDeltas: async (_matchId, d) => {
        elo.push(d);
      },
      ...over,
    },
  };
}

function msg(o: Partial<ScoreBatchMessage> & { body: string }): ScoreBatchMessage {
  return {
    waMessageId: o.waMessageId ?? `wa-${o.body.slice(0, 12)}`,
    body: o.body,
    authorName: o.authorName ?? fullName("kemal"),
    senderUserId: o.senderUserId === undefined ? "u-kemal" : o.senderUserId,
    senderName: o.senderName ?? fullName("kemal"),
    // Untagged BY DEFAULT. Every real score report is.
    tagged: o.tagged ?? false,
    // `"route" in o` and not `?? "score"`: an EXPLICIT `undefined` is
    // the shape of a message the router never mentioned, and it has to
    // survive the builder or the "never owned" test tests nothing.
    route: "route" in o ? o.route : "score",
    gated: o.gated ?? false,
  };
}

const WON = "Red won 5-3";
const WON_FACTS = { first: 5, second: 3 };

async function run(args: {
  messages: ScoreBatchMessage[];
  model: PipelineModel;
  deps: ScoreBatchDeps;
  enabled?: Route[];
}) {
  return runScoreBatch({
    orgId: "org-1",
    now: NOW,
    messages: args.messages,
    history: [],
    enabled: new Set<Route>(args.enabled ?? ["score"]),
    deps: args.deps,
  });
}

// ── 1. Nothing by default ──────────────────────────────────────────────

describe("the score route owns nothing unless its flag says so", () => {
  it("makes no model call at all with the flag off", async () => {
    const { model, calls } = stubModel({});
    const r = recorder(model, playedWorld());
    const res = await run({ messages: [msg({ body: WON })], model, deps: r.deps, enabled: [] });
    expect(res.ownedIds.size).toBe(0);
    expect(calls).toEqual([]);
    expect(r.recorded).toEqual([]);
    expect(res.cost.calls).toBe(0);
  });

  it("owns nothing for a route that is not `score`, even with the flag on", async () => {
    const { model, calls } = stubModel({});
    const r = recorder(model, playedWorld());
    const res = await run({
      messages: [msg({ body: WON, route: "self_att" }), msg({ body: "x", route: undefined })],
      model,
      deps: r.deps,
    });
    expect(res.ownedIds.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("owns nothing for a message step 5's gate already skipped", async () => {
    const { model, calls } = stubModel({});
    const r = recorder(model, playedWorld());
    const res = await run({
      messages: [msg({ body: WON, gated: true })],
      model,
      deps: r.deps,
    });
    expect(res.ownedIds.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("owns nothing when no match has been played yet — before spending a call", async () => {
    const { model, calls } = stubModel({});
    const r = recorder(model, world({ confirmed: ["kemal"] }));
    const res = await run({ messages: [msg({ body: WON })], model, deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("names exactly the route it owns", () => {
    expect([...SCORE_ROUTES]).toEqual(["score"]);
  });
});

// ── 2. The happy path, untagged, which is the real one ─────────────────

describe("a result reported in the group is recorded", () => {
  it("records the score, moves the ratings, acks and reacts", async () => {
    const { model } = stubModel({ [WON]: WON_FACTS });
    const r = recorder(model, playedWorld());
    const res = await run({ messages: [msg({ body: WON })], model, deps: r.deps });

    expect(res.ownedIds.size).toBe(1);
    expect(r.recorded).toEqual([{ matchId: "done-1", red: 5, yellow: 3 }]);
    expect(r.elo).toHaveLength(1);
    expect(r.elo[0]).toHaveLength(2);

    const out = [...res.outcomes.values()][0];
    expect(out.intent).toBe("score");
    expect(out.action).toBe("score");
    expect(out.matchId).toBe("done-1");
    expect(out.eloApplied).toBe(2);
    expect(out.react).toBe("👍");
    expect(out.reply).toMatch(/5 - 3/);
    expect(out.writeFailed).toBe(false);
    expect(res.scoredMatchId).toBe("done-1");
  });

  it("does NOT require an @Match Time tag", async () => {
    // `interaction-contract.ts:125-129` excludes `score` from
    // ACTIONY_INTENTS by name. Requiring a tag here would refuse every
    // real "we won 5-3" while the flag read as enabled.
    const { model } = stubModel({ [WON]: WON_FACTS });
    const r = recorder(model, playedWorld());
    const res = await run({ messages: [msg({ body: WON, tagged: false })], model, deps: r.deps });
    expect(res.ownedIds.size).toBe(1);
    expect(r.recorded).toHaveLength(1);
  });

  it("records a score from an UNRESOLVED sender", async () => {
    // The @lid case. `route.ts:3457-3462`: losing the score entirely is
    // the worse failure mode.
    const { model } = stubModel({ [WON]: WON_FACTS });
    const r = recorder(model, playedWorld());
    const res = await run({
      messages: [msg({ body: WON, senderUserId: null, senderName: null })],
      model,
      deps: r.deps,
    });
    expect(r.recorded).toEqual([{ matchId: "done-1", red: 5, yellow: 3 }]);
    expect([...res.outcomes.values()][0].reasoning).toMatch(/unresolved sender/i);
  });

  it("records a score on a match still sitting at TEAMS_PUBLISHED", async () => {
    const { model } = stubModel({ [WON]: WON_FACTS });
    const r = recorder(
      model,
      playedWorld({
        completedMatch: {
          id: "done-1",
          status: "TEAMS_PUBLISHED",
          participantUserIds: PLAYED.map((k) => `u-${k}`),
        },
      }),
    );
    await run({ messages: [msg({ body: WON })], model, deps: r.deps });
    expect(r.recorded).toHaveLength(1);
  });

  it("is not gated on the attendance feature", async () => {
    // `route.ts:3109-3111`: "Score stays ungated — it's infrastructure
    // that feeds MoM + ratings, not a user-facing toggle." A
    // MoM-and-ratings-only org needs exactly this and nothing else.
    const { model } = stubModel({ [WON]: WON_FACTS });
    const r = recorder(model, playedWorld({ features: { attendance: false } }));
    await run({ messages: [msg({ body: WON })], model, deps: r.deps });
    expect(r.recorded).toHaveLength(1);
  });

  it("writes nothing for a resolved member who neither played nor is an admin", async () => {
    const { model } = stubModel({ [WON]: WON_FACTS });
    const r = recorder(model, playedWorld());
    const res = await run({
      messages: [msg({ body: WON, senderUserId: "u-zair", senderName: fullName("zair") })],
      model,
      deps: r.deps,
    });
    expect(r.recorded).toEqual([]);
    // Owned, but it neither wrote nor said anything — and the reason is
    // in the audit trail rather than in a silence nobody can query.
    expect([...res.outcomes.values()][0].reasoning).toMatch(/neither played nor is an admin/i);
    expect([...res.outcomes.values()][0].reply).toBeNull();
  });

  it("never overwrites a result that is already recorded", async () => {
    const { model } = stubModel({ [WON]: WON_FACTS });
    const r = recorder(
      model,
      playedWorld({
        completedMatch: {
          id: "done-1",
          redScore: 2,
          yellowScore: 2,
          participantUserIds: PLAYED.map((k) => `u-${k}`),
        },
      }),
    );
    await run({ messages: [msg({ body: WON })], model, deps: r.deps });
    expect(r.recorded).toEqual([]);
  });
});

// ── 3. Fail open, every way it can ─────────────────────────────────────

describe("every failure hands the message back to the analyzer", () => {
  it("a state load that throws owns nothing and says why", async () => {
    const { model } = stubModel({ [WON]: WON_FACTS });
    const r = recorder(model, playedWorld(), {
      loadState: async () => {
        throw new Error("pg is down");
      },
    });
    const res = await run({ messages: [msg({ body: WON })], model, deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(res.degradations.join(" ")).toMatch(/state load failed.*pg is down/);
  });

  it("an extractor that throws disowns THAT message, carrying the reason", async () => {
    // This asserted /handing this message back to the analyzer/ until
    // §10 step 8 deleted the analyzer. The score is now simply not
    // recorded, and the degradation is the ONLY notice anybody gets —
    // `lib/operator-note.ts` prints it beside the lost message on the
    // admin DM. Asserting the sentence asserts the operator is told the
    // truth.
    const { model } = stubModel({ [WON]: WON_FACTS }, { throwOn: "Red won" });
    const r = recorder(model, playedWorld());
    const res = await run({ messages: [msg({ body: WON })], model, deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.recorded).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/529 Overloaded/);
    expect(res.degradations.join(" ")).toMatch(/nobody records this score/);
    expect(res.degradations.join(" ")).not.toMatch(/analyzer/i);
  });

  it("an extractor that returns a shape this path cannot apply hands it back", async () => {
    const { model } = stubModel({ [WON]: { first: "five", second: "three" } });
    const r = recorder(model, playedWorld());
    const res = await run({ messages: [msg({ body: WON })], model, deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.recorded).toEqual([]);
  });

  it("an engine that throws owns nothing rather than 500ing the request", async () => {
    const { model } = stubModel({ [WON]: WON_FACTS });
    const r = recorder(model, playedWorld(), {
      decide: () => {
        throw new Error("coverage violation");
      },
    });
    const res = await run({ messages: [msg({ body: WON })], model, deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.recorded).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/the engine threw.*coverage violation/);
  });

  it("refuses the WHOLE batch if the engine proposes a write this path cannot apply", async () => {
    // There is no apply layer here for an attendance write: it would
    // have no authorisation pass, no `AttendanceEvent` and nowhere to
    // land, and it would be LOST rather than refused.
    const { model } = stubModel({ [WON]: WON_FACTS });
    const r = recorder(model, playedWorld(), {
      decide: (input): EngineResult => ({
        outcomes: input.messages.map((m) => ({
          messageId: m.id,
          route: m.route,
          disposition: "acted",
          reasons: [],
          writes: [],
          react: null,
        })),
        writes: [
          {
            kind: "attendance",
            userId: "u-zair",
            name: "Zair Malik",
            status: "CONFIRMED",
            explicitBench: false,
            promote: false,
            sourceMessageId: input.messages[0].id,
            reason: "smuggled",
          },
        ],
        nextState: input.state,
        speech: [],
        degradations: [],
      }),
    });
    const res = await run({ messages: [msg({ body: WON })], model, deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.recorded).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/cannot apply \(attendance\)/);
  });

  it("refuses a score write attributed to a message it does not own", async () => {
    const { model } = stubModel({ [WON]: WON_FACTS });
    const r = recorder(model, playedWorld(), {
      decide: (input): EngineResult => ({
        outcomes: input.messages.map((m) => ({
          messageId: m.id,
          route: m.route,
          disposition: "noop",
          reasons: [],
          writes: [],
          react: null,
        })),
        writes: [
          {
            kind: "score",
            matchId: "done-1",
            red: 9,
            yellow: 0,
            sourceMessageId: "wa-not-in-this-batch",
            reason: "smuggled",
          },
        ],
        nextState: input.state,
        speech: [],
        degradations: [],
      }),
    });
    const res = await run({ messages: [msg({ body: WON })], model, deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.recorded).toEqual([]);
  });
});

// ── 4. The ack must not outrun the write ───────────────────────────────

describe("§3.2 S7 · the words must match the action", () => {
  it("says NOTHING when the score write itself threw", async () => {
    const { model } = stubModel({ [WON]: WON_FACTS });
    const r = recorder(model, playedWorld(), {
      recordScore: async () => {
        throw new Error("deadlock detected");
      },
    });
    const res = await run({ messages: [msg({ body: WON })], model, deps: r.deps });
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toBeNull();
    expect(out.react).toBeNull();
    expect(out.writeFailed).toBe(true);
    expect(out.action).toBe("none");
    expect(res.degradations.join(" ")).toMatch(/deadlock detected/);
    expect(res.scoredMatchId).toBeNull();
  });

  it("still acks when the score landed and only the Elo pass failed", async () => {
    // The nesting `route.ts:3519-3533` chose, reproduced: the score is a
    // FACT the group reported; the ratings are a consequence. Losing the
    // score to a rating error is the worse trade.
    const { model } = stubModel({ [WON]: WON_FACTS });
    const r = recorder(model, playedWorld(), {
      applyEloDeltas: async () => {
        throw new Error("rating row moved");
      },
    });
    const res = await run({ messages: [msg({ body: WON })], model, deps: r.deps });
    const out = [...res.outcomes.values()][0];
    expect(r.recorded).toHaveLength(1);
    expect(out.reply).toMatch(/5 - 3/);
    expect(out.eloApplied).toBe(0);
    expect(res.degradations.join(" ")).toMatch(/Elo update failed.*rating row moved/);
  });

  it("records a score for a match whose teams were never generated", async () => {
    const { model } = stubModel({ [WON]: WON_FACTS });
    const r = recorder(model, playedWorld(), {}, []);
    const res = await run({ messages: [msg({ body: WON })], model, deps: r.deps });
    expect(r.recorded).toHaveLength(1);
    expect(r.elo).toEqual([]);
    expect([...res.outcomes.values()][0].eloApplied).toBe(0);
  });
});

// ── 5. The operator's lines ────────────────────────────────────────────

describe("describeScoreBatch", () => {
  it("says nothing when the flag is off and nothing was lost", () => {
    const { info, warns } = describeScoreBatch(
      { ownedIds: new Set(), outcomes: new Map(), scoredMatchId: null, degradations: [], cost: { usd: 0, calls: 0, ms: 0 } },
      3,
    );
    expect(info).toBeNull();
    expect(warns).toEqual([]);
  });

  it("speaks up for a batch that owned nothing but LOST something", () => {
    // The `&&` bug step 6 found: a batch whose whole extraction failed
    // must not read like a batch where the flag was off.
    const { info, warns } = describeScoreBatch(
      {
        ownedIds: new Set(),
        outcomes: new Map(),
        scoredMatchId: null,
        degradations: ["extractor died"],
        cost: { usd: 0, calls: 0, ms: 0 },
      },
      3,
    );
    expect(info).toMatch(/decided 0\/3/);
    expect(warns).toEqual(["[analyze] score-engine degraded: extractor died"]);
  });
});

// ── 6. The apply layer touches no database of its own ──────────────────

describe("the apply layer's dependencies are injected, asserted by scanning it", () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, "..", "score-engine.ts"), "utf8");

  it("imports neither db nor Prisma", () => {
    expect(SRC).not.toMatch(/from ["']\.\/db["']/);
    expect(SRC).not.toMatch(/@prisma\/client/);
    expect(SRC).not.toMatch(/\bdb\s*\./);
  });

  it("does its own arithmetic nowhere — the Elo maths has one implementation", () => {
    expect(SRC).toMatch(/computeEloDeltas/);
    expect(SRC).not.toMatch(/Math\.pow/);
  });
});
