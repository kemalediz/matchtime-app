/**
 * The TWO stub seams the e2e suite drives the server through, in the
 * order a request meets them: the ROUTER seam, then the EXTRACTOR seam.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE VERDICT SEAM IS DELETED, NOT KEPT AS A NO-OP
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `setLlmStub` / `StubVerdict` used to live here. They wrote a file
 * mapping `waMessageId` → the verdict `analyzeBatch` would have emitted.
 * §10 step 8 deleted `analyzeBatch`, `SYSTEM_PROMPT`, `AnalysisVerdict`
 * and `executeVerdict`, so for one commit the helper still wrote a file
 * nothing opened while twenty-one specs still addressed a decider that
 * did not exist. Both are gone now: a stub that cannot change what the
 * server does is worse than no stub, because it reads like configuration
 * and is none.
 *
 * WHAT REPLACED IT, and why it is not the same shape. These two seams
 * stub FACTS and ROUTES, never a decision — the model is no longer asked
 * for one. `StubVerdict.registerAttendance` has no successor field
 * anywhere: what used to be "the model said register this person IN" is
 * now a `claim` with a `polarity`, which the ENGINE then decides about,
 * against capacity, the interaction contract, authorisation, `tense`,
 * `basis`, `contingent` and the confidence floor. Every ported spec
 * therefore pins a DECISION where it used to assume one.
 *
 * ── THE DM-Q&A FLAG IS A DIFFERENT THING AND HAS ITS OWN NAME NOW ────
 *
 * `MT_TEST_LLM_STUB_FILE` was doing two unrelated jobs. It was this
 * file's path, and it was ALSO `src/lib/dm-qa.ts`'s stub flag — read
 * there as a plain truthiness test, never opened — which is how
 * `e2e/sim/qa.spec.ts` asserts the no-leak guarantee structurally (no
 * raw phone digits ever enter a model's context). Deleting the verdict
 * seam while leaving that name behind would have left a variable called
 * "LLM stub file" that is neither an LLM stub nor a file.
 *
 * So the flag was renamed to `MT_TEST_DM_QA_STUB` (`helpers/env.ts`,
 * `helpers/live-llm.ts`, `src/lib/dm-qa.ts`). Same behaviour, same
 * guarantee, a name that says what it does. That rename is the only
 * change under `src/` in this PR and it is one line of logic.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { E2E } from "./env";

/**
 * The ROUTER stub (§10 step 5). It says what the router answered for a
 * given message, and whether the floor and step 7's four routes are on
 * for this request.
 *
 * `{}` means "no override" — the flags fall back to the environment.
 * That is what `clearRouterStub()` writes.
 */
export interface RouterStub {
  /** Overrides ROUTER_GATE_FLOOR_ENABLED. The only boolean on this stub
   *  that selects anything: `enabled` (ROUTER_GATE_ENABLED) and `engine`
   *  (ATTENDANCE_ENGINE_ENABLED) were deleted with their flags in §10
   *  step 8, and these fields went with the specs that passed them. */
  floor?: boolean;
  /**
   * Which of §10 step 7's routes this request owns — `question`,
   * `balancer`, `score`, `admin_ops`. Read by
   * `src/lib/pipeline/route-flags.ts:routeStubConfig` out of THIS SAME
   * FILE, deliberately: one stub JSON configures the whole pipeline for
   * a request, rather than two files that can disagree about which
   * request they describe.
   *
   * Omitted → the env flags, WHICH DEFAULT ON (step 8 inverted the
   * four: `enabledStepSevenRoutes` starts from every step-7 route and
   * removes the ones a flag switches OFF). `[]` → own nothing, stated
   * rather than defaulted, which is the only way a spec can assert "and
   * this route was not owned".
   */
  engineRoutes?: string[];
  /**
   * waMessageId → route. Unmapped ids fall back to `unsure`
   * (`gate.ts:711`), which since §10 step 8 is an ENGINE route — so an
   * unmapped id reaches the attendance extractor, finds no facts in a
   * stub that never mentions it, and writes nothing. A spec that leaves
   * an id unmapped is asserting something about the engine, not about a
   * fallback.
   */
  routes?: Record<string, string>;
  /** Trimmed body → route. The sim harness mints its own message ids, so
   *  a spec addresses the router by what was said. */
  bodies?: Record<string, string>;
}

