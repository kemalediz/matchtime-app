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
  /** Every "which team won?" the batch asked the apply layer to remember. */
  asked: Array<{ matchId: string; first: number; second: number; askerUserId: string | null }>;
  /** Matches whose one bare swap the batch recorded as used. */
  swapped: string[];
  recorded: Array<{ matchId: string; red: number; yellow: number; previous?: { red: number; yellow: number } }>;
  /** One entry per Elo reconcile, holding the match it was asked about. */
  elo: string[];
  deps: ScoreBatchDeps;
}

function recorder(
  model: PipelineModel,
  state: SquadState,
  over: Partial<ScoreBatchDeps> = {},
  /** How many ratings the reconcile reports it moved. */
  eloMoved = 2,
): Recorder {
  const recorded: Recorder["recorded"] = [];
  const elo: string[] = [];
  const asked: Recorder["asked"] = [];
  const swapped: string[] = [];
  return {
    asked,
    swapped,
    recorded,
    elo,
    deps: {
      model,
      loadState: async () => state,
      recordScore: async (a) => {
        recorded.push(a);
      },
      reconcileElo: async (matchId) => {
        elo.push(matchId);
        return { moved: eloMoved };
      },
      recordScoreAsk: async (a) => {
        asked.push(a);
      },
      recordScoreSwap: async (matchId) => {
        swapped.push(matchId);
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
// What the team-aware extractor returns for it (2026-10-07). Two
// different numbers with no team would be ASKED about, not recorded.
const WON_FACTS = { first: 5, second: 3, winner: "Red" };

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
    expect(r.elo).toEqual(["done-1"]);

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

// ── 2b. Whose number is whose, and corrections (2026-10-07) ────────────

describe("the 2026-10-06 incident, end to end through the batch", () => {
  const TO_YELLOWS = "it was 6-6 until 15 minutes then suddenly it turned to 9-6 to yellows";
  const FIX = "@Match Time no Yellow 9 - 6 Red";
  const UNTAGGED_FIX = "no Yellow 9 - 6 Red";
  const FIX_FACTS = { first: 9, second: 6, firstTeam: "Yellow", secondTeam: "Red", correction: true };

  it('"9-6 to yellows" is recorded Red 6, Yellow 9, and the reply names the winner', async () => {
    const { model } = stubModel({ [TO_YELLOWS]: { first: 9, second: 6, winner: "yellows" } });
    const r = recorder(model, playedWorld());
    const res = await run({ messages: [msg({ body: TO_YELLOWS, tagged: true })], model, deps: r.deps });
    expect(r.recorded).toEqual([{ matchId: "done-1", red: 6, yellow: 9 }]);
    expect([...res.outcomes.values()][0].reply).toBe("Got it 👍 *Yellow* won 9 - 6 against Red. Recorded.");
  });

  it("the correction reaches the apply layer WITH the result it replaces, and the Elo is reconciled", async () => {
    const { model } = stubModel({ [FIX]: FIX_FACTS });
    const r = recorder(
      model,
      playedWorld({
        completedMatch: {
          id: "done-1",
          redScore: 9,
          yellowScore: 6,
          participantUserIds: PLAYED.map((k) => `u-${k}`),
        },
      }),
    );
    const res = await run({ messages: [msg({ body: FIX, tagged: true })], model, deps: r.deps });
    expect(r.recorded).toEqual([{ matchId: "done-1", red: 6, yellow: 9, previous: { red: 9, yellow: 6 } }]);
    expect(r.elo).toEqual(["done-1"]);
    const out = [...res.outcomes.values()][0];
    expect(out.action).toBe("score");
    expect(out.reply).toBe("Corrected 👍 It was Red 9 - 6 Yellow. Now *Yellow* won 9 - 6 against Red.");
  });

  it('third review: two tagged "wrong way round" in one batch swap ONCE, and the use is recorded', async () => {
    const A = "@Match Time wrong way round";
    const B = "@Match Time wrong way round!";
    const SWAP = { hasScore: false, first: 0, second: 0, firstTeam: "", secondTeam: "", winner: "", loser: "", correction: true, swapped: true, otherGame: false };
    const { model } = stubModel({ [A]: SWAP, [B]: SWAP });
    const r = recorder(
      model,
      playedWorld({
        completedMatch: { id: "done-1", redScore: 9, yellowScore: 6, participantUserIds: PLAYED.map((k) => `u-${k}`) },
      }),
    );
    const res = await run({
      messages: [
        msg({ waMessageId: "a", body: A, tagged: true }),
        msg({ waMessageId: "b", body: B, tagged: true, senderUserId: "u-elvin", senderName: fullName("elvin"), authorName: fullName("elvin") }),
      ],
      model,
      deps: r.deps,
    });
    expect(r.recorded).toEqual([{ matchId: "done-1", red: 6, yellow: 9, previous: { red: 9, yellow: 6 } }]);
    expect(r.swapped).toEqual(["done-1"]);
    expect(res.outcomes.get("a")?.reply).toMatch(/^Corrected/);
    expect(res.outcomes.get("b")?.reply).toMatch(/^That match is already recorded: \*Yellow\* won 9 - 6/);
  });

  it("third review: a swap whose score write FAILED does not use up the match's one swap", async () => {
    const A = "@Match Time wrong way round";
    const { model } = stubModel({
      [A]: { hasScore: false, first: 0, second: 0, firstTeam: "", secondTeam: "", winner: "", loser: "", correction: true, swapped: true, otherGame: false },
    });
    const r = recorder(
      model,
      playedWorld({
        completedMatch: { id: "done-1", redScore: 9, yellowScore: 6, participantUserIds: PLAYED.map((k) => `u-${k}`) },
      }),
      {
        recordScore: async () => {
          throw new Error("deadlock detected");
        },
      },
    );
    await run({ messages: [msg({ body: A, tagged: true })], model, deps: r.deps });
    expect(r.swapped).toEqual([]);
  });

  it('third review: "10-7" then "9-7" in one batch stores ONE question and sends one reply', async () => {
    const { model } = stubModel({ "10-7": { first: 10, second: 7 }, "9-7": { first: 9, second: 7 } });
    const r = recorder(model, playedWorld());
    const res = await run({
      messages: [msg({ waMessageId: "a", body: "10-7" }), msg({ waMessageId: "b", body: "9-7" })],
      model,
      deps: r.deps,
    });
    expect(r.asked).toEqual([{ matchId: "done-1", first: 9, second: 7, askerUserId: "u-kemal" }]);
    expect(res.outcomes.get("a")?.reply).toBeNull();
    expect(res.outcomes.get("b")?.reply).toMatch(/^9 - 7: which team won\?/);
  });

  it("third review: numbers the text does not contain are not a score", async () => {
    const BODY = "good game lads, same time next week 21:30";
    const { model } = stubModel({
      [BODY]: { hasScore: true, first: 0, second: 0, firstTeam: "", secondTeam: "", winner: "", loser: "", correction: false, swapped: false, otherGame: false },
    });
    const r = recorder(model, playedWorld());
    await run({ messages: [msg({ body: BODY })], model, deps: r.deps });
    expect(r.recorded).toEqual([]);
    expect(r.asked).toEqual([]);
  });

  it("H2: the same correction WITHOUT a tag changes nothing and says nothing", async () => {
    const { model } = stubModel({ [UNTAGGED_FIX]: FIX_FACTS });
    const r = recorder(
      model,
      playedWorld({
        completedMatch: {
          id: "done-1",
          redScore: 9,
          yellowScore: 6,
          participantUserIds: PLAYED.map((k) => `u-${k}`),
        },
      }),
    );
    const res = await run({ messages: [msg({ body: UNTAGGED_FIX })], model, deps: r.deps });
    expect(r.recorded).toEqual([]);
    expect(r.elo).toEqual([]);
    expect([...res.outcomes.values()][0].reply).toBeNull();
  });

  it("says NOTHING if the match changed under the correction, and reports it", async () => {
    const { model } = stubModel({ [FIX]: FIX_FACTS });
    const r = recorder(
      model,
      playedWorld({
        completedMatch: {
          id: "done-1",
          redScore: 9,
          yellowScore: 6,
          participantUserIds: PLAYED.map((k) => `u-${k}`),
        },
      }),
      {
        recordScore: async () => {
          throw new Error("the match reads 8-6, not the 9-6 this change was decided against");
        },
      },
    );
    const res = await run({ messages: [msg({ body: FIX, tagged: true })], model, deps: r.deps });
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toBeNull();
    expect(out.writeFailed).toBe(true);
    expect(res.degradations.join(" ")).toMatch(/reads 8-6/);
  });

  it("a bare scoreline is asked about: a reply, no score, no Elo, and the question is REMEMBERED", async () => {
    const { model } = stubModel({ "10-7": { first: 10, second: 7 } });
    const r = recorder(model, playedWorld());
    const res = await run({ messages: [msg({ body: "10-7" })], model, deps: r.deps });
    expect(r.recorded).toEqual([]);
    expect(r.elo).toEqual([]);
    expect(r.asked).toEqual([{ matchId: "done-1", first: 10, second: 7, askerUserId: "u-kemal" }]);
    const out = [...res.outcomes.values()][0];
    expect(out.action).toBe("reply");
    expect(out.reply).toBe("10 - 7: which team won? Reply with the winning team: Red or Yellow.");
    expect(res.scoredMatchId).toBeNull();
  });

  it('"Yellow" in answer to the open question records the result WITHOUT a model call', async () => {
    // The stub has no entry for "Yellow": a model call would throw, the
    // extraction would fail and nothing would be owned.
    const { model, calls } = stubModel({});
    const r = recorder(
      model,
      playedWorld({
        completedMatch: {
          id: "done-1",
          participantUserIds: PLAYED.map((k) => `u-${k}`),
          pendingScore: {
            first: 10,
            second: 7,
            askedAt: new Date(NOW.getTime() - 60_000).toISOString(),
            askerUserId: "u-kemal",
          },
        },
      }),
    );
    const res = await run({ messages: [msg({ body: "Yellow" })], model, deps: r.deps });
    expect(calls).toEqual([]);
    expect(res.cost.calls).toBe(0);
    expect(r.recorded).toEqual([{ matchId: "done-1", red: 7, yellow: 10 }]);
    expect([...res.outcomes.values()][0].reply).toBe("Got it 👍 *Yellow* won 10 - 7 against Red. Recorded.");
  });

  it("a bare team name from somebody ELSE is not read as the answer, and records nothing (M2)", async () => {
    // Not the person who posted the scoreline, not an admin, no tag. It
    // goes to the model like any other message, and the engine refuses
    // to complete the question with it whatever the model says.
    const { model, calls } = stubModel({
      Yellow: { hasScore: false, first: 0, second: 0, firstTeam: "", secondTeam: "", winner: "Yellow", loser: "", correction: false, swapped: false, otherGame: false },
    });
    const r = recorder(
      model,
      playedWorld({
        completedMatch: {
          id: "done-1",
          participantUserIds: PLAYED.map((k) => `u-${k}`),
          pendingScore: { first: 10, second: 7, askedAt: new Date(NOW.getTime() - 60_000).toISOString(), askerUserId: "u-kemal" },
        },
      }),
    );
    const res = await run({
      messages: [msg({ body: "Yellow", senderUserId: "u-sait", senderName: fullName("sait"), authorName: fullName("sait") })],
      model,
      deps: r.deps,
    });
    expect(calls).toHaveLength(1);
    expect(r.recorded).toEqual([]);
    expect([...res.outcomes.values()][0].reply).toBeNull();
  });

  it("H1: a question left on a match that HAS a result is not read, and a bare team name changes nothing", async () => {
    const { model } = stubModel({
      Yellow: { hasScore: false, first: 0, second: 0, firstTeam: "", secondTeam: "", winner: "Yellow", loser: "", correction: false, swapped: false, otherGame: false },
    });
    const r = recorder(
      model,
      playedWorld({
        completedMatch: {
          id: "done-1",
          redScore: 10,
          yellowScore: 6,
          participantUserIds: PLAYED.map((k) => `u-${k}`),
          pendingScore: { first: 10, second: 7, askedAt: new Date(NOW.getTime() - 60_000).toISOString(), askerUserId: "u-kemal" },
        },
      }),
    );
    await run({ messages: [msg({ body: "Yellow" }), msg({ waMessageId: "t", body: "Yellow", tagged: true })], model, deps: r.deps });
    expect(r.recorded).toEqual([]);
    expect(r.asked).toEqual([]);
  });

  it('H1: "10-7" and "10-7 to reds" in ONE batch: the result is recorded, no question is asked or stored', async () => {
    const { model } = stubModel({
      "10-7": { first: 10, second: 7 },
      "10-7 to reds": { first: 10, second: 7, winner: "reds" },
    });
    const r = recorder(model, playedWorld());
    const res = await run({
      messages: [
        msg({ waMessageId: "a", body: "10-7", senderUserId: "u-elvin", senderName: fullName("elvin"), authorName: fullName("elvin") }),
        msg({ waMessageId: "b", body: "10-7 to reds" }),
      ],
      model,
      deps: r.deps,
    });
    expect(r.recorded).toEqual([{ matchId: "done-1", red: 10, yellow: 7 }]);
    expect(r.asked).toEqual([]);
    expect(res.outcomes.get("a")?.reply).toBeNull();
    expect(res.outcomes.get("b")?.reply).toBe("Got it 👍 *Red* won 10 - 7 against Yellow. Recorded.");
  });

  it("M1: hasScore true with zeros for a message with no numbers is NOT recorded as 0-0", async () => {
    const { model } = stubModel({
      "good game lads": { hasScore: true, first: 0, second: 0, firstTeam: "", secondTeam: "", winner: "", loser: "", correction: false, swapped: false, otherGame: false },
    });
    const r = recorder(model, playedWorld());
    await run({ messages: [msg({ body: "good game lads" })], model, deps: r.deps });
    expect(r.recorded).toEqual([]);
  });

  it("with no question open, a bare team name is read by the model as usual and records nothing", async () => {
    const { model, calls } = stubModel({
      Yellow: { hasScore: false, first: 0, second: 0, firstTeam: "", secondTeam: "", winner: "Yellow", loser: "", correction: false, swapped: false, otherGame: false },
    });
    const r = recorder(model, playedWorld());
    const res = await run({ messages: [msg({ body: "Yellow" })], model, deps: r.deps });
    expect(calls).toHaveLength(1);
    expect(r.recorded).toEqual([]);
    expect([...res.outcomes.values()][0].reply).toBeNull();
  });

  it("a message with no numbers is never recorded as 0-0", async () => {
    const { model } = stubModel({
      "good game": { hasScore: false, first: 0, second: 0, firstTeam: "", secondTeam: "", winner: "", loser: "", correction: false, swapped: false, otherGame: false },
    });
    const r = recorder(model, playedWorld());
    await run({ messages: [msg({ body: "good game" })], model, deps: r.deps });
    expect(r.recorded).toEqual([]);
  });

  it("still asks out loud if remembering the question failed, and reports it", async () => {
    const { model } = stubModel({ "10-7": { first: 10, second: 7 } });
    const r = recorder(model, playedWorld(), {
      recordScoreAsk: async () => {
        throw new Error("unique violation");
      },
    });
    const res = await run({ messages: [msg({ body: "10-7" })], model, deps: r.deps });
    expect([...res.outcomes.values()][0].reply).toMatch(/which team won/);
    expect(res.degradations.join(" ")).toMatch(/could not be remembered.*unique violation/);
  });

  it("ratings that had to be left alone are reported to the operator, and the score is still acked", async () => {
    const { model } = stubModel({ [FIX]: FIX_FACTS });
    const r = recorder(
      model,
      playedWorld({
        completedMatch: {
          id: "done-1",
          redScore: 9,
          yellowScore: 6,
          participantUserIds: PLAYED.map((k) => `u-${k}`),
        },
      }),
      { reconcileElo: async () => ({ moved: 0, left: "Ratings left as they were: they still reflect 9-6." }) },
    );
    const res = await run({ messages: [msg({ body: FIX, tagged: true })], model, deps: r.deps });
    expect([...res.outcomes.values()][0].reply).toMatch(/^Corrected/);
    expect(res.degradations.join(" ")).toMatch(/still reflect 9-6/);
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
      reconcileElo: async () => {
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
    const r = recorder(model, playedWorld(), {}, 0);
    const res = await run({ messages: [msg({ body: WON })], model, deps: r.deps });
    expect(r.recorded).toHaveLength(1);
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
    // Since 2026-10-07 the apply layer does not even call the maths: it
    // asks `reconcileElo`, and `lib/match-elo.ts` is the one caller of
    // `computeEloDeltas` on a score write.
    expect(SRC).toMatch(/deps\.reconcileElo\(/);
    expect(SRC).not.toMatch(/from ["']\.\/elo["']/);
    expect(SRC).not.toMatch(/Math\.pow/);
  });
});

// ── A prompt too short to cache is not sequenced (2026-09-29) ──────────

describe("the score prompt is under Sonnet's cache minimum, so its calls stay fully parallel", () => {
  it("starts both extractions before either ends", async () => {
    const LOST = "Yellow won 4-2";
    const { model: inner } = stubModel({ [WON]: WON_FACTS, [LOST]: { first: 4, second: 2, winner: "Yellow" } });
    const log: string[] = [];
    const model: PipelineModel = {
      name: "probe",
      async complete(req) {
        const body = req.user.split("\n").slice(-1)[0];
        log.push(`start:${body}`);
        await new Promise((r) => setTimeout(r, 5));
        try {
          return await inner.complete(req);
        } finally {
          log.push(`end:${body}`);
        }
      },
    };
    const r = recorder(model, playedWorld());
    await run({
      messages: [msg({ waMessageId: "s1", body: WON }), msg({ waMessageId: "s2", body: LOST })],
      model,
      deps: r.deps,
    });
    expect(log.slice(0, 2).sort()).toEqual([`start:${WON}`, `start:${LOST}`]);
  });
});
