/**
 * THE GATE — §10 step 5, "router in front, mega-call behind".
 *
 * These tests exist to prove ONE property, and everything else here is
 * supporting evidence for it:
 *
 *   THE FLOOR CAN ONLY EVER ADD A MESSAGE TO THE ANALYSED SET.
 *
 * Kemal's objection on 2026-09-01 — "why still string regex??" — was
 * about a regex fast path that CLASSIFIED, decided a message meant
 * "in", and swallowed half of it. That regex is deleted and stays
 * deleted. This one is a different object: it has exactly one output
 * channel, membership of the set of ids handed to the unchanged
 * analyzer, and it is monotone on that channel. Its worst case is
 * spending $0.03 on a batch that did not need it. It has no path to
 * losing a write, because it never decides anything about a message it
 * touches — it only ever says "also analyse this".
 *
 * A property has to be PROVEN, not asserted, so:
 *   - `routeFloor` never returns `none` (exhaustive + fuzz), which is
 *     what makes the override monotone at the router;
 *   - `partition` with the floor on is a SUPERSET of `partition` with it
 *     off, over a fuzz of arbitrary routes × bodies;
 *   - the analysed messages are the SAME OBJECTS in the SAME ORDER
 *     either way, so nothing can be "handled differently once
 *     analysed".
 */
import { describe, expect, it } from "vitest";
import {
  engineHeaderOverride,
  engineOwnsRoute,
  ENGINE_HEADER,
  ENGINE_ROUTES,
  floorForcesAnalysis,
  gatedVerdict,
  GATED_REASON_PREFIX,
  isAttendanceEngineEnabled,
  isNoneBucketShadowEnabled,
  isRouterFloorEnabled,
  isRouterGateEnabled,
  partition,
  routerIsNeeded,
  type GateMessage,
} from "../gate";
import { routeBatch, routeFloor } from "../router";
import type { Route, RoutedMessage } from "../types";

const ALL_ROUTES: Route[] = [
  "none",
  "self_att",
  "other_att",
  "offer",
  "question",
  "balancer",
  "score",
  "admin_ops",
  "unsure",
];

/** A spread of real message shapes: bare declarations the floor claims,
 *  banter it must not, and the awkward middle. */
const BODIES = [
  "in",
  "In",
  "IN",
  "I'm in",
  "im in",
  "I am in",
  "in 👍",
  "innn",
  "out",
  "Out.",
  "I'm out",
  "can't make it",
  "cant make it",
  "@Ehtisham Ul Haq In",
  "@Zair Malik out",
  "@Najib in",
  "@Match Time in",
  "@Match Time who is playing?",
  "+1",
  "+2",
  "😂😂😂",
  "🐐",
  "great game last night",
  "Zeeshan is out 😂",
  "I was in last week",
  "if I was in the team it wouldn't be ruined",
  "who's in?",
  "in for next week if you're short",
  "https://youtu.be/abc",
  "move Mustafa to the bench, keep Idris in",
  "generate the teams",
  "5-3",
  "Ayoub snatched that spot 😭",
  "Najib said in as well",
  "",
  "   ",
  "I'll be in and out of signal today so text me",
  "in the end we lost",
  "out of order that ref",
];

function msg(id: string, body: string): GateMessage {
  return { waMessageId: id, body, authorName: "someone" };
}

function routed(ids: string[], pick: (i: number) => Route): RoutedMessage[] {
  return ids.map((id, i) => ({ messageId: id, route: pick(i), source: "model" as const }));
}

// ── The flags ─────────────────────────────────────────────────────────

