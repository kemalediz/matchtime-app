/**
 * §10 STEP 5 — THE ROUTER. IT USED TO BE A GATE IN FRONT OF SOMETHING.
 *
 * What stood here until 2026-09-06, and it was accurate for as long as
 * there was something behind it:
 *
 *   "ROUTER IN FRONT, MEGA-CALL BEHIND. … This module is a GATE, not a
 *    pipeline. It decides ONE thing: which messages the unchanged
 *    18,315-token analyzer sees."
 *
 * §10 step 8 deleted `analyzeBatch`, the 19,850-token `SYSTEM_PROMPT`
 * and `executeVerdict`. There is nothing behind the router any more —
 * there is a set of DETERMINISTIC OWNERS beside it, one per route, and
 * this module's job narrowed accordingly. It now decides ONE thing:
 * which messages nobody is going to spend anything on, because the
 * router called them banter.
 *
 *   `none`                                        → this file, skipped
 *   `self_att` / `other_att` / `offer` / `unsure` → `attendance-engine-batch.ts`
 *   `question`, `balancer` (show)                 → `pipeline/answer-batch.ts`
 *   `balancer` (generate)                         → `team-ops-engine-batch.ts`
 *   `score`                                       → `score-engine-batch.ts`
 *   `admin_ops`                                   → `admin-ops-engine-batch.ts`
 *   anything nobody owned                         → silence in the group
 *                                                   plus one deduped
 *                                                   operator DM
 *                                                   (`lib/operator-note.ts`)
 *
 * 69.3% of real traffic is `noise`, measured over 1,723 production
 * messages (PR #35). An 8-message banter batch cost $0.0389 and 14-19 s
 * under the mega-prompt (§8.2); through the router it was measured at
 * $0.00137 and 1.1 s (PR #37). That saving is now the whole of what
 * skipping buys, and it is still worth having.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE ONLY WAY THIS GOES WRONG IS A REAL `IN` ROUTED `none`, AND IT IS
 * WORSE THAN IT WAS
 * ─────────────────────────────────────────────────────────────────────
 *
 * §11.1 called that the biggest risk in the whole redesign and a genuine
 * regression, on these grounds: "today a misread message still gets a
 * verdict and 54 seatbelts look at it; here it disappears." The first
 * half of that sentence stopped being true on 2026-09-06. A message the
 * router calls `none` is not read by a second decider that might
 * disagree, because there is no second decider. Every trade-off below is
 * made against that, not against cost. Missing a saving costs pennies.
 * Missing a player's IN costs them their place.
 *
 * Four containments. Three of them survive step 8 unchanged; the fourth
 * is the one that now carries the weight:
 *
 *   1. BIAS TOWARD ACTION — in the router prompt, in the router parser
 *      (a missing id becomes `unsure`, never `none`), and again here
 *      (`partition` skips ONLY an explicit `none`; an id the router
 *      never mentioned is handed on). `unsure` is an OWNED route since
 *      step 8, so that bias now buys a real handler rather than a
 *      fallback — see the essay on `ENGINE_ROUTES` below.
 *   2. THE FLOOR — `floorForcesAnalysis`, behind its own flag, default
 *      OFF. See the essay below; it is unchanged and it is still the
 *      only regex in this file.
 *   3. FAIL OPEN — `routeBatch` routes a FAILED ROUTER CALL to `unsure`
 *      for the whole batch, and since step 8 that route has an owner.
 *      `gateBatch`'s own catch is weaker and this is stated rather than
 *      hidden: see "WHAT FAIL-OPEN MEANS NOW" on `gateBatch`.
 *   4. SHADOW THE `none` BUCKET FOREVER — `none-shadow.ts`, driven by
 *      `NONE_BUCKET_SHADOW_ENABLED` below. THIS ONE MATTERS MORE NOW
 *      THAN IT DID WHEN IT WAS WRITTEN. It re-examines the messages this
 *      file skipped and shouts when one of them turns out to have been
 *      an attendance claim, and it is the ONLY remaining thing watching
 *      for a real IN the router called banter. Before step 8 a `none`
 *      that was wrong could still be caught by the analyzer looking at
 *      the same window; now nothing else ever looks.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THERE IS A REGEX HERE AT ALL, AFTER 2026-09-01
 * ─────────────────────────────────────────────────────────────────────
 *
 * Kemal's objection that day — "why still string regex??" — landed on a
 * regex FAST PATH that swallowed half a message: it read the message,
 * decided the message meant "in", acted on that, and the rest of the
 * sentence was never seen by anything. Regex doing CLASSIFICATION is
 * what failed and it stays deleted.
 *
 * The floor is a different object, and the difference is not a matter of
 * degree. THIS IS THE ARGUMENT THAT JUSTIFIES THE FLOOR EXISTING AT ALL,
 * and step 8 does not touch it:
 *
 *   a classifier decides WHAT a message means, and can be wrong in both
 *   directions. The floor decides only WHETHER anyone gets to look, and
 *   can be wrong in one. Its output feeds a set union, so its worst case
 *   is one extra owner's extractor call on a message that did not need
 *   it. It cannot suppress a write, cannot change a verdict, and cannot
 *   alter how a message is handled once it is in the set — the owner
 *   receives the identical message object either way and is told nothing
 *   about why it is there.
 *
 * That is a seatbelt, and it is proven rather than asserted:
 * `__tests__/gate.test.ts` fuzzes arbitrary routes against real message
 * bodies and shows `analysed(floor on) ⊇ analysed(floor off)`, that
 * `routeFloor` can never return `none` (the property the whole thing
 * rests on), and that the analysed list is the same objects in the same
 * order with or without it. That fuzz suite is untouched by step 8 and
 * must stay that way.
 *
 * It still ships DEFAULT OFF, separately from everything else, for two
 * reasons that step 8 did not change: §11.1 says reintroducing a floor
 * at all "is a product decision that needs his sign-off", and the
 * router's true recall can only be measured with the floor out of the
 * way.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE DELIBERATELY DOES *NOT* DO
 * ─────────────────────────────────────────────────────────────────────
 *
 *   • It does not decide anything about a message it passes on. It
 *     labels, and the label is a route.
 *   • It does not remove a skipped message from the batch. The analyze
 *     route keeps scanning the whole batch, and a `none` message
 *     vanishing would change what later passes conclude about its
 *     neighbours.
 *   • It does not go silent about a skip. A skipped message still gets
 *     an `AnalyzedMessage` row tagged `GATED_HANDLED_BY`, which is the
 *     `none`-bucket sweep's only input and the reason "did the gate eat
 *     an IN?" is a query rather than a shrug.
 */
