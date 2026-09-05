/**
 * §10 STEP 6 — THE ORCHESTRATOR.
 *
 * `attendance-engine.ts` is the seam and `pipeline/engine.ts` is the
 * decision; this is the thing that decides WHICH MESSAGES either of
 * them ever sees. That question — ownership — is where step 6's risk
 * actually lives, because every wrong answer to it is either a message
 * decided by a path with less context than the analyzer had, or a
 * message decided twice.
 *
 * So the whole "fail open" table from the module header is asserted
 * here, one row at a time, and the assertion is always the same: OWNS
 * NOTHING, which means the analyzer keeps the batch, which is today's
 * behaviour and therefore cannot be a regression.
 */
import { describe, expect, it, vi } from "vitest";
import {
  intentFor,
  runAttendanceEngineBatch,
  tentativeUserId,
  type EngineBatchDeps,
  type EngineBatchMessage,
} from "../attendance-engine-batch";
import type { AttendanceFacts, SquadState } from "../pipeline/types";
import type { PipelineModel } from "../pipeline/llm";

// ── fixtures ────────────────────────────────────────────────────────

function state(over: Partial<SquadState> = {}): SquadState {
  return {
    matchId: "match-1",
    maxPlayers: 4,
    kickoffLabel: "Tue 20:00",
    venue: "The Pitch",
    rows: [],
    roster: [
      { userId: "u-pete", name: "Pete Power", isAdmin: false, hasPhone: true },
      { userId: "u-alice", name: "Alice Admin", isAdmin: true, hasPhone: true },
      { userId: "u-dan", name: "Dan Drummer", isAdmin: false, hasPhone: true },
    ],
    openOffers: [],
    teams: [],
    teamLabels: ["Red", "Yellow"],
    completedMatch: null,
    appearances: [],
    lastBotPost: null,
    features: { attendance: true, paymentTracking: false, statsQa: false },
    smallerFormats: [],
    guestAskedUserIds: [],
    ...over,
  };
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

/** A model that answers every extractor call with the same facts. */
function modelReturning(body: Record<string, unknown>): PipelineModel {
  return {
    name: "fake",
    async complete() {
      return {
        text: JSON.stringify(body),
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 1,
      };
    },
  };
}

const SELF_IN = {
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
};

function deps(over: Partial<EngineBatchDeps> = {}): EngineBatchDeps & {
  registered: string[];
  cancelled: string[];
} {
  const registered: string[] = [];
  const cancelled: string[] = [];
  return {
    registered,
    cancelled,
    model: modelReturning(SELF_IN),
    loadState: async () => state(),
    openBenchPromptUserIds: async () => [],
    async registerAttendance(userId) {
      registered.push(userId);
      return {
        status: "CONFIRMED" as const,
        position: 1,
        slot: 1,
        confirmedCount: 1,
        maxPlayers: 4,
      };
    },
    async cancelAttendance(userId) {
      cancelled.push(userId);
      return { status: "DROPPED" as const };
    },
    async resolveOrProvision(name) {
      return { userId: `new-real:${name}` };
    },
    ...over,
  } as EngineBatchDeps & { registered: string[]; cancelled: string[] };
}

async function run(messages: EngineBatchMessage[], d = deps(), enabled = true) {
  return runAttendanceEngineBatch({
    orgId: "org-1",
    now: new Date("2026-09-03T12:00:00Z"),
    messages,
    history: [],
    expectedMatchId: "match-1",
    enabled,
    deps: d,
  });
}

// ── the happy path, so "owns nothing" means something ───────────────

describe("the engine owns the three routes and writes through the shipped apply", () => {
  it("registers the sender for a self_att IN", async () => {
    const d = deps();
    const r = await run([msg()], d);
    expect([...r.ownedIds]).toEqual(["wa-1"]);
    expect(d.registered).toEqual(["u-pete"]);
    expect(r.outcomes.get("wa-1")).toMatchObject({ intent: "in", action: "IN" });
  });

  it("puts a squad post on the message that acted, once", async () => {
    const d = deps();
    const r = await run([msg({ waMessageId: "a" }), msg({ waMessageId: "b" })], d);
    expect(r.squadPostForMessageId).not.toBeNull();
    // ONE, not two.
    expect([r.squadPostForMessageId].filter(Boolean)).toHaveLength(1);
  });

  it("gives every owned message an outcome, even one that wrote nothing", async () => {
    // §3.2 S1's incident (Ibrahim and Baki, silently omitted) as a
    // post-condition rather than a prompt banner.
    const d = deps({ model: modelReturning({ claims: [], affirmation: "none", sideRequests: [] }) });
    const r = await run([msg({ waMessageId: "a" }), msg({ waMessageId: "b" })], d);
    expect([...r.outcomes.keys()].sort()).toEqual(["a", "b"]);
    expect(d.registered).toEqual([]);
  });
});

// ── fail open: every row of the module header's table ───────────────

describe("it fails OPEN — every failure owns nothing and the analyzer keeps the batch", () => {
  it("the flag is off", async () => {
    const d = deps();
    const r = await run([msg()], d, false);
    expect(r.ownedIds.size).toBe(0);
    expect(d.registered).toEqual([]);
  });

  it("the route is not one of the three", async () => {
    for (const route of ["question", "balancer", "score", "admin_ops", "unsure", "none"] as const) {
      const d = deps();
      const r = await run([msg({ route })], d);
      expect(r.ownedIds.size, `route ${route} was owned`).toBe(0);
      expect(d.registered).toEqual([]);
    }
  });

  it("the router never mentioned the id", async () => {
    const d = deps();
    const r = await run([msg({ route: undefined })], d);
    expect(r.ownedIds.size).toBe(0);
  });

  it("step 5's gate already skipped it", async () => {
    const d = deps();
    const r = await run([msg({ gated: true })], d);
    expect(r.ownedIds.size).toBe(0);
  });

  it("there is no active registration match", async () => {
    const d = deps({ loadState: async () => state({ matchId: null }) });
    const r = await run([msg()], d);
    expect(r.ownedIds.size).toBe(0);
    expect(d.registered).toEqual([]);
  });

  it("attendance is off for the org", async () => {
    const d = deps({
      loadState: async () =>
        state({ features: { attendance: false, paymentTracking: false, statsQa: false } }),
    });
    const r = await run([msg()], d);
    expect(r.ownedIds.size).toBe(0);
  });

  it("the state load throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({
      loadState: async () => {
        throw new Error("db down");
      },
    });
    const r = await run([msg()], d);
    expect(r.ownedIds.size).toBe(0);
    err.mockRestore();
  });

  it("the route and the engine disagree about which match registration lands on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps({ loadState: async () => state({ matchId: "some-other-match" }) });
    const r = await run([msg()], d);
    expect(r.ownedIds.size).toBe(0);
    expect(d.registered).toEqual([]);
    warn.mockRestore();
  });

  it("the message is a pasted numbered roster — PR #39's shape, and its guard is in the route", async () => {
    // `reconcilePastedRoster` + `clampRosterDerivedWrites` are the
    // shipped handling for this shape, and PR #35 measured why: the
    // same paste registered a DIFFERENT SUBSET on each run. The engine
    // has no equivalent and would read fourteen lines as fourteen
    // third-party INs, so it does not own the shape at all.
    const d = deps();
    const roster =
      "1. Pete Power\n2. Dan Drummer\n3. Alice Admin\n4. Someone Else\n5. Another Name";
    const r = await run([msg({ body: roster })], d);
    expect(r.ownedIds.size).toBe(0);
    expect(d.registered).toEqual([]);
  });

  it("the message is a shared CONTACT CARD — its display name is not a registration", async () => {
    // Real production message, 2026-06-11: a forwarded vCard plus "Add
    // these 2 boys pl" registered a member called "Salman Shelly Ftbl"
    // and only one of the two people asked for. The card's `FN:` line
    // passes every identity check because it IS a name; what makes it
    // wrong is the container.
    const d = deps();
    const vcard =
      "BEGIN:VCARD\nVERSION:3.0\nN:;Salman Shelly Ftbl;;;\nFN:Salman Shelly Ftbl\nTEL;waid=447700900001:447700900001\nEND:VCARD";
    const r = await run([msg({ body: vcard })], d);
    expect(r.ownedIds.size).toBe(0);
    expect(d.registered).toEqual([]);
  });

  it("the sender has an open bench PROMPT — a different flow the engine has no concept of", async () => {
    // `resolveBenchConfirmation` owns a group "yes"/"👍" answering a
    // PendingBenchConfirmation. Handing that to the engine would silently
    // change what a bench player's own answer does.
    const d = deps({ openBenchPromptUserIds: async () => ["u-pete"] });
    const r = await run([msg()], d);
    expect(r.ownedIds.size).toBe(0);
    expect(d.registered).toEqual([]);
  });

  it("the bench-prompt lookup itself throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({
      openBenchPromptUserIds: async () => {
        throw new Error("db down");
      },
    });
    const r = await run([msg()], d);
    expect(r.ownedIds.size).toBe(0);
    err.mockRestore();
  });

  it("one sender's bench prompt does not un-own the rest of the batch", async () => {
    const d = deps({ openBenchPromptUserIds: async () => ["u-pete"] });
    const r = await run(
      [msg({ waMessageId: "a" }), msg({ waMessageId: "b", senderUserId: "u-dan" })],
      d,
    );
    expect([...r.ownedIds]).toEqual(["b"]);
    expect(d.registered).toEqual(["u-dan"]);
  });
});