describe("the flags default OFF", () => {
  it("the gate is off unless ROUTER_GATE_ENABLED is explicitly on", () => {
    expect(isRouterGateEnabled({})).toBe(false);
    expect(isRouterGateEnabled({ ROUTER_GATE_ENABLED: "" })).toBe(false);
    expect(isRouterGateEnabled({ ROUTER_GATE_ENABLED: "0" })).toBe(false);
    expect(isRouterGateEnabled({ ROUTER_GATE_ENABLED: "false" })).toBe(false);
    expect(isRouterGateEnabled({ ROUTER_GATE_ENABLED: "off" })).toBe(false);
    // A typo must not turn it on.
    expect(isRouterGateEnabled({ ROUTER_GATE_ENABLED: "yes please" })).toBe(false);
    for (const on of ["1", "true", "TRUE", "yes", "on"]) {
      expect(isRouterGateEnabled({ ROUTER_GATE_ENABLED: on })).toBe(true);
    }
  });

  it("the floor is off unless ROUTER_GATE_FLOOR_ENABLED is explicitly on", () => {
    expect(isRouterFloorEnabled({})).toBe(false);
    // Turning the GATE on must not turn the floor on: Kemal has to sign
    // the floor off separately (§11.1), and the router's true recall is
    // only measurable with the floor off.
    expect(isRouterFloorEnabled({ ROUTER_GATE_ENABLED: "1" })).toBe(false);
    expect(isRouterFloorEnabled({ ROUTER_GATE_FLOOR_ENABLED: "1" })).toBe(true);
  });

  it("the none-bucket shadow is off unless NONE_BUCKET_SHADOW_ENABLED is on", () => {
    expect(isNoneBucketShadowEnabled({})).toBe(false);
    expect(isNoneBucketShadowEnabled({ ROUTER_GATE_ENABLED: "1" })).toBe(false);
    expect(isNoneBucketShadowEnabled({ NONE_BUCKET_SHADOW_ENABLED: "1" })).toBe(true);
  });
});

// ── The floor is monotone. This is the whole argument. ────────────────

describe("the floor can only ever ADD a message to the analysed set", () => {
  it("routeFloor never returns `none` — the property the override rests on", () => {
    // If the floor could ever return `none` it could REMOVE a message
    // from the analysed set, and every other guarantee here collapses.
    for (const body of BODIES) {
      expect(routeFloor(body)).not.toBe("none");
    }
  });

  it("routeFloor never returns `none` for any generated body either", () => {
    const tokens = ["in", "out", "I'm", "im", "@Ali", "@Match", "Time", "+1", "😂", ".", "lol", ""];
    for (let i = 0; i < tokens.length; i++) {
      for (let j = 0; j < tokens.length; j++) {
        for (let k = 0; k < tokens.length; k++) {
          const body = `${tokens[i]} ${tokens[j]} ${tokens[k]}`.trim();
          expect(routeFloor(body)).not.toBe("none");
        }
      }
    }
  });

  it("floorForcesAnalysis is exactly `routeFloor produced a route`", () => {
    for (const body of BODIES) {
      expect(floorForcesAnalysis(body)).toBe(routeFloor(body) !== null);
    }
  });

  it("analysed(floor on) ⊇ analysed(floor off), for every route assignment", () => {
    // Fuzz: every body against every route, plus mixed batches.
    for (const body of BODIES) {
      for (const route of ALL_ROUTES) {
        const ms = [msg("m1", body)];
        const rs: RoutedMessage[] = [{ messageId: "m1", route, source: "model" }];
        const off = partition(ms, rs, { floor: false });
        const on = partition(ms, rs, { floor: true });
        for (const id of off.analysed) {
          expect(on.analysed).toContain(id);
        }
        expect(on.analysed.length).toBeGreaterThanOrEqual(off.analysed.length);
      }
    }
  });

  it("skipped(floor on) ⊆ skipped(floor off) — the floor never skips anything", () => {
    const ms = BODIES.map((b, i) => msg(`m${i}`, b));
    for (let seed = 0; seed < 40; seed++) {
      const rs = routed(
        ms.map((m) => m.waMessageId),
        (i) => ALL_ROUTES[(i * 7 + seed * 3) % ALL_ROUTES.length],
      );
      const off = partition(ms, rs, { floor: false });
      const on = partition(ms, rs, { floor: true });
      for (const id of on.skipped) {
        expect(off.skipped).toContain(id);
      }
    }
  });

  it("a floor-forced message is always analysed and never skipped", () => {
    const ms = BODIES.map((b, i) => msg(`m${i}`, b));
    // The adversarial case: the router says `none` about everything.
    const rs = routed(
      ms.map((m) => m.waMessageId),
      () => "none",
    );
    const on = partition(ms, rs, { floor: true });
    expect(on.floorForced.length).toBeGreaterThan(0);
    for (const id of on.floorForced) {
      expect(on.analysed).toContain(id);
      expect(on.skipped).not.toContain(id);
    }
    // With the floor off, the same batch is skipped entirely — which is
    // the danger the floor exists to bound, stated as a test.
    const off = partition(ms, rs, { floor: false });
    expect(off.analysed).toEqual([]);
    expect(off.skipped.length).toBe(ms.length);
  });

  it("the floor is the ONLY difference: routes are never rewritten by the gate", () => {
    // "No floor pattern can cause a message to be handled differently
    // once analysed." The gate's only output that reaches the analyzer
    // is WHICH messages it sees; it never annotates or reorders them.
    const ms = BODIES.map((b, i) => msg(`m${i}`, b));
    const rs = routed(
      ms.map((m) => m.waMessageId),
      (i) => ALL_ROUTES[i % ALL_ROUTES.length],
    );
    const off = partition(ms, rs, { floor: false });
    const on = partition(ms, rs, { floor: true });
    // Identical order, drawn from the input order, no duplicates.
    for (const p of [off, on]) {
      const order = ms.map((m) => m.waMessageId).filter((id) => p.analysed.includes(id));
      expect(p.analysed).toEqual(order);
      expect(new Set(p.analysed).size).toBe(p.analysed.length);
      // analysed ∪ skipped is exactly the input, with nothing invented.
      expect([...p.analysed, ...p.skipped].sort()).toEqual(
        ms.map((m) => m.waMessageId).sort(),
      );
    }
  });
});