import { readFileSync } from "node:fs";
// ── THE TYPE-ONLY IMPORT OF `AnalysisVerdict` IS DELETED (§10 step 8) ─
//   It existed so `gatedVerdict` could return the mega-call's exact
//   shape, and it was type-only because `message-analyzer.ts` pulls in
//   the Prisma client and a runtime import here would make this module
//   unloadable in the Playwright worker where the recall harness runs
//   it. `AnalysisVerdict` no longer exists. THE PLAYWRIGHT CONSTRAINT
//   STILL DOES: this module must stay loadable outside Next, so any
//   future import of `message-analyzer` or a Prisma-touching module
//   from here has to be type-only for the same reason.
import type { AwaitingQuestion } from "./awaiting-answer";
import { anthropicModel, degradation, type PipelineModel } from "./llm";
import { routeBatch, routeFloor, type RouterMessage } from "./router";
import type { Degradation, Route, RoutedMessage } from "./types";

// ── Flags ─────────────────────────────────────────────────────────────

/**
 * ── `ROUTER_GATE_ENABLED` AND `ATTENDANCE_ENGINE_ENABLED` ARE DELETED ─
 *     (§10 step 8, 2026-09-06)
 *
 * Both were reverts, and the thing they reverted TO was `analyzeBatch`.
 * With `analyzeBatch` deleted their "off" positions stopped being
 * reverts and became something much worse than a missing flag:
 *
 *   • `ATTENDANCE_ENGINE_ENABLED=0` would leave NOBODY handling
 *     `self_att` / `other_att` / `offer` / `unsure`. Every "IN", every
 *     "sorry lads can't make it", every admin demote would be silence
 *     plus an operator note. That is not a tuning lever; it is a kill
 *     switch for the product's core write path wearing the name of one.
 *   • `ROUTER_GATE_ENABLED=0` used to mean "the analyzer sees the banter
 *     too". With no analyzer it means only that `skipped` is empty, and
 *     every owner already refuses a `none` route on its own. The flag is
 *     inert, and an inert flag is the "worst kind of flag" this file has
 *     warned about since step 5, seen from the other side.
 *
 * A flag whose off position has no implementation is worse than no flag,
 * so both are DELETED rather than defaulted ON. THE REVERT FOR STEP 8 IS
 * `git revert`, and that is worth saying plainly rather than leaving a
 * switch that looks like one.
 *
 * The four STEP-7 route flags are the deliberate contrast and they are
 * KEPT, now defaulting ON: their off position is a survivable
 * degradation (MatchTime goes quiet on questions, or on scores, and an
 * operator is told) rather than an unimplemented one. The full argument
 * is in `pipeline/route-flags.ts`.
 *
 * WHAT WENT WITH THEM: `isRouterGateEnabled`, `isAttendanceEngineEnabled`,
 * `ENGINE_HEADER` / `engineHeaderOverride` (the test-only per-request
 * A/B override — there is no second arm to A/B against any more), and
 * the `enabled` / `engine` fields of `RouterStubConfig`. Nothing is left
 * unguarded by their removal: the behaviour they used to select between
 * no longer has two sides.
 */