// ── the extractor failing is loud, not silent ───────────────────────

describe("an extractor failure hands the message BACK to the analyzer", () => {
  // The behaviour this replaced was "fail closed", which §11.4 asked
  // for — and which meant SILENT: no write, no reply, and a player who
  // said IN not in the squad. The first live corpus sweep of this step
  // measured 27 `529 Overloaded` and 3 `500`s across 10 messages, which
  // took two corpus cases from 3/3 to 0/3 without the engine ever
  // deciding them wrongly. The engine is one of two deciders and the
  // other one is the incumbent with all its seatbelts; handing the
  // message over is the step's own revert, applied per message.

  it("unparseable output → not owned, nothing written, and it is recorded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken: PipelineModel = {
      name: "broken",
      async complete() {
        return {
          text: "this is not JSON",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 1,
        };
      },
    };
    const d = deps({ model: broken });
    const r = await run([msg()], d);
    // NOT owned → the route leaves it in `batchInputs` and the
    // 18,315-token prompt decides it, exactly as it does today.
    expect(r.ownedIds.size).toBe(0);
    expect(r.outcomes.size).toBe(0);
    expect(d.registered).toEqual([]);
    // Loud, not silent: the reason is on the record for the operator.
    expect(r.degradations.join(" ")).toMatch(/handing this message back to the analyzer/);
    warn.mockRestore();
  });

  it("a model call that throws is reported, not swallowed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwing: PipelineModel = {
      name: "throwing",
      async complete() {
        throw new Error("529 Overloaded");
      },
    };
    const d = deps({ model: throwing });
    const r = await run([msg()], d);
    expect(r.ownedIds.size).toBe(0);
    expect(d.registered).toEqual([]);
    expect(r.degradations.join(" ")).toMatch(/529 Overloaded/);
    warn.mockRestore();
  });

  it("one failed extraction does not cost the REST of the batch its decider", async () => {
    // The fallback is per MESSAGE. A batch where one extractor call
    // times out must not send four healthy ones to the analyzer too.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const flaky: PipelineModel = {
      name: "flaky",
      async complete() {
        n += 1;
        if (n === 1) throw new Error("529 Overloaded");
        return {
          text: JSON.stringify(SELF_IN),
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 1,
        };
      },
    };
    const d = deps({ model: flaky });
    const r = await run(
      [
        msg({ waMessageId: "a", senderUserId: "u-pete" }),
        msg({ waMessageId: "b", senderUserId: "u-dan" }),
      ],
      d,
    );
    expect(r.ownedIds.size).toBe(1);
    expect(d.registered).toHaveLength(1);
    warn.mockRestore();
  });
});

