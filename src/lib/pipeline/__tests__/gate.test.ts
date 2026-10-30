/**
 * THE GATE — §10 step 5, which used to be "router in front, mega-call
 * behind" and is now "router in front, deterministic owners beside".
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
 * channel, membership of the set of ids that reach an owner at all, and
 * it is monotone on that channel. Its worst case is spending one
 * extractor call on a batch that did not need it. It has no path to
 * losing a write, because it never decides anything about a message it
 * touches — it only ever says "also look at this".
 *
 * §10 STEP 8 CHANGED WHAT IS ON THE FAR END OF THAT CHANNEL AND NOTHING
 * ELSE. `analyzeBatch` is deleted; a message that is not skipped now
 * reaches `attendance-engine-batch.ts`, `pipeline/answer-batch.ts`,
 * `team-ops-engine-batch.ts`, `score-engine-batch.ts` or
 * `admin-ops-engine-batch.ts` instead of the 19,850-token prompt. The
 * monotonicity proof is about the CHANNEL, so every case in it stands
 * untouched — and it matters more than it did, because a message the
 * floor does not rescue is now seen by nobody at all rather than by a
 * second decider.
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
import * as gate from "../gate";
import {
  engineOwnsRoute,
  ENGINE_ROUTES,
  isNoneBucketShadowEnabled,
  partition,
  routerIsNeeded,
  type GateMessage,
} from "../gate";
import { routeBatch } from "../router";
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

// ── TWO OF THESE FLAGS ARE DELETED (§10 step 8, 2026-09-06) ──────────
//
//   `ROUTER_GATE_ENABLED` and `ATTENDANCE_ENGINE_ENABLED` are gone, and
//   with them the cases that pinned their default-OFF and their five
//   accepted spellings. Neither guard is lost, because neither flag has
//   an off position left to guard:
//
//     - `ROUTER_GATE_ENABLED=0` meant "the analyzer sees the banter too".
//       There is no analyzer, so it meant only "`skipped` is empty" - and
//       every owner already refuses a `none` route on its own, which
//       `route-flags.test.ts` and each engine's own suite assert.
//     - `ATTENDANCE_ENGINE_ENABLED=0` would have meant NOBODY handles
//       `self_att` / `other_att` / `offer` / `unsure`. The thing its
//       default-OFF test protected against - a production change
//       disguised as a refactor - is now protected by the flag not
//       existing at all.
//
//   The two cases below survive UNCHANGED, and they are the two that
//   still guard something: the floor needs Kemal's sign-off (§11.1), and
//   the `none`-bucket sweep is the last thing watching the skip bucket.
describe("the flags that are left default OFF", () => {
  it("names no predicate for a flag that was deleted", () => {
    // A tombstone, not a formality. The next person who wants a kill
    // switch for a route will reach for one of these names; failing here
    // sends them to the essay in `gate.ts` that says why an off position
    // with no implementation is worse than no flag, and to
    // `route-flags.ts` for the four flags that were KEPT because their
    // off position is a survivable degradation.
    expect(Object.keys(gate)).not.toContain("isRouterGateEnabled");
    expect(Object.keys(gate)).not.toContain("isAttendanceEngineEnabled");
    expect(Object.keys(gate)).not.toContain("engineHeaderOverride");
    expect(Object.keys(gate)).not.toContain("ENGINE_HEADER");
    expect(Object.keys(gate)).not.toContain("GATE_FLAG");
    expect(Object.keys(gate)).not.toContain("ENGINE_FLAG");
  });

  it("names no predicate for the floor, which was removed on 2026-10-30", () => {
    // No regex reads a message in the model's place ("no string parsing").
    expect(Object.keys(gate)).not.toContain("isRouterFloorEnabled");
    expect(Object.keys(gate)).not.toContain("floorForcesAnalysis");
    expect(Object.keys(gate)).not.toContain("FLOOR_FLAG");
  });

  it("the none-bucket shadow is off unless NONE_BUCKET_SHADOW_ENABLED is on", () => {
    // §11.1's fourth containment, and since step 8 the ONLY remaining
    // thing that ever looks again at a message the router called banter.
    // Before step 8 a wrong `none` could still be caught by the analyzer
    // reading the same window; there is no second decider now.
    expect(isNoneBucketShadowEnabled({})).toBe(false);
    expect(isNoneBucketShadowEnabled({ ROUTER_GATE_ENABLED: "1" })).toBe(false);
    expect(isNoneBucketShadowEnabled({ NONE_BUCKET_SHADOW_ENABLED: "1" })).toBe(true);
  });
});

// ── The floor is monotone. This is the whole argument. ────────────────

describe("partition", () => {
  it("skips only `none`; every other route reaches the analyzer unchanged", () => {
    const ms = ALL_ROUTES.map((r, i) => msg(`m${i}`, `body for ${r}`));
    const rs = routed(
      ms.map((m) => m.waMessageId),
      (i) => ALL_ROUTES[i],
    );
    const p = partition(ms, rs);
    expect(p.skipped).toEqual(["m0"]); // none
    expect(p.analysed).toEqual(ms.slice(1).map((m) => m.waMessageId));
  });

  it("a message with NO route from the router is analysed, never skipped", () => {
    // §11.1's asymmetry, at the gate rather than in the parser: a
    // coverage hole must not look like a decision to drop.
    const ms = [msg("m1", "in"), msg("m2", "🐐")];
    const p = partition(ms, [{ messageId: "m1", route: "none", source: "model" }]);
    expect(p.analysed).toContain("m2");
    expect(p.skipped).toEqual(["m1"]);
  });

  it("an empty batch decides nothing", () => {
    const p = partition([], []);
    expect(p).toEqual({ analysed: [], skipped: [], floorForced: [] });
  });
});

describe("the router has no floor (2026-10-30)", () => {
  it("a bare IN the model routed none stays none: no regex overrules it", async () => {
    const model = {
      name: "fake",
      async complete() {
        return {
          text: JSON.stringify({ routes: [{ id: "m1", route: "none", to_bot: false }] }),
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 0,
        };
      },
    };
    const out = await routeBatch(model, [{ id: "m1", authorName: "a", body: "in" }]);
    expect(out.routes[0]).toMatchObject({ route: "none", source: "model" });
    expect(out.routes[0].overrodeRoute).toBeUndefined();
  });
});

// ── THE THREE `gatedVerdict` CASES ARE DELETED (§10 step 8) ─────────
//
//   They asserted that a skipped message got a verdict byte-identical
//   to the mega-call's banter verdict, and that its reasoning could
//   never trip the partial-response admin DM by matching one of six
//   `offlineVerdict` prefixes.
//
//   Both properties are now structural instead of asserted. There is no
//   verdict to be byte-identical to, and the admin DM no longer
//   prefix-matches prose at all — `lib/operator-note.ts` selects on
//   ownership and drops every `none` route, which
//   `lib/__tests__/operator-note.test.ts` asserts directly ("never notes
//   a `none` route — that is banter, and step 5's whole saving").
//   Waking an admin for every laughing emoji is prevented by a route
//   test rather than by a string not starting with the wrong thing.

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
  // ── THE THREE FLAG CASES ARE DELETED (§10 step 8) ─────────────────
  //
  //   They pinned `ATTENDANCE_ENGINE_ENABLED` default-OFF, its five
  //   accepted spellings, and its independence from the router gate in
  //   both directions. All three described a flag that no longer exists.
  //
  //   The property they were really protecting — "turning this on is a
  //   deliberate act, not a side effect of another flag" — is not lost;
  //   it is unreachable. There is no flag to turn on by accident, and
  //   `runAttendanceEngineBatch`'s `enabled` argument became a REQUIRED
  //   boolean in the same change, so no caller can get an engine it did
  //   not ask for either. The `unsure` cases below are what step 8 added
  //   in their place, and they guard something bigger: which messages
  //   have an owner at all.

  it("owns self_att, other_att, offer — and, since step 8, unsure", () => {
    const owned = ALL_ROUTES.filter((r) => engineOwnsRoute(r));
    expect(owned.sort()).toEqual(["offer", "other_att", "self_att", "unsure"]);
  });

  it("OWNS `unsure`, because step 8 left nothing behind it", () => {
    // ── REVERSED ON 2026-09-06 BY §10 STEP 8, DELIBERATELY ────────────
    //
    // This assertion used to read `false`, and its reason was correct at
    // the time: §11.1's asymmetry, and §13's conservative default that
    // "doubt costs an analyzer call, never a write from a path with less
    // context".
    //
    // Step 8 deletes the analyzer. There is no path with more context;
    // there is no other path at all. So the choice `unsure` presents is
    // no longer "engine or analyzer" but "engine or SILENCE", and
    // §11.1's asymmetry answers that one the other way round in its own
    // words: "A false positive costs one extractor call (~$0.002) that
    // returns no claims. A false negative costs a player their slot."
    expect(engineOwnsRoute("unsure")).toBe(true);
  });

  it("owns what PR #43's open-question rescue produces", () => {
    // The seam between #43 and §10 steps 6/8, asserted rather than
    // assumed. #43 rewrites `none` → `unsure` when MatchTime is still
    // waiting for an answer, so a bare `👍` claiming an open slot is no
    // longer thrown away. Until step 8 the rescued message went to the
    // ANALYZER; with the analyzer deleted it would have gone nowhere,
    // which would have made #43 a rescue into silence — the exact
    // failure it was built to close.
    expect(engineOwnsRoute("unsure")).toBe(true);
    expect(ENGINE_ROUTES).toContain("unsure");
  });

  it("makes router.ts's own failure comment true rather than aspirational", () => {
    // `router.ts:365` catches a failed router call and routes the WHOLE
    // batch to `unsure`, with the comment "§11.4: on router failure,
    // route EVERYTHING to the attendance extractor." That was not what
    // happened: `unsure` was not an engine route, so a router outage
    // sent the batch to the mega-prompt instead — which, after step 8,
    // would have been silence for every message in it.
    //
    // The whole of §11.4's containment is bought by this one membership,
    // so it is pinned here as its own case: if someone removes `unsure`
    // from ENGINE_ROUTES again, the thing that breaks is router-failure
    // handling, and this is the test that says so.
    expect(ENGINE_ROUTES).toContain("unsure");
  });

  it("never owns a route it has never heard of", () => {
    expect(engineOwnsRoute(undefined)).toBe(false);
    expect(engineOwnsRoute("lineup_ops" as never)).toBe(false);
  });

  it("the router ALWAYS runs — a route is no longer an optimisation", () => {
    // This case used to read "the router must run when EITHER flag is
    // on", and its companion pinned that the flag came from the CALLER
    // so a per-request override could not disagree with the env. Both
    // flags are deleted, and so is the failure they described (the
    // engine running with no routes: "a flag that looks enabled and does
    // nothing").
    //
    // What replaced it is stronger and is what this asserts. After step
    // 8 a route is not a cost-saving; it is the ONLY thing that says
    // which owner a message belongs to. Skip the router and every
    // message is unowned, every reply is an operator note, and MatchTime
    // says nothing to anybody. So the answer is `true` with no argument
    // able to change it.
    expect(routerIsNeeded()).toBe(true);
    expect(routerIsNeeded.length).toBe(0);
  });
});

// ── THE TEST-ONLY PER-REQUEST ENGINE OVERRIDE IS DELETED (step 8) ────
//
//   Four cases went with `engineHeaderOverride` and `ENGINE_HEADER`
//   ("x-mt-attendance-engine"): that the header is inert without
//   MT_TEST_MODE=1, that it reads both directions inside a test process,
//   that an unrecognised value falls back to the flag, and that its name
//   cannot collide with step 7's.
//
//   They were guarding a test-only override ON THE WRITE PATH, which is
//   exactly the kind of thing that has to be proven inert rather than
//   assumed inert — so deleting them needs a reason, and it is not
//   "tidy-up". The header existed for the ONE thing the stub-file seam
//   cannot do: a LIVE A/B with the engine on for one arm and the
//   analyzer on for the other, in one process. Step 8 deletes the
//   analyzer, so there is no second arm; the header could now only ever
//   choose between "the engine" and "nothing at all", which is not an
//   experiment, and a switch that can only turn the write path OFF in a
//   process that thinks it is a test is a liability with no upside.
//
//   `route-flags.ts`'s `x-mt-engine-routes` header SURVIVES and keeps
//   its own inert-without-MT_TEST_MODE cases, because step 7's routes
//   still have two shipped sides to compare.

