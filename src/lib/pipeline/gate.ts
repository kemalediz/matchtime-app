/**
 * §10 STEP 5 — ROUTER IN FRONT, MEGA-CALL BEHIND.
 *
 *   "`none`-routed messages skip the analyzer; everything else hits the
 *    existing prompt unchanged. Captures the 44x banter saving with no
 *    change to how decisions are made."
 *
 * This module is a GATE, not a pipeline. It decides ONE thing: which
 * messages the unchanged 18,315-token analyzer sees. It does not
 * extract, does not decide, does not compose, and never writes. Steps 6
 * and 7 are what replace the analyzer; this step only stops paying it to
 * conclude that a laughing emoji is a laughing emoji.
 *
 * 69.3% of real traffic is `noise`, measured over 1,723 production
 * messages (PR #35). An 8-message banter batch costs $0.0389 and
 * 14-19 s today (§8.2); through the router it was measured at $0.00137
 * and 1.1 s (PR #37).
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE ONLY WAY THIS GOES WRONG IS A REAL `IN` ROUTED `none`.
 * ─────────────────────────────────────────────────────────────────────
 *
 * §11.1 calls that the biggest risk in the whole redesign and a genuine
 * regression: today a misread message still gets a verdict and 54
 * seatbelts look at it; here it disappears. Every trade-off below is
 * made against that, not against cost. Missing a saving costs pennies.
 * Missing a player's IN costs them their place.
 *
 * Four containments, all shipping with this step:
 *
 *   1. BIAS TOWARD ACTION — in the router prompt, in the router parser
 *      (a missing id becomes `unsure`, never `none`), and again here
 *      (`partition` skips ONLY an explicit `none`; an id the router
 *      never mentioned is analysed).
 *   2. THE FLOOR — `floorForcesAnalysis`, behind its own flag, default
 *      OFF. See the essay below.
 *   3. FAIL OPEN — a router error routes the whole batch to the
 *      analyzer (`routeBatch` already does this), and `gateBatch`
 *      catches anything it did not.
 *   4. SHADOW THE `none` BUCKET FOREVER — `none-shadow.ts`.
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
 * degree:
 *
 *   a classifier decides WHAT a message means, and can be wrong in both
 *   directions. The floor decides only WHETHER the analyzer gets to
 *   look, and can be wrong in one. Its output feeds a set union, so its
 *   worst case is one extra $0.03 analyzer call on a batch that did not
 *   need it. It cannot suppress a write, cannot change a verdict, and
 *   cannot alter how a message is handled once analysed — the analyzer
 *   receives the identical message object either way and is told nothing
 *   about why it is in the batch.
 *
 * That is a seatbelt, and it is proven rather than asserted:
 * `__tests__/gate.test.ts` fuzzes arbitrary routes against real message
 * bodies and shows `analysed(floor on) ⊇ analysed(floor off)`, that
 * `routeFloor` can never return `none` (the property the whole thing
 * rests on), and that the analysed list is the same objects in the same
 * order with or without it.
 *
 * It still ships DEFAULT OFF, separately from the gate, for two
 * reasons: §11.1 says reintroducing a floor at all "is a product
 * decision that needs his sign-off", and the router's true recall can
 * only be measured with the floor out of the way.
 */
import { readFileSync } from "node:fs";
// TYPE-ONLY, and it has to stay that way: `message-analyzer.ts` pulls in
// the Prisma client, and a runtime import here would make this module
// unloadable in the Playwright worker where the recall harness runs it.
import type { AnalysisVerdict } from "../message-analyzer";
import type { AwaitingQuestion } from "./awaiting-answer";
import { anthropicModel, degradation, type PipelineModel } from "./llm";
import { routeBatch, routeFloor, type RouterMessage } from "./router";
import type { Degradation, Route, RoutedMessage } from "./types";

// ── Flags ─────────────────────────────────────────────────────────────

/** THE revert. Unset or `0` and the analyze route behaves exactly as it
 *  did on `2d52d7a`: every message reaches the existing prompt. */
export const GATE_FLAG = "ROUTER_GATE_ENABLED";
/** The floor, separately signed off (§11.1). Meaningless with the gate
 *  off — there is nothing to rescue when nothing is skipped. */
export const FLOOR_FLAG = "ROUTER_GATE_FLOOR_ENABLED";
/** The nightly `none`-bucket sweep (§11.1's fourth containment). */
export const SHADOW_FLAG = "NONE_BUCKET_SHADOW_ENABLED";
/**
 * §10 STEP 6 — THE REVERT.
 *
 *   "Swap the attendance path to extractor + engine. `self_att`,
 *    `other_att`, `offer` only … Everything else still runs the old
 *    prompt."  revert: "flag flips the three routes back".
 *
 * Unset it (or set it to `0`) and every attendance message goes back to
 * the 18,315-token prompt and `executeVerdict`, exactly as on `b03d96b`.
 * It is SEPARATE from `GATE_FLAG` on purpose and in BOTH directions: a
 * revert of step 6 must not also revert step 5, and turning step 5 on
 * must not turn the write path over.
 */