// ── The gate's own behaviour ──────────────────────────────────────────

describe("partition", () => {
  it("skips only `none`; every other route reaches the analyzer unchanged", () => {
    const ms = ALL_ROUTES.map((r, i) => msg(`m${i}`, `body for ${r}`));
    const rs = routed(
      ms.map((m) => m.waMessageId),
      (i) => ALL_ROUTES[i],
    );
    const p = partition(ms, rs, { floor: false });
    expect(p.skipped).toEqual(["m0"]); // none
    expect(p.analysed).toEqual(ms.slice(1).map((m) => m.waMessageId));
  });

  it("a message with NO route from the router is analysed, never skipped", () => {
    // §11.1's asymmetry, at the gate rather than in the parser: a
    // coverage hole must not look like a decision to drop.
    const ms = [msg("m1", "in"), msg("m2", "🐐")];
    const p = partition(ms, [{ messageId: "m1", route: "none", source: "model" }], {
      floor: false,
    });
    expect(p.analysed).toContain("m2");
    expect(p.skipped).toEqual(["m1"]);
  });

  it("an empty batch decides nothing", () => {
    const p = partition([], [], { floor: true });
    expect(p).toEqual({ analysed: [], skipped: [], floorForced: [] });
  });
});

describe("the floor's override records what it replaced", () => {
  it("a floor override carries the model's route, so a RESCUE is distinguishable", async () => {
    // Without this, "how often did the floor rescue a message?" has no
    // honest answer, and the obvious proxy (count `source === "floor"`)
    // over-reports: it counts `other_att → self_att` relabels, which
    // change nothing the gate can see. The first full recall sweep
    // reported 136 rescues that way against a true count of 0.
    const model = {
      name: "fake",
      async complete() {
        return {
          text: JSON.stringify({ routes: [{ id: "m1", route: "none" }, { id: "m2", route: "😂" }] }),
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 0,
        };
      },
    };
    const out = await routeBatch(
      model,
      [
        { id: "m1", authorName: "a", body: "in" },
        { id: "m2", authorName: "b", body: "😂" },
      ],
      { floor: true },
    );
    const m1 = out.routes.find((r) => r.messageId === "m1")!;
    expect(m1.source).toBe("floor");
    expect(m1.route).toBe("self_att");
    expect(m1.overrodeRoute).toBe("none"); // a real rescue
  });

  it("no override, no `overrodeRoute` — an absent field is not a rescue", async () => {
    const model = {
      name: "fake",
      async complete() {
        return {
          text: JSON.stringify({ routes: [{ id: "m1", route: "self_att" }] }),
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 0,
        };
      },
    };
    const out = await routeBatch(model, [{ id: "m1", authorName: "a", body: "whatever" }], {
      floor: true,
    });
    expect(out.routes[0].source).toBe("model");
    expect(out.routes[0].overrodeRoute).toBeUndefined();
  });
});