// ── the engine sees the whole window ────────────────────────────────

describe("the engine is given every message in the batch, not just the ones it owns", () => {
  it("a non-owned message still gets an outcome inside the engine and no write", async () => {
    // `assertCoverage` requires exactly one outcome per input message,
    // and the banter-drop guard + the state collapse both scan the
    // window. Passing only the owned subset would silently narrow both.
    const d = deps();
    const r = await run([msg({ waMessageId: "a" }), msg({ waMessageId: "b", route: "question" })], d);
    // Only `a` is owned and only `a` gets a route-6 outcome…
    expect([...r.ownedIds]).toEqual(["a"]);
    expect([...r.outcomes.keys()]).toEqual(["a"]);
    // …and nothing was written for `b`.
    expect(d.registered).toEqual(["u-pete"]);
  });
});

// ── the pure derivations ────────────────────────────────────────────

const att = (over: Partial<AttendanceFacts> = {}): AttendanceFacts => ({
  kind: "attendance",
  claims: [],
  affirmation: null,
  sideRequests: [],
  ...over,
});

describe("intentFor — the admin log's vocabulary, from the OUTCOME", () => {
  const w = (userId: string, status: "CONFIRMED" | "BENCH" | "DROPPED") => ({
    kind: "attendance" as const,
    userId,
    name: "X",
    status,
    explicitBench: false,
    promote: false,
    sourceMessageId: "m",
    reason: "r",
  });

  it("reports the SENDER's own move first", () => {
    expect(intentFor([w("u-pete", "DROPPED")], "u-pete", null, null)).toBe("out");
    expect(intentFor([w("u-pete", "CONFIRMED")], "u-pete", null, null)).toBe("in");
    expect(intentFor([w("u-pete", "BENCH")], "u-pete", null, null)).toBe("in");
  });

  it("reports a third-party write as an add", () => {
    expect(intentFor([w("u-dan", "CONFIRMED")], "u-pete", null, null)).toBe("in");
  });

  it("distinguishes a held conditional from silence", () => {
    const facts = att({
      claims: [
        {
          subject: "sender",
          personRef: "",
          personNamed: false,
          polarity: "in",
          contingent: true,
          conditionOn: "self",
          tense: "present",
          basis: "decision",
          reported: false,
          confidence: 0.9,
        },
      ],
    });
    expect(intentFor([], "u-pete", facts, null)).toBe("conditional_in");
  });

  it("distinguishes a cover request from silence", () => {
    expect(intentFor([], "u-pete", att({ sideRequests: ["recruit"] }), null)).toBe(
      "replacement_request",
    );
  });

  it("is `noise` only when nothing happened and nothing was said", () => {
    expect(intentFor([], "u-pete", att(), null)).toBe("noise");
    expect(intentFor([], "u-pete", att(), "here you go")).toBe("question");
  });
});