/** The floor, separately signed off (§11.1). Default OFF. Reintroducing
 *  a floor at all is a product decision that needs Kemal's sign-off, and
 *  the router's true recall is only measurable with it out of the way. */
export const FLOOR_FLAG = "ROUTER_GATE_FLOOR_ENABLED";

/**
 * The nightly `none`-bucket sweep (§11.1's fourth containment). Default
 * OFF, and it is the one flag in this file whose OFF position got more
 * expensive on 2026-09-06.
 *
 * The sweep re-examines the messages this file skipped and shouts when
 * one of them turns out to have carried an attendance claim. §11.1 calls
 * it "the regression detector the current architecture has never had".
 * IT MATTERS MORE NOW THAN WHEN IT WAS WRITTEN: with the mega-prompt
 * deleted it is the ONLY remaining thing watching for a real IN that the
 * router called banter. Before step 8, a wrong `none` could still be
 * caught by a second decider reading the same window; there is no second
 * decider, so nothing else ever looks at that bucket again.
 *
 * ⚠️ AND FOR FIVE NIGHTS NOBODY COULD TELL WHETHER IT WAS RUNNING.
 * Measured 2026-09-11 (§1.4, `MDs/router-accuracy-2026-09-11.md`): the
 * sweep had filed ONE `WindowVerdict` in its whole life, 1 of 506 rows,
 * because the cron only filed a row when it had an alert to report. A
 * clean night wrote nothing and so did a dead cron. The containment
 * argument this file makes was therefore resting on something whose
 * liveness could not be checked. Fixed the same day: the sweep files a
 * row every night whether or not it finds anything, and
 * `lib/bot-health.ts` raises `none-shadow-stale` when one does not turn
 * up inside 30 hours. If that alert is firing, treat everything this
 * file says about containment as unverified until it clears.
 */
export const SHADOW_FLAG = "NONE_BUCKET_SHADOW_ENABLED";

