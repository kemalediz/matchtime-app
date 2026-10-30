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
 * `contingent` and the confidence floor. Every ported spec
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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  /** What each stubbed router call reports it cost, in dollars (default
   *  0). Drives the daily AI cap (`src/lib/ai-budget.ts`) for real. */
  costUsd?: number;
  /** Every router call fails, as an outage would. */
  fail?: boolean;
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
  /** What each stubbed extractor call reports it cost, in dollars
   *  (default 0). Drives the daily AI cap for real. */
  costUsd?: number;
}

export function setExtractorStub(stub: ExtractorStub): void {
  mkdirSync(path.dirname(E2E.EXTRACTOR_STUB_FILE), { recursive: true });
  writeFileSync(E2E.EXTRACTOR_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearExtractorStub(): void {
  setExtractorStub({});
  rmSync(`${E2E.EXTRACTOR_STUB_FILE}.calls`, { force: true });
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
  /** Trimmed DM body → "recruit_blast" | "rating_progress" | "other", or
   *  "intro_messages:1,3" with the categories the model would list. */
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
  rmSync(`${E2E.DM_INTENT_STUB_FILE}.calls`, { force: true });
}

/**
 * The PAYMENT-CLAIM stub (2026-09-23): what `lib/payment-claim.ts`'s
 * model would have said about a player's DM. `{}` means every body is
 * `other`, which writes nothing.
 */
export interface PaymentClaimStub {
  /** Trimmed DM body → "paid" | "paid_for_others" | "other". */
  bodies?: Record<string, string>;
  /** Bodies whose model CALL throws. */
  fail?: string[];
}

export function setPaymentClaimStub(stub: PaymentClaimStub): void {
  mkdirSync(path.dirname(E2E.PAYMENT_CLAIM_STUB_FILE), { recursive: true });
  writeFileSync(E2E.PAYMENT_CLAIM_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearPaymentClaimStub(): void {
  setPaymentClaimStub({});
  rmSync(`${E2E.PAYMENT_CLAIM_STUB_FILE}.calls`, { force: true });
}

/** The MATCH-AVAILABILITY stub (review of #336): DM body → "in" | "out" |
 *  "unclear". `{}` means every body is "unclear", which writes nothing. */
export function setMatchAvailabilityStub(stub: { bodies?: Record<string, "in" | "out" | "unclear">; fail?: string[] }): void {
  mkdirSync(path.dirname(E2E.MATCH_AVAILABILITY_STUB_FILE), { recursive: true });
  writeFileSync(E2E.MATCH_AVAILABILITY_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearMatchAvailabilityStub(): void {
  setMatchAvailabilityStub({});
  rmSync(`${E2E.MATCH_AVAILABILITY_STUB_FILE}.calls`, { force: true });
}

/** The FEE-REPLY stub (quoted-reply context S3): the collector's reply →
 *  "yes" | "no" | "neither". `{}` means "neither", which moves no money. */
export function setFeeReplyStub(stub: { bodies?: Record<string, "yes" | "no" | "neither">; fail?: string[] }): void {
  mkdirSync(path.dirname(E2E.FEE_REPLY_STUB_FILE), { recursive: true });
  writeFileSync(E2E.FEE_REPLY_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearFeeReplyStub(): void {
  setFeeReplyStub({});
  rmSync(`${E2E.FEE_REPLY_STUB_FILE}.calls`, { force: true });
}

/** The PAIRING-REPLY stub (2026-10-21): an owner's reply to the pairing
 *  notice → "accept" | "decline" | "neither". `{}` means "neither". */
export function setPairingReplyStub(stub: { bodies?: Record<string, "accept" | "decline" | "neither">; fail?: string[] }): void {
  mkdirSync(path.dirname(E2E.PAIRING_REPLY_STUB_FILE), { recursive: true });
  writeFileSync(E2E.PAIRING_REPLY_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearPairingReplyStub(): void {
  setPairingReplyStub({});
  rmSync(`${E2E.PAIRING_REPLY_STUB_FILE}.calls`, { force: true });
}

/** The ROSTER-SURVEY stub (quoted-reply context S3): a check-in reply →
 *  "in" | "maybe" | "out" | "unclear". `{}` means "unclear", which saves
 *  nothing. */
export function setRosterSurveyStub(stub: { bodies?: Record<string, "in" | "maybe" | "out" | "unclear">; fail?: string[] }): void {
  mkdirSync(path.dirname(E2E.ROSTER_SURVEY_STUB_FILE), { recursive: true });
  writeFileSync(E2E.ROSTER_SURVEY_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearRosterSurveyStub(): void {
  setRosterSurveyStub({});
  rmSync(`${E2E.ROSTER_SURVEY_STUB_FILE}.calls`, { force: true });
}

/** The VOLUNTEER-NAME stub (2026-10-22): a nameless volunteer's reply →
 *  "name:<the name>" | "out". `{}` means "other", which saves no name and
 *  asks again. */
export function setVolunteerNameStub(stub: { bodies?: Record<string, string>; fail?: string[] }): void {
  mkdirSync(path.dirname(E2E.VOLUNTEER_NAME_STUB_FILE), { recursive: true });
  writeFileSync(E2E.VOLUNTEER_NAME_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearVolunteerNameStub(): void {
  setVolunteerNameStub({});
  rmSync(`${E2E.VOLUNTEER_NAME_STUB_FILE}.calls`, { force: true });
}

/** The CALL-OFF stub (2026-10-29): an organiser's untagged group message →
 *  "calloff"; his DM reply to the offer → "yes" | "no". `{}` means no
 *  call-off and "other". */
export function setCalloffStub(stub: { bodies?: Record<string, "calloff" | "yes" | "no">; fail?: string[] }): void {
  mkdirSync(path.dirname(E2E.CALLOFF_STUB_FILE), { recursive: true });
  writeFileSync(E2E.CALLOFF_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearCalloffStub(): void {
  setCalloffStub({});
  rmSync(`${E2E.CALLOFF_STUB_FILE}.calls`, { force: true });
}

/** The MONTHLY READER stub (2026-10-29): a group message's body → the
 *  model's raw answer (the schema's object). A body with no entry is read
 *  by the deterministic stand-in, as every monthly scenario before. */
export function setMonthlyReaderStub(stub: { bodies?: Record<string, unknown>; fail?: string[] }): void {
  mkdirSync(path.dirname(E2E.MONTHLY_READER_STUB_FILE), { recursive: true });
  // The harness's legacy readings (`monthly-reader-legacy.ts`) are kept.
  let legacy: unknown = undefined;
  try {
    legacy = (JSON.parse(readFileSync(E2E.MONTHLY_READER_STUB_FILE, "utf8")) as { legacy?: unknown }).legacy;
  } catch {
    legacy = undefined;
  }
  writeFileSync(E2E.MONTHLY_READER_STUB_FILE, JSON.stringify({ ...stub, ...(legacy ? { legacy } : {}) }, null, 2));
}

export function clearMonthlyReaderStub(): void {
  mkdirSync(path.dirname(E2E.MONTHLY_READER_STUB_FILE), { recursive: true });
  writeFileSync(E2E.MONTHLY_READER_STUB_FILE, "{}");
  rmSync(`${E2E.MONTHLY_READER_STUB_FILE}.calls`, { force: true });
}

/** The HQ SQUAD READER stub (2026-10-29): a multi-line HQ message's body
 *  (trimmed) → the model's raw answer (`{kind, lines, out}`). In an answer,
 *  `member` and `out` may name a member by NAME; the server's stub seam
 *  turns names into the refs it gave. A body with no entry is "other". */
export function setHqSquadReaderStub(stub: { bodies?: Record<string, unknown>; fail?: string[] }): void {
  mkdirSync(path.dirname(E2E.HQ_SQUAD_READER_STUB_FILE), { recursive: true });
  writeFileSync(E2E.HQ_SQUAD_READER_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearHqSquadReaderStub(): void {
  mkdirSync(path.dirname(E2E.HQ_SQUAD_READER_STUB_FILE), { recursive: true });
  writeFileSync(E2E.HQ_SQUAD_READER_STUB_FILE, "{}");
  rmSync(`${E2E.HQ_SQUAD_READER_STUB_FILE}.calls`, { force: true });
}

/** A squad list the reader reads line for line: every name a person, no
 *  ref (the club's name rules place them), under `bench` from `benchFrom`
 *  on, with `out` the members (by name) it leaves off on purpose. */
export function squadReading(names: string[], opts: { out?: string[]; benchFrom?: number; notPeople?: string[] } = {}): Record<string, unknown> {
  return {
    kind: "squad",
    lines: names.map((name, i) => ({
      name,
      member: "",
      section: opts.benchFrom !== undefined && i >= opts.benchFrom ? "bench" : "playing",
      person: !(opts.notPeople ?? []).includes(name),
    })),
    out: opts.out ?? [],
  };
}

/** The DIGEST REPLY stub (2026-10-29): the collector's message → the
 *  model's raw JSON (`{answer, numbers, month, confidence}`). The harness
 *  also registers the old code's reading of every message it posts
 *  (`monthly-reader-legacy.ts`). */
export function setDigestReplyStub(stub: { bodies?: Record<string, string>; fail?: string[] }): void {
  mkdirSync(path.dirname(E2E.DIGEST_REPLY_STUB_FILE), { recursive: true });
  writeFileSync(E2E.DIGEST_REPLY_STUB_FILE, JSON.stringify(stub, null, 2));
}

/** The MONTH SEED REPLY stub (2026-10-29): an organiser's DM body → the
 *  model's raw JSON answer (`{answer, changes, confidence}`). */
export function setMonthSeedReplyStub(stub: { bodies?: Record<string, string>; fail?: string[] }): void {
  mkdirSync(path.dirname(E2E.MONTH_SEED_REPLY_STUB_FILE), { recursive: true });
  writeFileSync(E2E.MONTH_SEED_REPLY_STUB_FILE, JSON.stringify(stub, null, 2));
}

/** The POOL REPLY stub (slice L6): a pool player's reply to his offer →
 *  "accept" | "decline" | "stop" | "question" | "neither", or "low:<intent>"
 *  for an unsure reading. `{}` means "neither", which keeps today's line. */
export function setPoolReplyStub(stub: { bodies?: Record<string, string>; fail?: string[] }): void {
  mkdirSync(path.dirname(E2E.POOL_REPLY_STUB_FILE), { recursive: true });
  writeFileSync(E2E.POOL_REPLY_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearPoolReplyStub(): void {
  setPoolReplyStub({});
  rmSync(`${E2E.POOL_REPLY_STUB_FILE}.calls`, { force: true });
}

/** The user turns a DM classifier stub was asked about, oldest first. */
export function stubCalls(file: string): Array<{ label: string; user: string }> {
  try {
    return readFileSync(`${file}.calls`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { label: string; user: string });
  } catch {
    return [];
  }
}

/** Every seam back to its empty state. `resetDb()` calls it, so a spec
 *  can never inherit the routes, the facts or the DM intents of the spec
 *  that ran before it — the files are per-checkout and long-lived, and a
 *  leak would make a passing test describe a world nobody wrote. */
export function clearPipelineStubs(): void {
  clearRouterStub();
  clearExtractorStub();
  clearDmIntentStub();
  clearPaymentClaimStub();
  clearMatchAvailabilityStub();
  clearFeeReplyStub();
  clearRosterSurveyStub();
  clearVolunteerNameStub();
  clearCalloffStub();
  clearMonthlyReaderStub();
  clearHqSquadReaderStub();
  setMonthSeedReplyStub({});
  setDigestReplyStub({});
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

/**
 * The teams extractor's raw answer (2026-10-16): what the shared pipeline
 * reads from an organiser's "show me the teams", "reshuffle", "swap A and
 * B" or "move A". `moves` are people to the other team, no side named.
 */
export function teamsFacts(
  action: "show" | "generate" | "rename" | "swap" | "suggest",
  moves: string[] = [],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return { action, includeRefs: [], teamNames: [], swaps: [], moves, pairings: [], swapSides: false, ...over };
}

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
  opts: {
    floor?: boolean;
    engineRoutes?: string[];
    fail?: string[];
    failAll?: boolean;
    /** Dollars each stubbed router / extractor call reports it cost. */
    routerCostUsd?: number;
    extractorCostUsd?: number;
  } = {},
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
    ...(opts.routerCostUsd !== undefined ? { costUsd: opts.routerCostUsd } : {}),
    bodies,
  });
  setExtractorStub({
    bodies: factBodies,
    ...(opts.fail ? { fail: opts.fail } : {}),
    ...(opts.failAll ? { failAll: true } : {}),
    ...(opts.extractorCostUsd !== undefined ? { costUsd: opts.extractorCostUsd } : {}),
  });
}

// ── Help (2026-10-28) ─────────────────────────────────────────────────
//
// Help is read by the question extractor in every place (`how_it_works`
// and its `feature`, plus `badge` for a badges question): the players'
// group and HQ through the router, a DM straight through `readDmHelp`.

/** The question extractor's raw answer for a help question. `feature`
 *  "none" is the menu. */
export function helpFacts(feature = "none", badge = "none"): Record<string, unknown> {
  return {
    topic: "how_it_works",
    personRef: "",
    statedCount: -1,
    table: "none",
    listSize: -1,
    listEnd: "top",
    period: "none",
    periodCount: -1,
    periodUnit: "none",
    feature,
    badge,
  };
}

/** Arm the router and the extractor for help questions, by body: the
 *  route (default `question`; HQ's own is `help`) and the topic. */
export function helpOn(map: Record<string, { feature?: string; badge?: string; route?: string }>): void {
  engineOn(
    Object.fromEntries(
      Object.entries(map).map(([body, v]) => [body, { route: v.route ?? "question", facts: helpFacts(v.feature, v.badge) }]),
    ),
  );
}