describe("the verdict a skipped message gets", () => {
  it("is byte-for-byte the noise verdict the mega-call emits for banter", () => {
    const v = gatedVerdict("m1", "none");
    expect(v.intent).toBe("noise");
    expect(v.react).toBeNull();
    expect(v.reply).toBeNull();
    expect(v.registerAttendance).toBeNull();
    expect(v.registerFor).toBeNull();
    expect(v.benchConfirmation).toBeNull();
    expect(v.bulkPayment).toBeNull();
    expect(v.reminder).toBeNull();
    expect(v.recruitRequest).toBe(false);
    expect(v.scoreRed).toBeNull();
    expect(v.scoreYellow).toBeNull();
    expect(v.includeNames).toBeNull();
    expect(v.teamOverrides).toBeNull();
    expect(v.teamNames).toBeNull();
  });

  it("never trips the partial-response admin DM", () => {
    // The route DMs admins on any verdict whose reasoning starts with
    // one of these — they mean "we tried and failed". A gated message
    // means "we decided not to ask", and waking an admin for every
    // laughing emoji would be worse than the thing being guarded.
    const OFFLINE_REASON_PREFIXES = [
      "Claude emitted no verdict for this id",
      "Claude API error:",
      "No text in Claude response",
      "ANTHROPIC_API_KEY not set",
      "Unknown group",
    ];
    const r = gatedVerdict("m1", "none").reasoning;
    for (const p of OFFLINE_REASON_PREFIXES) expect(r.startsWith(p)).toBe(false);
    expect(r.startsWith(GATED_REASON_PREFIX)).toBe(true);
  });

  it("records the route it was skipped for, so triage is one query", () => {
    expect(gatedVerdict("m1", "none").reasoning).toContain("routed none");
    // Defensive: a skipped id with no route recorded still says so
    // rather than claiming a route it never had.
    expect(gatedVerdict("m1", undefined).reasoning).toContain("routed none");
  });
});