/**
 * The four routes the engine owns, and no others.
 *
 * ─────────────────────────────────────────────────────────────────────
 * `unsure` JOINED THIS LIST ON 2026-09-06 (§10 STEP 8), AND THE REASON
 * IT WAS EXCLUDED IS THE REASON IT IS NOW INCLUDED
 * ─────────────────────────────────────────────────────────────────────
 *
 * What stood here until today, verbatim, and it was right at the time:
 *
 *   "`unsure` is deliberately ABSENT even though it shares the
 *    attendance extractor in the dry run. §11.1's asymmetry runs the
 *    other way once a write is real: inside the dry run a doubtful
 *    message costs one extractor call and proposes nothing, but on the
 *    WRITE path it would decide a squad place from a route the router
 *    itself could not settle. §13's conservative default — 'a missed
 *    add is recoverable in one message; a wrong registration on a paid
 *    match is not' — makes doubt cost an analyzer call, WHICH IS
 *    TODAY'S BEHAVIOUR and therefore cannot be a regression."
 *
 * Every clause of that argument rests on the last one. It compares the
 * engine against a decider that has just been deleted. Step 8 removes
 * `analyzeBatch` and the 19,850-token `SYSTEM_PROMPT`, so the question
 * `unsure` asks is no longer "engine or analyzer" — it is "engine or
 * SILENCE". §11.1 answers that one explicitly and in the opposite
 * direction:
 *
 *   "A false positive costs one extractor call (~$0.002) that returns
 *    no claims. A false negative costs a player their slot. The
 *    asymmetry must be built in, not hoped for."
 *
 * NOTHING IS LOOSENED TO ACCEPT IT. An `unsure` message meets exactly
 * the rules a `self_att` one meets, because it is handed to the same
 * extractor and the same `engine.ts`: the interaction contract's tag
 * gate, capacity, authorisation for a third-party move, the
 * corroboration policy, `contingent`, `tense`, `personNamed`, the
 * confidence floor. The engine is not a second router; it applies one
 * set of rules to a message that arrived by a different door. Its worst
 * case is the one §6.2 measured and accepted — the extractor returns no
 * claims, nothing is written, and the operator note says so.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THIS MEMBERSHIP IS ALSO THE WHOLE OF §11.4'S ROUTER-FAILURE PLAN
 * ─────────────────────────────────────────────────────────────────────
 *
 * `router.ts` already catches a failed router call and routes the entire
 * batch to `unsure`, with the comment "§11.4: on router failure, route
 * EVERYTHING to the attendance extractor. Expensive, correct, and
 * self-limiting because batches are small."
 *
 * That comment was not true. `unsure` was not an engine route, so a
 * router outage sent the whole batch to the mega-prompt — which, once
 * the mega-prompt is gone, would have been silence for every message in
 * it, including a bare "IN". One line here buys the entire containment,
 * and `__tests__/gate.test.ts` pins it as its own case so that removing
 * `unsure` again shows up as "router-failure handling broke" rather
 * than as a routing preference.
 *
 * The same holds for PR #43's open-question rescue, which rewrites
 * `none` → `unsure` while MatchTime is waiting for an answer. Without
 * this line that rescue would, after step 8, have rescued a message into
 * silence.
 */
export const ENGINE_ROUTES: readonly Route[] = [
  "self_att",
  "other_att",
  "offer",
  "unsure",
];

type Env = Record<string, string | undefined>;

/** Deliberately strict: only these four spellings turn something on, so
 *  a typo in a Vercel env var can never enable the floor or the nightly
 *  sweep by accident. `route-flags.ts` keeps a deliberate COPY of this
 *  and asserts the two agree on the same inputs, so loosening one cannot
 *  quietly loosen the other. NOTE the asymmetry with that file: these
 *  two flags default OFF and need an explicit ON, its four default ON
 *  and need an explicit OFF, and each direction is the one that cannot
 *  lose anything for the flag it guards. */