describe("tentativeUserId — conditional_in flavour (b) survives the move", () => {
  const selfClaim = (over: Record<string, unknown> = {}) => ({
    subject: "sender" as const,
    personRef: "",
    personNamed: false,
    polarity: "in" as const,
    contingent: true,
    conditionOn: "self" as const,
    tense: "present" as const,
    basis: "decision" as const,
    reported: false,
    confidence: 0.9,
    ...over,
  });

  it("records a MAYBE for personal uncertainty", () => {
    expect(tentativeUserId(att({ claims: [selfClaim()] }), "u-pete", [])).toBe("u-pete");
  });

  it("does NOT record one for a standing offer — that one registers", () => {
    // §3.2 S15: flavour (a) and flavour (b) have opposite outcomes, and
    // conflating them is the A5 incident.
    expect(
      tentativeUserId(att({ claims: [selfClaim({ conditionOn: "squad" })] }), "u-pete", []),
    ).toBeNull();
  });

  it("does NOT record one for a contingent DROP — that one holds", () => {
    expect(
      tentativeUserId(att({ claims: [selfClaim({ polarity: "out" })] }), "u-pete", []),
    ).toBeNull();
  });

  it("does NOT record one for a past or hypothetical claim", () => {
    for (const tense of ["past", "hypothetical"]) {
      expect(tentativeUserId(att({ claims: [selfClaim({ tense })] }), "u-pete", [])).toBeNull();
    }
  });

  it("does NOT record one when the sender's row actually moved", () => {
    const landed = [
      {
        kind: "attendance" as const,
        userId: "u-pete",
        name: "Pete",
        status: "CONFIRMED" as const,
        explicitBench: false,
        promote: false,
        sourceMessageId: "m",
        reason: "r",
      },
    ];
    expect(tentativeUserId(att({ claims: [selfClaim()] }), "u-pete", landed)).toBeNull();
  });

  it("does NOT record one for an unresolved sender", () => {
    expect(tentativeUserId(att({ claims: [selfClaim()] }), null, [])).toBeNull();
  });
});