// ─────────────────────────────────────────────────────────────────────
// §10 STEP 6 — WHICH MESSAGES THE ENGINE OWNS
// ─────────────────────────────────────────────────────────────────────
//
// Step 5 decided which messages the analyzer SEES. Step 6 decides which
// messages the analyzer no longer DECIDES. The two flags are separate
// on purpose: §10's revert column for step 6 is "flag flips the three
// routes back", and a revert that also switched the router gate off
// would be reverting two steps at once.
describe("the attendance engine's ownership (§10 step 6)", () => {
  it("is OFF unless ATTENDANCE_ENGINE_ENABLED says otherwise", () => {
    expect(isAttendanceEngineEnabled({})).toBe(false);
    expect(isAttendanceEngineEnabled({ ATTENDANCE_ENGINE_ENABLED: "" })).toBe(false);
    expect(isAttendanceEngineEnabled({ ATTENDANCE_ENGINE_ENABLED: "0" })).toBe(false);
    expect(isAttendanceEngineEnabled({ ATTENDANCE_ENGINE_ENABLED: "no" })).toBe(false);
    expect(isAttendanceEngineEnabled({ ATTENDANCE_ENGINE_ENABLED: "maybe" })).toBe(false);
    // A typo in a Vercel env var must never enable the write path.
    expect(isAttendanceEngineEnabled({ ATTENDANCE_ENGINE_ENABLE: "1" })).toBe(false);
  });

  it("turns on for exactly the five spellings the other flags accept", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", "Yes", " on "]) {
      expect(isAttendanceEngineEnabled({ ATTENDANCE_ENGINE_ENABLED: v })).toBe(true);
    }
  });

  it("is independent of the router gate in BOTH directions", () => {
    expect(isAttendanceEngineEnabled({ ROUTER_GATE_ENABLED: "1" })).toBe(false);
    expect(isRouterGateEnabled({ ATTENDANCE_ENGINE_ENABLED: "1" })).toBe(false);
    expect(
      isAttendanceEngineEnabled({ ROUTER_GATE_ENABLED: "0", ATTENDANCE_ENGINE_ENABLED: "1" }),
    ).toBe(true);
  });

  it("owns self_att, other_att and offer — and nothing else", () => {
    const owned = ALL_ROUTES.filter((r) => engineOwnsRoute(r));
    expect(owned.sort()).toEqual(["offer", "other_att", "self_att"]);
  });

  it("never owns `unsure`, so a router that could not tell still reaches the old prompt", () => {
    // §11.1's asymmetry. `unsure` is attendance-SHAPED but unresolved,
    // and the conservative default (§13) is that doubt costs an
    // analyzer call, never a write from a path with less context.
    expect(engineOwnsRoute("unsure")).toBe(false);
  });

  it("never owns what PR #43's open-question rescue produces", () => {
    // The seam between #43 and §10 step 6, asserted rather than assumed.
    // #43 rewrites `none` → `unsure` when MatchTime is still waiting for
    // an answer, so a bare `👍` claiming an open slot is no longer
    // thrown away. `unsure` is deliberately not an engine route, so
    // every rescued message goes to the ANALYZER — the decider with the
    // most context — and never to a path that would have to infer what
    // the thumbs-up was answering. The two mechanisms compose without
    // either weakening the other.
    expect(engineOwnsRoute("unsure")).toBe(false);
    expect(ENGINE_ROUTES).not.toContain("unsure");
  });

  it("never owns a route it has never heard of", () => {
    expect(engineOwnsRoute(undefined)).toBe(false);
    expect(engineOwnsRoute("lineup_ops" as never)).toBe(false);
  });

  it("the router must run when EITHER flag is on — the engine needs routes too", () => {
    expect(routerIsNeeded({})).toBe(false);
    expect(routerIsNeeded({ ROUTER_GATE_ENABLED: "1" })).toBe(true);
    expect(routerIsNeeded({ ATTENDANCE_ENGINE_ENABLED: "1" })).toBe(true);
  });

  it("takes the engine flag from the CALLER, so a per-request override still gets routes", () => {
    // The analyze route resolves the step-6 flag once (env, or the
    // test-only header) and hands it here. Re-reading the env would let
    // the two disagree, and the failure would be the engine running with
    // no routes: a flag that looks enabled and does nothing.
    expect(routerIsNeeded({}, true)).toBe(true);
    expect(routerIsNeeded({ ATTENDANCE_ENGINE_ENABLED: "1" }, false)).toBe(false);
    expect(routerIsNeeded({ ROUTER_GATE_ENABLED: "1" }, false)).toBe(true);
  });
});

/**
 * The one seam a LIVE A/B needs, and the two gates that keep it out of
 * production. A test-only override on the WRITE path is exactly the
 * kind of thing that has to be proven inert rather than assumed inert.
 */
describe("the test-only per-request engine override", () => {
  it("is inert without MT_TEST_MODE=1, whatever the header says", () => {
    for (const v of ["1", "true", "yes", "on", "0", "off", "garbage"]) {
      expect(engineHeaderOverride(v, {})).toBeNull();
      expect(engineHeaderOverride(v, { MT_TEST_MODE: "0" })).toBeNull();
      expect(engineHeaderOverride(v, { MT_TEST_MODE: "true" })).toBeNull();
      // Even with the real flag on, the header cannot turn it off in a
      // process that has not declared itself a test.
      expect(engineHeaderOverride(v, { ATTENDANCE_ENGINE_ENABLED: "1" })).toBeNull();
    }
  });

  it("reads both directions inside a test process", () => {
    const env = { MT_TEST_MODE: "1" };
    for (const v of ["1", "true", "yes", "on", "ON", " 1 "]) {
      expect(engineHeaderOverride(v, env)).toBe(true);
    }
    for (const v of ["0", "false", "no", "off"]) {
      expect(engineHeaderOverride(v, env)).toBe(false);
    }
  });

  it("falls back to the flag when the header is absent or unrecognised", () => {
    const env = { MT_TEST_MODE: "1" };
    expect(engineHeaderOverride(undefined, env)).toBeNull();
    expect(engineHeaderOverride(null, env)).toBeNull();
    expect(engineHeaderOverride("", env)).toBeNull();
    expect(engineHeaderOverride("   ", env)).toBeNull();
    expect(engineHeaderOverride("maybe", env)).toBeNull();
  });

  it("names a header nothing in production sends", () => {
    expect(ENGINE_HEADER).toBe("x-mt-attendance-engine");
  });
});