function on(env: Env, key: string): boolean {
  const raw = env[key]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function isRouterFloorEnabled(env: Env = process.env): boolean {
  const stub = routerStubConfig(env);
  if (stub && typeof stub.floor === "boolean") return stub.floor;
  return on(env, FLOOR_FLAG);
}

export function isNoneBucketShadowEnabled(env: Env = process.env): boolean {
  return on(env, SHADOW_FLAG);
}

/**
 * Does the engine decide this route?
 *
 * PURE ROUTE MEMBERSHIP — no env var, no flag, no request context. That
 * was true before §10 step 8 and it is why this predicate survived the
 * deletion of `isAttendanceEngineEnabled` beside it: the flag answered
 * "is the engine switched on at all", which is a question with only one
 * answer now, while this answers "is this message the engine's", which
 * is a question with nine.
 *
 * A route it has never heard of — including `undefined`, which is what a
 * message the router never mentioned looks like — is never owned. That
 * is §11.1's asymmetry restated as a default: a coverage hole must never
 * look like a decision.
 */
export function engineOwnsRoute(route: Route | undefined): boolean {
  return route !== undefined && ENGINE_ROUTES.includes(route);
}

/**
 * Must the router run at all?
 *
 * YES, ALWAYS, and this function is kept rather than deleted so the
 * question stays askable at the call site and the answer stays in one
 * place.
 *
 * It used to take two arguments and OR two flags: step 5 needed routes
 * to decide what the analyzer SAW, step 6 needed the same routes to
 * decide what the analyzer DECIDED, and either flag on meant the router
 * call happened. Both flags are gone (see the block above), and after
 * step 8 a route is not an optimisation — it is the only thing that
 * tells the analyze route WHICH OWNER a message belongs to. Without one,
 * every message is unowned, every reply is an operator note, and
 * MatchTime says nothing to anybody.
 *
 * So there is no environment in which skipping the router is correct,
 * and the honest way to say that is a function that takes no arguments
 * and returns true. The caller still asks; the answer is just no longer
 * a decision.
 */
export function routerIsNeeded(): boolean {
  return true;
}

// ── The floor, as a boolean ───────────────────────────────────────────

/**
 * Does the deterministic floor insist somebody looks at this message?
 *
 * "Reaches the analyzer" is what this used to ask. Since §10 step 8 the
 * set it protects membership of is the set of messages that reach their
 * OWNER rather than being dropped as banter, which is the same channel
 * with a different thing on the far end — and the monotonicity argument
 * below is about the channel, so it is unchanged.
 *
 * A BOOLEAN, on purpose. `routeFloor` returns a `Route`, and inside the
 * dry-run pipeline that route is used — it decides which extractor runs.
 * Here it is DISCARDED. The gate does not care whether the floor thinks
 * a message is `self_att` or `other_att`; it cares only that the floor
 * says "not nothing". Throwing the route away at the boundary is what
 * makes the monotonicity argument structural rather than a promise:
 * there is no channel by which a floor pattern could influence what
 * happens to a message once it is in the batch.
 */
export function floorForcesAnalysis(body: string): boolean {
  return routeFloor(body) !== null;
}

// ── The decision ──────────────────────────────────────────────────────

export interface GateMessage {
  waMessageId: string;
  body: string;
  authorName: string | null;
}

export interface Partitioned {
  /**
   * Ids that reach their owner, in input order.
   *
   * NAMED `analysed` FOR THE MEGA-PROMPT IT NO LONGER FEEDS, and kept
   * that way deliberately: the analyze route, the recall harness, the
   * corpus sweeps and three months of logs all read this field by name,
   * and renaming a field in a deletion PR is how a deletion PR acquires
   * a second bug. It means "not skipped".
   */
  analysed: string[];
  /** Ids the router routed `none` and the floor did not rescue. */
  skipped: string[];
  /** Ids the floor pulled back out of `skipped`. Always a subset of
   *  `analysed`, and always empty when the floor is off. */
  floorForced: string[];
}

/**
 * PURE, and the function the monotonicity proof is about.
 *
 * skip(m) ⟺ route(m) === "none" ∧ ¬(floor ∧ floorForcesAnalysis(m))
 *
 * Read the second clause as the only thing the floor does: remove
 * members from the skip set. It cannot add one, because it appears
 * under a negation and nowhere else.
 */
export function partition(
  messages: GateMessage[],
  routes: RoutedMessage[],
  opts: { floor: boolean },
): Partitioned {
  const routeById = new Map(routes.map((r) => [r.messageId, r.route]));
  const analysed: string[] = [];
  const skipped: string[] = [];
  const floorForced: string[] = [];

  for (const m of messages) {
    // A message the router never mentioned is NOT `none`. §11.1's
    // asymmetry: a coverage hole must never look like a decision.
    const isNone = routeById.get(m.waMessageId) === "none";
    if (!isNone) {
      analysed.push(m.waMessageId);
      continue;
    }
    if (opts.floor && floorForcesAnalysis(m.body)) {
      floorForced.push(m.waMessageId);
      analysed.push(m.waMessageId);
      continue;
    }
    skipped.push(m.waMessageId);
  }

  return { analysed, skipped, floorForced };
}

// ── What a skipped message becomes ────────────────────────────────────

/**
 * `AnalyzedMessage.handledBy` for a message the gate skipped.
 *
 * §11.1's complaint about a `none` route is that the message
 * "disappears silently: no write, no reply, no reaction, no
 * `AnalyzedMessage.action`". The first three are the intent. The fourth
 * is not: a row is still written, tagged with this, so a skipped message
 * is a QUERYABLE FACT rather than an absence. It is what the nightly
 * `none`-bucket shadow reads, what the admin log shows, and what makes
 * "did the gate eat an IN?" answerable with one query instead of never.
 *
 * NOT sent on the wire. `whatsapp-bot/src/api.ts:325` types the
 * response's `handledBy` as a closed union and that file is out of
 * scope here, so the HTTP result keeps saying `llm`. The two fields
 * mean different things anyway — the wire one is a control signal for
 * the Pi (which only special-cases `deduped` and `error`), this one is
 * the audit trail.
 */
export const GATED_HANDLED_BY = "router-gate";

/**
 * ── `GATED_REASON_PREFIX` IS DELETED (§10 step 8) ────────────────────
 *
 * It was `"router-gate:"`, and every gated row's `reasoning` started
 * with it so that `gatedVerdict`'s prose could be told apart from
 * `offlineVerdict`'s six prefixes by the partial-response admin DM —
 * which decided whether to wake a human by matching strings.
 *
 * Nothing keys off it any more. The `none`-bucket sweep selects on
 * `AnalyzedMessage.handledBy = GATED_HANDLED_BY` (`none-shadow.ts:132`),
 * which is a column and not a substring, and the admin DM was replaced
 * by `lib/operator-note.ts`, which selects on OWNERSHIP and drops every
 * `none` route outright. The guard this prefix supported cannot fire
 * wrongly because the thing it fed no longer reads prose at all.
 *
 * The analyze route still writes a row for every skipped message and
 * still says which route it was skipped for; it just writes it as an
 * ordinary reasoning string rather than one a regex elsewhere depends
 * on.
 */

/**
 * ── `gatedVerdict` IS DELETED (§10 step 8) ───────────────────────────
 *
 * It returned "byte-for-byte what the mega-call emits for the 69.3% of
 * traffic that is banter, so every downstream guard, audit pass and
 * reconciliation sees exactly the shape it saw yesterday". There is no
 * mega-call and no `AnalysisVerdict`, so there is no shape to imitate.
 *
 * `GATED_HANDLED_BY` above STAYS, and it is the load-bearing half. The
 * nightly `none`-bucket sweep (`none-shadow.ts:132`) selects on
 * `AnalyzedMessage.handledBy = "router-gate"`, and §11.1 calls that
 * sweep "the regression detector the current architecture has never
 * had". It matters MORE after step 8 than before: it is now the only
 * thing watching for a real IN that the router called banter, because
 * there is no longer a second decider to catch one.
 *
 * `GATED_REASON_PREFIX` went with the verdict. The analyze route still
 * writes a row for every skipped message and still says which route it
 * was skipped for; it just writes it as an ordinary reasoning string
 * rather than one a regex elsewhere depends on.
 */

export interface GateOutcome extends Partitioned {
  routes: RoutedMessage[];
  degradations: Degradation[];
  /** Did the router actually make a call? False when the batch was
   *  empty, or when every message hit the floor and there was nothing
   *  left to ask about. */
  modelCalled: boolean;
  floorEnabled: boolean;
  /** Ids the OPEN-QUESTION context pulled back out of `skipped`, i.e.
   *  the router said `none` while MatchTime was still waiting for an
   *  answer. Always a subset of `analysed`, and always empty when no
   *  question is open -- which is 99% of the history. */
  awaitingForced: string[];
  usage?: { costUsd: number | null; ms: number; inputTokens: number; outputTokens: number };
}

export interface GateOptions {
  floor?: boolean;
  /** Injected by tests and by the recall harness. */
  model?: PipelineModel;
  /**
   * THE ONE OPEN QUESTION MATCHTIME IS STILL WAITING FOR AN ANSWER TO.
   *
   * PR #42 would not turn `ROUTER_GATE_ENABLED` on because two of its
   * 1,695 measured messages were an attendance write the gate lost, and
   * both were a bare thumbs-up answering a slot MatchTime had left open.
   * A thumbs-up pattern in the floor cannot tell those two from the
   * dozens of thumbs-up that are banter; a row in the database can,
   * because the fact lives in the conversation and not in the token. See
   * `awaiting-answer.ts`.
   *
   * PASSED IN, not loaded here: `load-awaiting-answer.ts` is the only
   * module that touches Prisma, and this one has to stay loadable in the
   * Playwright worker and in the plain `tsx` recall script — the same
   * constraint recorded at the top of this file where the type-only
   * `message-analyzer` import used to be.
   *
   * `undefined` -- the default, and what every existing caller gets --
   * is "MatchTime is not waiting for anything", under which the gate
   * behaves exactly as it did on `b03d96b`.
   */
  awaiting?: AwaitingQuestion | null;
}

/**
 * Route a batch and partition it. NEVER THROWS.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT FAIL-OPEN MEANS NOW, STATED RATHER THAN INHERITED
 * ─────────────────────────────────────────────────────────────────────
 *
 * Until 2026-09-06 the comment here read: "Every failure mode lands on
 * 'analyse everything', which is exactly today's behaviour and therefore
 * cannot be a regression." Both halves of that depended on the analyzer.
 * With it deleted, `everything()` below no longer means "analysed by the
 * mega-prompt" — it means "skipped by nobody", which is not the same
 * thing as "handled by somebody".
 *
 * The two failure paths are now genuinely different and the difference
 * is worth knowing at 2am:
 *
 *   • A FAILED ROUTER CALL — the realistic one, and the one §11.4 plans
 *     for — never reaches this catch. `routeBatch` handles it and routes
 *     the ENTIRE batch to `unsure`, which since step 8 is an owned route
 *     (`ENGINE_ROUTES`). Every message goes to the attendance extractor:
 *     expensive, correct, and self-limiting because batches are small.
 *     That is a real containment, not a hope.
 *   • THIS CATCH covers what is left above `routeBatch`: a model
 *     constructor that throws for a missing key, an OOM, a bug in this
 *     file. It returns no routes at all, so every message reaches the
 *     owners UNROUTED, no owner claims an undefined route, and the batch
 *     lands on silence plus one deduped operator DM
 *     (`lib/operator-note.ts`). THAT IS A REAL DEGRADATION AND IT IS NOT
 *     PRETENDED OTHERWISE. It is left as it is because every failure it
 *     covers — no API key, no memory — is one an extractor call would
 *     hit a line later anyway, so manufacturing `unsure` routes here
 *     would buy a second failure rather than a rescue, and would spend a
 *     model call to find that out. What it does buy is the operator
 *     note, which is the signal §9 says this product has never had.
 *
 * The invariant that has not changed: this function never throws, so a
 * router problem can never take the analyze route down with it.
 */
export async function gateBatch(
  messages: GateMessage[],
  opts: GateOptions = {},
): Promise<GateOutcome> {
  const floor = opts.floor ?? isRouterFloorEnabled();
  const everything = (degradations: Degradation[]): GateOutcome => ({
    analysed: messages.map((m) => m.waMessageId),
    skipped: [],
    floorForced: [],
    routes: [],
    degradations,
    modelCalled: false,
    floorEnabled: floor,
    awaitingForced: [],
  });

  if (messages.length === 0) {
    return { ...everything([]), analysed: [] };
  }

  try {
    const model = opts.model ?? defaultGateModel();
    const routerMessages: RouterMessage[] = messages.map((m) => ({
      id: m.waMessageId,
      authorName: m.authorName,
      body: m.body,
    }));
    // `floor: false` at the ROUTER when the floor flag is off, so the
    // router's own answer is what we partition on and its recall is
    // measurable. When the flag is on, the router-level floor and the
    // gate-level floor agree by construction (both are `routeFloor`),
    // and the gate-level one is what the proof is written against.
    const routed = await routeBatch(model, routerMessages, {
      floor,
      awaiting: opts.awaiting ?? null,
    });
    const p = partition(messages, routed.routes, { floor });
    return {
      ...p,
      routes: routed.routes,
      degradations: routed.degradations,
      modelCalled: routed.usage !== undefined,
      floorEnabled: floor,
      awaitingForced: routed.routes.filter((r) => r.source === "awaiting").map((r) => r.messageId),
      ...(routed.usage ? { usage: routed.usage } : {}),
    };
  } catch (err) {
    return everything([
      degradation(
        "router",
        null,
        `the router gate failed (${(err as Error).message}); nothing is skipped, and with no ` +
          `routes no owner can claim a message — the batch degrades to an operator note`,
      ),
    ]);
  }
}

/** The stub seam is checked BEFORE the real model is constructed, so a
 *  stubbed e2e run never needs a key. A missing key in production
 *  surfaces as a throw inside `gateBatch`'s try, where it degrades to
 *  "nothing is skipped and nothing is routed" — see the fail-open essay
 *  on `gateBatch` for what that costs now that there is no analyzer
 *  behind it. */
function defaultGateModel(): PipelineModel {
  return routerStubFromEnv() ?? anthropicModel();
}

/**
 * TEST-ONLY seam, the same shape as `pipeline/extractor-stub.ts`'s.
 * (It used to be described as mirroring `MT_TEST_LLM_STUB_FILE` in
 * `message-analyzer.ts`; that seam went with `analyzeBatch` in §10 step
 * 8, and the extractor stub is now the live sibling to compare against.)
 * When `MT_TEST_ROUTER_STUB_FILE` is set, the
 * router's answer is read from a JSON file
 * (`{"routes": {"<waMessageId>": "none"}}`) instead of a model call, so
 * the stubbed e2e suite can exercise the gate deterministically and for
 * free. Unmapped ids fall back to `unsure` — the safe direction.
 *
 * Never set in production. `e2e/helpers/live-llm.ts` refuses a "live"
 * run that can still see it, the same way it refuses one that can still
 * see any other stub seam.
 */
export const ROUTER_STUB_FILE_ENV = "MT_TEST_ROUTER_STUB_FILE";

export interface RouterStubConfig {
  /**
   * Overrides ROUTER_GATE_FLOOR_ENABLED for this request.
   *
   * THE ONLY BOOLEAN LEFT. `enabled` (ROUTER_GATE_ENABLED) and `engine`
   * (ATTENDANCE_ENGINE_ENABLED) were deleted with their flags in §10
   * step 8 — a stub field can only ever choose between two shipped code
   * paths, and neither of those flags has two any more. A stub file
   * that still carries them is ignored rather than rejected: the extra
   * keys parse, mean nothing, and cannot select anything.
   */
  floor?: boolean;
  /** waMessageId → route. Unmapped ids fall back to `unsure`. */
  routes?: Record<string, string>;
  /** Trimmed message body → route, for specs that cannot know the ids
   *  the sim harness mints. `routes` wins where both match. */
  bodies?: Record<string, string>;
}

/** Read fresh on every call, like the extractor stub, so a spec can
 *  rewrite it between requests. Returns null unless the env var is set —
 *  which is the only thing standing between this and production. */
function routerStubConfig(env: Env = process.env): RouterStubConfig | null {
  const file = env[ROUTER_STUB_FILE_ENV];
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RouterStubConfig;
  } catch {
    // Missing or garbled → behave as if there were no stub at all. The
    // only flag left for it to override is the floor, so the fallback is
    // `ROUTER_GATE_FLOOR_ENABLED`, off by default — which means the
    // router's own answer decides, exactly as in production.
    return {};
  }
}

function routerStubFromEnv(): PipelineModel | null {
  if (!process.env[ROUTER_STUB_FILE_ENV]) return null;
  return {
    name: "router-stub",
    async complete(req) {
      const cfg = routerStubConfig() ?? {};
      const byId = cfg.routes ?? {};
      const byBody = cfg.bodies ?? {};
      // The user block the router is sent is `[id] author: body`, one
      // per line — see `routeBatch`.
      const rows = [...req.user.matchAll(/^\[([^\]]+)\]\s*[^:]*:\s?(.*)$/gm)];
      const routes = rows.map((m) => ({
        id: m[1],
        route: byId[m[1]] ?? byBody[m[2].trim()] ?? "unsure",
      }));
      return {
        text: JSON.stringify({ routes }),
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 0,
      };
    },
  };
}