export const ENGINE_FLAG = "ATTENDANCE_ENGINE_ENABLED";

/**
 * The three routes the engine owns, and no others.
 *
 * `unsure` is deliberately ABSENT even though it shares the attendance
 * extractor in the dry run. §11.1's asymmetry runs the other way once a
 * write is real: inside the dry run a doubtful message costs one
 * extractor call and proposes nothing, but on the WRITE path it would
 * decide a squad place from a route the router itself could not settle.
 * §13's conservative default — "a missed add is recoverable in one
 * message; a wrong registration on a paid match is not" — makes doubt
 * cost an analyzer call, which is today's behaviour and therefore
 * cannot be a regression.
 */
export const ENGINE_ROUTES: readonly Route[] = ["self_att", "other_att", "offer"];

type Env = Record<string, string | undefined>;

/** Deliberately strict: only these five spellings turn something on, so
 *  a typo in a Vercel env var can never enable a step-5 behaviour by
 *  accident. Same shape as `isShadowAnalysisEnabled`. */
function on(env: Env, key: string): boolean {
  const raw = env[key]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function isRouterGateEnabled(env: Env = process.env): boolean {
  // The test seam wins, and ONLY when MT_TEST_ROUTER_STUB_FILE is set —
  // an env var nothing but `buildTestEnv()` ever sets. Without it, not
  // one byte of the stub file is read. This exists because the dev
  // server's environment is fixed at boot, so a stubbed e2e spec has no
  // other way to run one request with the gate on and the next with it
  // off. Same shape and same blast radius as MT_TEST_LLM_STUB_FILE,
  // which replaces the entire model.
  const stub = routerStubConfig(env);
  if (stub && typeof stub.enabled === "boolean") return stub.enabled;
  return on(env, GATE_FLAG);
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
 * §10 step 6. Default OFF, same five spellings, same test seam.
 *
 * Read through a predicate rather than `process.env.X` in the route so
 * a unit test can prove the default without mutating the process, and
 * so there is exactly ONE place that decides whether the write path has
 * moved.
 */
export function isAttendanceEngineEnabled(env: Env = process.env): boolean {
  const stub = routerStubConfig(env);
  if (stub && typeof stub.engine === "boolean") return stub.engine;
  return on(env, ENGINE_FLAG);
}

/**
 * TEST-ONLY per-request override, for the ONE thing the stub-file seam
 * cannot do: an A/B on a LIVE run.
 *
 * The corpus and the replay harness both need "the same real model, the
 * same real world, the flag on for one arm and off for the other, in
 * one process". The stub file cannot serve that — a live run pins
 * `MT_TEST_ROUTER_STUB_FILE` empty on purpose, because a live sweep
 * that could read canned routes out of a file would not be measuring
 * anything. And the dev server's environment is fixed at boot, so the
 * env var cannot differ between two requests either.
 *
 * So the header. It is DOUBLE-gated and both gates matter:
 *
 *   1. `MT_TEST_MODE` must be exactly "1". Nothing sets that but
 *      `e2e/helpers/env.ts:buildTestEnv()`; it is not in `.env.example`,
 *      not in Vercel, and not on the Pi.
 *   2. Absent or unrecognised → `null`, and the caller falls back to the
 *      env flag. There is no value of this header that can turn the
 *      engine on in a process that has not declared itself a test.
 *
 * It can only ever choose between two shipped code paths. It cannot
 * inject a route, a fact, a verdict or a write.
 */
export const ENGINE_HEADER = "x-mt-attendance-engine";

export function engineHeaderOverride(
  header: string | null | undefined,
  env: Env = process.env,
): boolean | null {
  if (env.MT_TEST_MODE !== "1") return null;
  const raw = header?.trim().toLowerCase();
  if (raw === undefined || raw === "") return null;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return null;
}

/** Does the engine decide this route? A route it has never heard of —
 *  including `undefined`, which is what a message the router never
 *  mentioned looks like — is never owned. */
export function engineOwnsRoute(route: Route | undefined): boolean {
  return route !== undefined && ENGINE_ROUTES.includes(route);
}

/**
 * Must the router run at all?
 *
 * Step 5 needed routes to decide what the analyzer SEES; step 6 needs
 * the same routes to decide what the analyzer DECIDES. Either flag on
 * means the router call happens — otherwise turning step 6 on without
 * step 5 would silently own nothing, which is the worst kind of flag:
 * one that looks enabled and does nothing.
 */
export function routerIsNeeded(
  env: Env = process.env,
  /**
   * The step-6 flag AS THE CALLER RESOLVED IT. The analyze route may
   * have a per-request override (`engineHeaderOverride`) that the
   * environment knows nothing about, and a predicate that re-read the
   * env here would disagree with the caller about whether the engine is
   * on — which would mean running the engine with no routes, the worst
   * kind of flag: one that looks enabled and does nothing.
   */
  engineEnabled: boolean = isAttendanceEngineEnabled(env),
): boolean {
  return isRouterGateEnabled(env) || engineEnabled;
}

// ── The floor, as a boolean ───────────────────────────────────────────

/**
 * Does the deterministic floor insist this message reaches the analyzer?
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
  /** Ids handed to the unchanged analyzer, in input order. */
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

/** Every gated row's `reasoning` starts with this. The `none`-bucket
 *  shadow and the reach guard both key off it. */
export const GATED_REASON_PREFIX = "router-gate:";

/**
 * The verdict a skipped message gets in place of the analyzer's.
 *
 * `intent: "noise"` and every action field null — byte-for-byte what
 * the mega-call emits for the 69.3% of traffic that is banter, so every
 * downstream guard, audit pass and reconciliation sees exactly the
 * shape it saw yesterday. Deliberately NOT `offlineVerdict`: that one
 * means "we tried and failed" and fires the partial-response admin DM.
 * This one means "we decided not to ask".
 */
export function gatedVerdict(waMessageId: string, route: Route | undefined): AnalysisVerdict {
  return {
    waMessageId,
    intent: "noise",
    confidence: 1,
    react: null,
    reply: null,
    registerAttendance: null,
    benchConfirmation: null,
    scoreRed: null,
    scoreYellow: null,
    includeNames: null,
    teamOverrides: null,
    teamNames: null,
    bulkPayment: null,
    reminder: null,
    registerFor: null,
    recruitRequest: false,
    reasoning: `${GATED_REASON_PREFIX} routed ${route ?? "none"}; the analyzer was not asked (§10 step 5)`,
  };
}

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
   * Playwright worker and in the plain `tsx` recall script (the same
   * reason `message-analyzer` is imported type-only above).
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
 * Every failure mode lands on "analyse everything", which is exactly
 * today's behaviour and therefore cannot be a regression. `routeBatch`
 * already handles a failed call that way; this catches anything above
 * it — a model constructor that throws for a missing key, an OOM, a bug
 * in this file.
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
        `the router gate failed (${(err as Error).message}); the whole batch goes to the analyzer`,
      ),
    ]);
  }
}