export function setRouterStub(stub: RouterStub): void {
  mkdirSync(path.dirname(E2E.ROUTER_STUB_FILE), { recursive: true });
  writeFileSync(E2E.ROUTER_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearRouterStub(): void {
  setRouterStub({});
}

/**
 * The EXTRACTOR stub (§10 step 6). One layer later than the router: it
 * says what FACTS the extractor returned for a given body. EVERY
 * extractor reads it — attendance, question, teams, score and admin all
 * resolve their model through `extractorStubFromEnv()` — so the raw
 * JSON's shape is the one belonging to whichever route the router named
 * for that body.
 *
 * It deliberately carries the model's RAW JSON rather than a `Facts`
 * object, so `parseFacts` still runs for real — the enum re-validation,
 * the dropped claim on a drifted polarity and the "none" → null
 * affirmation mapping are part of what a step-6 spec is testing.
 *
 * `{}` — what `clearExtractorStub()` writes — means every body extracts
 * NO claims. That is the direction that cannot invent a write.
 */
export interface ExtractorStub {
  bodies?: Record<string, Record<string, unknown>>;
  /** Bodies whose extractor CALL fails with a real overload error, after
   *  the SDK's four retries. The only way to exercise that path end to
   *  end. */
  fail?: string[];
  /** Every extractor call fails — the total-overload edge. */
  failAll?: boolean;
}

export function setExtractorStub(stub: ExtractorStub): void {
  mkdirSync(path.dirname(E2E.EXTRACTOR_STUB_FILE), { recursive: true });
  writeFileSync(E2E.EXTRACTOR_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearExtractorStub(): void {
  setExtractorStub({});
}

/**
 * The DM-INTENT seam (2026-09-11). One layer of its own, because the 1:1
 * DM surface has no router and no extractor: `lib/dm-intent.ts` is the
 * whole classifier, and behind one of its three values sits
 * `inviteRecentPlayers` — a mass DM to 13-27 real people.
 *
 * It stubs what the MODEL said, never what the route concludes. Every
 * gate behind it runs for real: the admin/superadmin membership lookup,
 * the upcoming-match and completed-match lookups, and the action itself.
 *
 * `{}` — what `clearDmIntentStub()` writes — means every body classifies
 * as `other`. That is the direction that cannot invent a mass DM in a
 * spec that has never heard of it.
 */
export interface DmIntentStub {
  /** Trimmed DM body → "recruit_blast" | "rating_progress" | "other". */
  bodies?: Record<string, string>;
  /** Bodies whose model CALL throws, the way an overloaded API does. The
   *  only way to exercise the fail-closed path end to end. */
  fail?: string[];
}

export function setDmIntentStub(stub: DmIntentStub): void {
  mkdirSync(path.dirname(E2E.DM_INTENT_STUB_FILE), { recursive: true });
  writeFileSync(E2E.DM_INTENT_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearDmIntentStub(): void {
  setDmIntentStub({});
}

/** Every seam back to its empty state. `resetDb()` calls it, so a spec
 *  can never inherit the routes, the facts or the DM intents of the spec
 *  that ran before it — the files are per-checkout and long-lived, and a
 *  leak would make a passing test describe a world nobody wrote. */
export function clearPipelineStubs(): void {
  clearRouterStub();
  clearExtractorStub();
  clearDmIntentStub();
}

// ── Fact builders ─────────────────────────────────────────────────────
//
// Every field of a `Claim` is a property of the MESSAGE, checkable by
// re-reading it (`src/lib/pipeline/types.ts`). These builders fill in
// the boring ones so a spec states only the field it is about.

/** A single attendance claim, with the boring fields filled in. */
export function claim(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject: "sender",
    personRef: "",
    personNamed: false,
    polarity: "in",
    contingent: false,
    conditionOn: "none",
    tense: "present",
    basis: "decision",
    reported: false,
    confidence: 0.95,
    ...over,
  };
}

/** The whole attendance-extractor body, with the boring fields filled in. */
export function facts(
  claims: Array<Record<string, unknown>>,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return { claims, affirmation: "none", sideRequests: [], ...over };
}

/** "in" / "I'm in" — the sender, about themselves, right now. */
export function selfIn(over: Record<string, unknown> = {}): Record<string, unknown> {
  return facts([claim(over)]);
}

/** "out" / "can't make it" — the sender, about themselves. */
export function selfOut(over: Record<string, unknown> = {}): Record<string, unknown> {
  return facts([claim({ polarity: "out", ...over })]);
}

/** One NAMED third party — "Dan is out", "add Rashad". */
export function otherClaim(
  personRef: string,
  polarity: "in" | "out" | "bench",
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return claim({ subject: "other", personRef, personNamed: true, polarity, ...over });
}

/** One named third party, as a whole extractor body. */
export function otherFacts(
  personRef: string,
  polarity: "in" | "out" | "bench",
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return facts([otherClaim(personRef, polarity, over)]);
}

/** An UNNAMED third party — "my brother", "a mate of mine". The
 *  `personNamed: false` is what stops a ghost member being provisioned
 *  and turns the offer into the name-ask (§4.1). */
export function unnamedOther(
  personRef: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return facts([
    claim({
      subject: "other",
      personRef,
      personNamed: false,
      polarity: "in",
      contingent: true,
      conditionOn: "squad",
      tense: "future",
      ...over,
    }),
  ]);
}

// ── The one-call arming helper every ported spec uses ─────────────────

export interface BodyRouting {
  route: string;
  facts?: Record<string, unknown>;
}

/**
 * Say, per message body, what the ROUTER answered and what the
 * EXTRACTOR found — the whole deterministic seam in one call.
 *
 * This is the direct successor to `setLlmStub({ id: verdict })`, and the
 * difference is the point: a verdict said what to DO, this says what was
 * SAID. Everything between here and the database — capacity, the
 * interaction contract, authorisation, the bench, the batch-final squad
 * post — is the real shipped code deciding for itself.
 */
export function engineOn(
  map: Record<string, BodyRouting>,
  opts: { floor?: boolean; engineRoutes?: string[]; fail?: string[]; failAll?: boolean } = {},
): void {
  const bodies: Record<string, string> = {};
  const factBodies: Record<string, Record<string, unknown>> = {};
  for (const [body, v] of Object.entries(map)) {
    bodies[body] = v.route;
    if (v.facts) factBodies[body] = v.facts;
  }
  setRouterStub({
    floor: opts.floor ?? false,
    ...(opts.engineRoutes ? { engineRoutes: opts.engineRoutes } : {}),
    bodies,
  });
  setExtractorStub({
    bodies: factBodies,
    ...(opts.fail ? { fail: opts.fail } : {}),
    ...(opts.failAll ? { failAll: true } : {}),
  });
}