/** The stub seam is checked BEFORE the real model is constructed, so a
 *  stubbed e2e run never needs a key. A missing key in production
 *  surfaces as a throw inside `gateBatch`'s try, where it degrades to
 *  "analyse everything" — today's behaviour. */
function defaultGateModel(): PipelineModel {
  return routerStubFromEnv() ?? anthropicModel();
}

/**
 * TEST-ONLY seam, mirroring `MT_TEST_LLM_STUB_FILE` in
 * `message-analyzer.ts`. When `MT_TEST_ROUTER_STUB_FILE` is set, the
 * router's answer is read from a JSON file
 * (`{"routes": {"<waMessageId>": "none"}}`) instead of a model call, so
 * the stubbed e2e suite can exercise the gate deterministically and for
 * free. Unmapped ids fall back to `unsure` — the safe direction.
 *
 * Never set in production. `e2e/helpers/live-llm.ts` refuses a "live"
 * run that can still see it, the same way it refuses one that can still
 * see the analyzer stub.
 */
export const ROUTER_STUB_FILE_ENV = "MT_TEST_ROUTER_STUB_FILE";

export interface RouterStubConfig {
  /** Overrides ROUTER_GATE_ENABLED for this request. */
  enabled?: boolean;
  /** Overrides ROUTER_GATE_FLOOR_ENABLED for this request. */
  floor?: boolean;
  /** Overrides ATTENDANCE_ENGINE_ENABLED for this request (§10 step 6).
   *  Same seam, same blast radius: only ever read when
   *  MT_TEST_ROUTER_STUB_FILE is set, which nothing outside the e2e
   *  harness sets. */
  engine?: boolean;
  /** waMessageId → route. Unmapped ids fall back to `unsure`. */
  routes?: Record<string, string>;
  /** Trimmed message body → route, for specs that cannot know the ids
   *  the sim harness mints. `routes` wins where both match. */
  bodies?: Record<string, string>;
}

/** Read fresh on every call, like the analyzer's stub, so a spec can
 *  rewrite it between requests. Returns null unless the env var is set —
 *  which is the only thing standing between this and production. */
function routerStubConfig(env: Env = process.env): RouterStubConfig | null {
  const file = env[ROUTER_STUB_FILE_ENV];
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RouterStubConfig;
  } catch {
    // Missing or garbled → behave as if there were no stub at all. The
    // gate then falls back to the env flags (off by default) and every
    // message is analysed, which is the direction that cannot lose a
    // write.
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
