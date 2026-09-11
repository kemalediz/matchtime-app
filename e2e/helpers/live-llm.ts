/**
 * The gate a LIVE-model run passes through before it spends a penny,
 * and the proof, afterwards, that it actually did.
 *
 * ── the defect ──────────────────────────────────────────────────────
 * On 034f694, in a checkout with no `.env`:
 *
 *     $ npm run test:corpus:live
 *     ✓ 1 …corpus-live.spec.ts › replays the whole corpus ×3  (4.0s)
 *     1 passed (7.3s)
 *
 * Four seconds. 8 of 47 cases "passed". Exit 0. Not one of the 141 runs
 * reached Anthropic: `buildTestEnv()` forwards `ANTHROPIC_API_KEY: ""`
 * when the orchestrator has no key, `getAnthropic()` returned null, and
 * every message got `offlineVerdict(…, "ANTHROPIC_API_KEY not set")`.
 * Nothing errored. The same failure shape as the pre-#34 port collision
 * and for the same reason: a measurement that silently did not happen
 * still renders as a number, and a number renders as confidence.
 *
 * ── WHAT §10 STEP 8 CHANGED HERE (2026-09-06) ────────────────────────
 * `offlineVerdict` and `analyzeBatch` are deleted, so the exact string
 * this file was written to hunt for can no longer be written. THE
 * FAILURE CLASS DID NOT GO WITH THEM — it changed shape, and in a
 * direction that is harder to see, not easier:
 *
 *   BEFORE  no key → every message gets a verdict saying "no key", and
 *           the sweep scores whatever an all-silent analyzer scores.
 *   NOW     no key, or every route flag off, or a router that returned
 *           nothing → every message reaches the end of the batch with
 *           NO OWNER, `route.ts` records `reasoning: "no owner: route=…"`
 *           and says nothing to the group. The sweep scores whatever a
 *           silent bot scores. There is no second decider left to make
 *           the misconfiguration visible.
 *
 * So the classifier below gained an `unowned` class and a rule that
 * fails a live sweep in which more messages were decided by nobody than
 * reached a model, and the probe stopped asking one model whether it
 * works and started asking the three the pipeline actually calls. Both
 * are documented at their definitions.
 *
 * It is worse than the port collision, because every live figure quoted
 * from a sweep — the corpus baselines, the replay noise floor, the
 * step-0 hit-rates — is only worth what the model actually saw.
 *
 * ── the rule ────────────────────────────────────────────────────────
 * A run that cannot reach the model FAILS. Not silently degrades, not
 * "passes with an asterisk". Following `preflight.ts`: refuse BEFORE
 * doing any work, say exactly what is wrong, name the fix, fail closed.
 *
 * Four holes, all of them the same family:
 *
 *   1. no `ANTHROPIC_API_KEY`                → `assertSeamMatchesMode`
 *   2. a key that the API rejects (401/403)  → `probeAnthropic`
 *   3. `MT_SIM_LIVE_LLM=1` but the stub seam still reaching the child
 *      (or a "stubbed" run carrying a real key, which quietly spends
 *      money)                                → `assertSeamMatchesMode`
 *   4. a sweep that ran but where the model was never actually asked
 *                                            → `assertLiveSweepReachedModel`
 *
 * (3) is not hypothetical. `buildTestEnv()` used to `delete` the stub
 * flag from its overlay, but the child is spawned with
 * `{ ...process.env, ...overlay }`, so a stub flag already in the
 * orchestrator's own environment survived into the dev server and the
 * "live" sweep was stubbed end to end. The overlay now pins each of the
 * three to `""` (falsy — every reader's check is a plain truthiness
 * test) and this module asserts the result.
 */
import { E2EPreflightError } from "./preflight";

export const LIVE_ENV_FLAG = "MT_SIM_LIVE_LLM";
export const DM_QA_STUB_ENV = "MT_TEST_DM_QA_STUB";
/** §10 step 5's router seam. Mirrors `ROUTER_STUB_FILE_ENV` in
 *  `src/lib/pipeline/gate.ts`. */
export const ROUTER_STUB_FILE_ENV = "MT_TEST_ROUTER_STUB_FILE";
/** §10 step 6's extractor seam. Mirrors `EXTRACTOR_STUB_FILE_ENV` in
 *  `src/lib/pipeline/extractor-stub.ts`. */
export const EXTRACTOR_STUB_FILE_ENV = "MT_TEST_EXTRACTOR_STUB_FILE";
/** The DM surface's only classifier (2026-09-11). Mirrors
 *  `DM_INTENT_STUB_FILE_ENV` in `src/lib/dm-intent.ts`. */
export const DM_INTENT_STUB_FILE_ENV = "MT_TEST_DM_INTENT_STUB_FILE";
export const KEY_ENV = "ANTHROPIC_API_KEY";

/**
 * EVERY model a live sweep can bill, and the reason this is a list.
 *
 * It was a single string — `claude-sonnet-4-5`, the model `analyzeBatch`
 * called — and probing one model is only sound while one model exists.
 * §10 step 8 deleted `analyzeBatch` and left the pipeline, which calls
 * THREE, on two different families:
 *
 *   claude-haiku-4-5   the router          (`pipeline/llm.ts:54`)
 *   claude-sonnet-5    every extractor     (`pipeline/llm.ts:55`)
 *   claude-sonnet-4-5  the scheduled-chase composer
 *                      (`message-analyzer.ts`'s surviving `MODEL`)
 *
 * A key entitled to `sonnet-4-5` and not to `sonnet-5` would have sailed
 * through the old single probe and then failed EVERY extractor call —
 * which lands as `attendance-engine: degraded —` on each message and, per
 * `route.ts`'s catch-all, as silence. That is precisely the "runs, looks
 * plausible, measured nothing" shape this whole file exists to refuse,
 * reintroduced by a deletion that had nothing to do with it. Probing all
 * three costs three tokens.
 *
 * `live-llm.test.ts` reads the model constants out of
 * `src/lib/pipeline/llm.ts` and `src/lib/message-analyzer.ts` and fails
 * if this list drifts from them.
 */
export const PROBE_MODELS: readonly string[] = [
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "claude-sonnet-4-5",
];

/**
 * The single model `probeAnthropic` uses when the caller names none.
 *
 * Kept as a named export, and kept pointing at the CHASE composer's
 * model, because that is the one `message-analyzer.ts` still declares
 * and the drift test still reads from there. Callers that care about
 * the whole surface use `PROBE_MODELS`.
 */
export const PROBE_MODEL = "claude-sonnet-4-5";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

/** Share of analyzed messages allowed to have missed the model before a
 *  live sweep is declared not-live. Dropped verdicts are real model
 *  behaviour (see the partial-response net in the analyze route), so the
 *  tolerance is not zero — but it is small, and NO share of a
 *  configuration fault is tolerated at all. */
export const DEFAULT_MAX_OFFLINE_RATE = 0.05;

export function isLiveRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LIVE_ENV_FLAG] === "1";
}

function blank(v: string | undefined): boolean {
  return (v ?? "").trim() === "";
}

/** Enough to tell two keys apart in a log, not enough to use one. */
export function keyFingerprint(key: string): string {
  const t = key.trim();
  return t.length <= 8 ? `…(${t.length} chars)` : `…${t.slice(-4)}`;
}

// ─── (1) + (3): the seam matches the mode ────────────────────────────

/**
 * Cross-check the flag against the environment the SERVER UNDER TEST
 * will actually get — not against the overlay we intended to send, and
 * not against the orchestrator's own env. Both directions are faults:
 *
 *   live + stub seam  → a "live" sweep that is silently stubbed. Every
 *                       number it prints is a stub's number.
 *   stub + real key   → a "stubbed" run that silently bills real money,
 *                       and whose determinism was never determinism.
 */
export function assertSeamMatchesMode(
  mode: "live" | "stub",
  childEnv: Record<string, string | undefined>,
): void {
  if (mode === "live") {
    if (blank(childEnv[KEY_ENV])) {
      throw new E2EPreflightError(
        `e2e: REFUSING to run — ${LIVE_ENV_FLAG}=1 asks for a LIVE model run, but ` +
          `${KEY_ENV} is empty.\n` +
          `  Every router and extractor call would throw "${KEY_ENV} not set" ` +
          `(pipeline/llm.ts:138), every message would reach the end of the batch with no ` +
          `owner, the bot would say nothing, and the sweep would score whatever a silent ` +
          `bot scores — and PASS. That is a fabricated measurement, not a result.\n` +
          `  Fix:  set -a; source .env; set +a   (the key lives in the repo-root .env)\n` +
          `  A fresh worktree has no .env of its own — copy one in, or export ${KEY_ENV} ` +
          `for this run.`,
      );
    }
    if (!blank(childEnv[DM_QA_STUB_ENV])) {
      throw new E2EPreflightError(
        `e2e: REFUSING to run — ${LIVE_ENV_FLAG}=1 asks for a LIVE model run, but the ` +
          `server under test would still see ${DM_QA_STUB_ENV}=${childEnv[DM_QA_STUB_ENV]}.\n` +
          `  This is dm-qa.ts's stub flag (it was called MT_TEST_LLM_STUB_FILE while it ` +
          `also pointed at analyzeBatch's verdict file; §10 step 8 deleted that reader). ` +
          `With it set, every scoped DM answer would be the SCOPED CONTEXT echoed back ` +
          `rather than a model's answer, reported as the model's.\n` +
          `  Fix:  unset ${DM_QA_STUB_ENV} in your shell — the suite sets it itself for ` +
          `stubbed runs and pins it empty for live ones.`,
      );
    }
    if (!blank(childEnv[ROUTER_STUB_FILE_ENV])) {
      throw new E2EPreflightError(
        `e2e: REFUSING to run — ${LIVE_ENV_FLAG}=1 asks for a LIVE model run, but the ` +
          `server under test would still see ${ROUTER_STUB_FILE_ENV}=${childEnv[ROUTER_STUB_FILE_ENV]}.\n` +
          `  That file both answers for the router AND overrides the §10 step 5 flags, so a ` +
          `"live" sweep could be gated by a canned route the model never produced — and the ` +
          `router's recall, the number the whole step turns on, would be the stub's.\n` +
          `  Fix:  unset ${ROUTER_STUB_FILE_ENV} in your shell — the suite sets it itself for ` +
          `stubbed runs and pins it empty for live ones.`,
      );
    }
    if (!blank(childEnv[EXTRACTOR_STUB_FILE_ENV])) {
      throw new E2EPreflightError(
        `e2e: REFUSING to run — ${LIVE_ENV_FLAG}=1 asks for a LIVE model run, but the ` +
          `server under test would still see ${EXTRACTOR_STUB_FILE_ENV}=${childEnv[EXTRACTOR_STUB_FILE_ENV]}.\n` +
          `  That file answers for the §10 step 6 attendance extractor, so a "live" sweep ` +
          `could be deciding a real player's squad place from FACTS a human wrote — which is ` +
          `grading your own answer key, the trap e2e/corpus/README.md names under "Do not ` +
          `'record' stubs from a live run".\n` +
          `  Fix:  unset ${EXTRACTOR_STUB_FILE_ENV} in your shell — the suite sets it itself ` +
          `for stubbed runs and pins it empty for live ones.`,
      );
    }
    if (!blank(childEnv[DM_INTENT_STUB_FILE_ENV])) {
      throw new E2EPreflightError(
        `e2e: REFUSING to run — ${LIVE_ENV_FLAG}=1 asks for a LIVE model run, but the ` +
          `server under test would still see ${DM_INTENT_STUB_FILE_ENV}=${childEnv[DM_INTENT_STUB_FILE_ENV]}.\n` +
          `  That file answers for lib/dm-intent.ts, the 1:1 DM surface's only classifier ` +
          `since 2026-09-11 and the single gate in front of a 13-27 person mass DM. A ` +
          `"live" sweep reading a canned intent out of it would be grading its own answer ` +
          `key in the one place this product cannot afford it.\n` +
          `  Fix:  unset ${DM_INTENT_STUB_FILE_ENV} in your shell — the suite sets it itself ` +
          `for stubbed runs and pins it empty for live ones.`,
      );
    }
    return;
  }

  if (blank(childEnv[DM_QA_STUB_ENV])) {
    throw new E2EPreflightError(
      `e2e: REFUSING to run — this is a STUBBED run (${LIVE_ENV_FLAG} is not 1) but the ` +
        `server under test would have no ${DM_QA_STUB_ENV}, so dm-qa.ts would try the real ` +
        `model and the DM-Q&A no-leak assertions would be grading a model's prose instead ` +
        `of the scoped context itself.\n` +
        `  Fix:  run the suite via \`npm run test:e2e\`; do not clear ${DM_QA_STUB_ENV}.`,
    );
  }
  if (!blank(childEnv[KEY_ENV])) {
    throw new E2EPreflightError(
      `e2e: REFUSING to run — this is a STUBBED run (${LIVE_ENV_FLAG} is not 1) but a real ` +
        `${KEY_ENV} (${keyFingerprint(childEnv[KEY_ENV]!)}) would reach the server under test.\n` +
        `  The suite pins the key empty precisely so a "deterministic" run can never bill ` +
        `anyone; something is overriding that.\n` +
        `  Fix:  unset ${KEY_ENV} for this run, or use \`npm run test:e2e\` unmodified.`,
    );
  }
}

// ─── (2): the key is not just present, it works ──────────────────────

export interface ProbeResult {
  model: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  fingerprint: string;
  baseUrl: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Spend one token deliberately, so the run can prove it is able to.
 *
 * A key that is merely *present* is the second-cheapest kind of false
 * confidence there is: a revoked key, a key for the wrong org, or a key
 * without access to `PROBE_MODEL` all produce the same silent
 * all-offline sweep as no key at all. The probe costs about $0.00005 and
 * converts every one of those into a refusal with a name on it.
 */
export async function probeAnthropic(opts: {
  key: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: FetchLike;
  /** Exposed so the unit tests do not sleep. */
  retryDelayMs?: number;
}): Promise<ProbeResult> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = opts.model ?? PROBE_MODEL;
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const fingerprint = keyFingerprint(opts.key);
  const url = `${baseUrl}/v1/messages`;
  const body = JSON.stringify({
    model,
    max_tokens: 1,
    messages: [{ role: "user", content: "." }],
  });

  const refuse = (detail: string, fix: string): never => {
    throw new E2EPreflightError(
      `e2e: REFUSING to run — ${LIVE_ENV_FLAG}=1 asks for a LIVE model run, and the ` +
        `pre-flight call to ${url} failed.\n` +
        `  ${detail}\n` +
        `  key: ${fingerprint}   model: ${model}\n` +
        `  Without this the sweep would still "run": every message falls through to an ` +
        `offline verdict and the scoreboard reports numbers no model produced.\n` +
        `  ${fix}`,
    );
  };

  let lastTransient = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": ANTHROPIC_VERSION,
          "x-api-key": opts.key,
        },
        body,
      });
    } catch (err) {
      lastTransient = `network error: ${(err as Error).message}`;
      if (attempt === 0) {
        await sleep(opts.retryDelayMs ?? 1_500);
        continue;
      }
      return refuse(
        lastTransient,
        `Check connectivity to ${baseUrl}. Failing closed on purpose: a sweep that cannot ` +
          `be shown to be live must not be reported as live.`,
      );
    }
    const ms = Date.now() - started;
    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      return refuse(
        `the API REJECTED the key (HTTP ${res.status}). ${firstLine(text)}`,
        `The key is present but not usable — expired, revoked, or for another org. ` +
          `Refresh it in the repo-root .env, then: set -a; source .env; set +a`,
      );
    }
    if (res.status === 404) {
      return refuse(
        `the API does not offer "${model}" to this key (HTTP 404). ${firstLine(text)}`,
        `The analyzer calls "${model}" (src/lib/message-analyzer.ts). A key without access ` +
          `to it produces a sweep of Claude-API-error verdicts, not a measurement.`,
      );
    }
    if (res.status === 429) {
      return refuse(
        `rate limited (HTTP 429). ${firstLine(text)}`,
        `Wait and re-run. A sweep started while rate-limited fails message-by-message into ` +
          `offline verdicts and scores them as if the model had answered.`,
      );
    }
    if (res.status >= 500 || res.status === 0) {
      lastTransient = `HTTP ${res.status}. ${firstLine(text)}`;
      if (attempt === 0) {
        await sleep(opts.retryDelayMs ?? 1_500);
        continue;
      }
      return refuse(lastTransient, `Upstream is unhealthy. Re-run when it recovers.`);
    }
    if (res.status !== 200) {
      return refuse(`unexpected HTTP ${res.status}. ${firstLine(text)}`, `Investigate before re-running.`);
    }

    let parsed: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return refuse(`the API returned HTTP 200 but not JSON.`, `Investigate before re-running.`);
    }
    if (!parsed.usage) {
      return refuse(
        `HTTP 200 with no \`usage\` block, so no tokens can be shown to have been billed.`,
        `The probe exists to prove spend is possible; a response that proves nothing is ` +
          `treated as a failure.`,
      );
    }
    return {
      model: parsed.model ?? model,
      inputTokens: parsed.usage.input_tokens ?? 0,
      outputTokens: parsed.usage.output_tokens ?? 0,
      ms,
      fingerprint,
      baseUrl,
    };
  }
  /* c8 ignore next */
  return refuse(lastTransient || "exhausted retries", "Re-run when the API is reachable.");
}

function firstLine(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 240 ? `${t.slice(0, 240)}…` : t;
}

/**
 * The whole live pre-flight: seam, then a real token on EVERY model the
 * sweep can bill. Returns one probe per model so the caller can print
 * them — a live run should say, on its own first lines, that it really
 * is live, and against what.
 *
 * Sequential rather than `Promise.all`, deliberately: the first refusal
 * is the one worth reading, and three concurrent failures produce three
 * stack-shaped messages where one named model is the answer.
 */
export async function assertLiveLlmReady(opts: {
  childEnv: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  /** Override for the harness's own tests. Defaults to `PROBE_MODELS`. */
  models?: readonly string[];
}): Promise<ProbeResult[]> {
  assertSeamMatchesMode("live", opts.childEnv);
  const results: ProbeResult[] = [];
  for (const model of opts.models ?? PROBE_MODELS) {
    results.push(
      await probeAnthropic({
        key: opts.childEnv[KEY_ENV]!.trim(),
        model,
        ...(opts.childEnv.ANTHROPIC_BASE_URL ? { baseUrl: opts.childEnv.ANTHROPIC_BASE_URL } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    );
  }
  return results;
}

export function describeProbe(p: ProbeResult | ProbeResult[]): string {
  const all = Array.isArray(p) ? p : [p];
  if (all.length === 0) return `[e2e] LLM: LIVE — no model was probed.`;
  const key = all[0].fingerprint;
  const via = all[0].baseUrl === DEFAULT_BASE_URL ? "" : ` via ${all[0].baseUrl}`;
  const each = all
    .map((r) => `${r.model} (${r.ms}ms, ${r.inputTokens} in / ${r.outputTokens} out)`)
    .join(", ");
  return `[e2e] LLM: LIVE — probe OK on ${all.length} model(s): ${each}; billed to key ${key}${via}.`;
}

// ─── (4): the sweep really did ask the model ─────────────────────────

/**
 * How a single analyzed message got its verdict, read back off
 * `AnalyzedMessage.reasoning` — the one place the server already
 * records it, so none of this needs a change under `src/`.
 */
export type ReachClass =
  | "model"
  | "offline"
  | "offline-fatal"
  | "stub"
  | "fast-path"
  | "gated"
  | "unowned";

/**
 * `AnalyzedMessage.handledBy` for a message the §10 step 5 router gate
 * decided not to send to the analyzer. Mirrors `GATED_HANDLED_BY` in
 * `src/lib/pipeline/gate.ts`; duplicated rather than imported because
 * that module reaches the Prisma client's type surface and this file
 * must stay loadable with nothing but `vitest`.
 */
export const GATED_HANDLED_BY = "router-gate";

/**
 * Offline fallbacks that are CONFIGURATION or INFRASTRUCTURE faults.
 * None of these is ever tolerable in a run being reported as live.
 *
 * Matched as SUBSTRINGS, not prefixes, and that changed with §10 step 8.
 * They used to be the whole of `offlineVerdict`'s reason, printed at the
 * front of `AnalyzedMessage.reasoning`. `offlineVerdict` is deleted; the
 * same underlying failures now arrive wrapped in an engine's degradation
 * line, e.g.
 *
 *   attendance-engine: degraded — <id>: ANTHROPIC_API_KEY not set
 *   team-ops-engine: degraded — state load failed (…)
 *
 * so a prefix test would silently stop matching every one of them. That
 * is the exact failure mode this file exists to prevent, arriving via a
 * refactor rather than via a missing key.
 */
export const OFFLINE_FATAL_SUBSTRINGS = [
  "ANTHROPIC_API_KEY not set",
  "Claude API error:",
  "Unknown group",
  "state load failed",
  "feature load failed",
  "the match lookup failed",
] as const;

/** Back-compat alias. Same list, and the name says "prefix" only because
 *  it used to be one; `classifyReasoning` matches it anywhere in the
 *  string. Kept exported because the corpus report reads it. */
export const OFFLINE_FATAL_PREFIXES = OFFLINE_FATAL_SUBSTRINGS;

/**
 * The five owners' degradation markers — `attendance-engine: degraded —`
 * and its four siblings, from `attendance-engine.ts`, `answer-batch.ts`,
 * `score-engine.ts`, `admin-ops-engine.ts` and `team-ops-engine.ts`.
 *
 * DUPLICATED HERE RATHER THAN IMPORTED, for the reason `GATED_HANDLED_BY`
 * below is: those modules reach the Prisma client's type surface and this
 * file must stay loadable with nothing but `vitest`. `live-llm.test.ts`
 * greps the constants out of `src/` and fails if the two drift.
 *
 * Classified as TOLERATED, not fatal, unless the detail also matches
 * `OFFLINE_FATAL_SUBSTRINGS`. A degraded extractor call is real model
 * behaviour under load — the first live sweep of §10 step 6 measured 27
 * `529 Overloaded` and 3 `500`s across 10 of 177 messages — and the SDK
 * already retries four times before one gets here. A configuration fault
 * wearing the same prefix is not, and is caught by the substring list.
 */
export const ENGINE_DEGRADED_PREFIXES = [
  "attendance-engine: degraded —",
  "answer-engine: degraded —",
  "score-engine: degraded —",
  "admin-ops-engine: degraded —",
  "team-ops-engine: degraded —",
] as const;

/**
 * Offline fallbacks that are real, occasional MODEL behaviour.
 *
 * ⚠️ THE FIRST TWO ARE UNREACHABLE SINCE §10 STEP 8 and are kept, not
 * deleted, deliberately. They were `offlineVerdict`'s two tolerated
 * reasons — "Claude emitted no verdict for this id" (the model skipped
 * an id in a batch) and "No text in Claude response". Both were
 * properties of asking ONE model for a JSON object keyed by message id;
 * the pipeline asks per-message with a strict `json_schema`, so a
 * response that omits a message is not expressible. If either string
 * ever appears in `AnalyzedMessage.reasoning` again it means somebody
 * has reintroduced a batch-keyed free-text response, and it should still
 * be counted — which is why the strings stay rather than the list being
 * emptied.
 */
export const OFFLINE_TOLERATED_PREFIXES = [
  "Claude emitted no verdict for this id",
  "No text in Claude response",
] as const;

/**
 * The verdict stub seam's own fingerprints.
 *
 * ⚠️ NEITHER CAN BE WRITTEN ANY MORE, and this is the one guard §10 step
 * 8 genuinely removed rather than moved. `test-stub:` came from
 * `stubbedVerdictsForTest` and `sim default:` from `e2e/sim/group.ts`'s
 * `inferVerdict`; both fed `AnalysisVerdict.reasoning`, which the route
 * wrote straight into `AnalyzedMessage.reasoning`. The successors —
 * `MT_TEST_ROUTER_STUB_FILE` and `pipeline/extractor-stub.ts` — return a
 * ROUTE and a FACTS OBJECT, and neither leaves a trace in the reasoning
 * string, so a stubbed live sweep can no longer be detected after the
 * fact from the database.
 *
 * WHAT CARRIES THAT GUARANTEE NOW, both of them stronger than a prefix
 * match on prose:
 *
 *   1. `assertSeamMatchesMode("live", …)` above refuses the run outright
 *      if the child env can see EITHER stub file. It runs before
 *      Postgres, before Playwright, before anything is spent.
 *   2. `e2e/replay/meter.ts` proxies every Anthropic call a live run
 *      makes and `run.ts:assertMeterSawTraffic` fails the run when the
 *      count is zero — a fact about HTTP traffic rather than a fact
 *      about a string somebody remembered to write.
 *
 * The constants stay so that a reintroduced verdict stub is still
 * classified rather than counted as model reach.
 */
export const STUB_PREFIXES = ["test-stub:", "sim default:"] as const;

/**
 * `AnalyzedMessage.reasoning`'s prefix for a message that reached the end
 * of the batch with no owner — `route.ts`'s "NOBODY OWNED IT" branch.
 *
 * THIS IS §10 STEP 8'S REPLACEMENT FOR THE ALL-OFFLINE SWEEP, and it is
 * why `unowned` exists as a class. With the mega-prompt deleted, a live
 * run with no key, with every route flag off, or with a router that
 * returned nothing does not produce error verdicts — it produces a
 * silent bot and a table full of these rows. Under the old classifier
 * they fell through to the default and were counted as `model`, so the
 * most likely misconfiguration in the new architecture would have been
 * reported as a 100%-model-reach sweep.
 */
export const UNOWNED_REASON_PREFIX = "no owner: route=";

/** The one route for which "no owner" is the DESIGNED answer: banter.
 *  69.3% of real traffic, and `composeOperatorNote` drops it too. */
const UNOWNED_NONE = `${UNOWNED_REASON_PREFIX}none`;

export function classifyReasoning(
  reasoning: string | null | undefined,
  handledBy: string | null | undefined,
): ReachClass {
  const r = (reasoning ?? "").trim();
  if (STUB_PREFIXES.some((p) => r.startsWith(p))) return "stub";
  if (OFFLINE_FATAL_SUBSTRINGS.some((p) => r.includes(p))) return "offline-fatal";
  if (OFFLINE_TOLERATED_PREFIXES.some((p) => r.startsWith(p))) return "offline";
  if (ENGINE_DEGRADED_PREFIXES.some((p) => r.startsWith(p))) return "offline";
  // `none` FIRST: a message the router called banter and nobody owned is
  // the system working, and it is indistinguishable from the failure
  // case on `handledBy` alone (the gate writes `router-gate` only when
  // ROUTER_GATE_ENABLED is on; with it off the same banter lands here as
  // `ignored`). The route is in the reasoning string, so the split is
  // made on the route rather than on a flag's position.
  if (r.startsWith(UNOWNED_NONE)) return "gated";
  if (r.startsWith(UNOWNED_REASON_PREFIX)) return "unowned";
  if (handledBy === "fast-path") return "fast-path";
  // AFTER the offline and stub checks, deliberately. The gate's
  // handledBy must never let a real offline verdict pass as something
  // benign — PR #38's guard is not weakened, only made able to see a
  // fourth, legitimate reason a message did not reach the model.
  if (handledBy === GATED_HANDLED_BY) return "gated";
  return "model";
}

export interface ReachRow {
  reasoning: string | null;
  handledBy: string | null;
}

export interface ReachSummary {
  /** Every AnalyzedMessage row the sweep wrote. */
  total: number;
  model: number;
  offline: number;
  offlineFatal: number;
  stub: number;
  fastPath: number;
  /** Messages the §10 step 5 router gate deliberately did not send, plus
   *  the `none`-routed ones nobody owned. Not a failure, and not
   *  evidence of liveness either — reported, and excluded from
   *  `attributable`. */
  gated: number;
  /**
   * Messages the router sent SOMEWHERE and no owner claimed: §10 step
   * 8's silence. A handful is normal (`rename` and `swap` are handed
   * back on purpose, and `team-ops-engine-batch.ts`'s header enumerates
   * the rest); a sweep made mostly of them is a misconfiguration
   * reporting itself as a result. Excluded from `attributable` — these
   * messages never reached an owner's extractor, so they are not a
   * model-reach question — and judged by its own rule in
   * `liveReachFailure`.
   */
  unowned: number;
  /** Denominator for the rate: rows that SHOULD have reached the model. */
  attributable: number;
  offlineRate: number;
  /** reason prefix → count, for the failure message. */
  byReason: Record<string, number>;
}

export function summariseReach(rows: ReachRow[]): ReachSummary {
  const s: ReachSummary = {
    total: rows.length,
    model: 0,
    offline: 0,
    offlineFatal: 0,
    stub: 0,
    fastPath: 0,
    gated: 0,
    unowned: 0,
    attributable: 0,
    offlineRate: 0,
    byReason: {},
  };
  for (const row of rows) {
    const cls = classifyReasoning(row.reasoning, row.handledBy);
    if (cls === "model") s.model += 1;
    else if (cls === "offline") s.offline += 1;
    else if (cls === "offline-fatal") s.offlineFatal += 1;
    else if (cls === "stub") s.stub += 1;
    else if (cls === "gated") s.gated += 1;
    else if (cls === "unowned") s.unowned += 1;
    else s.fastPath += 1;
    if (cls !== "model" && cls !== "fast-path" && cls !== "gated") {
      const key = truncateReason(row.reasoning ?? "(no reasoning)");
      s.byReason[key] = (s.byReason[key] ?? 0) + 1;
    }
  }
  s.attributable = s.model + s.offline + s.offlineFatal + s.stub;
  s.offlineRate = s.attributable === 0 ? 1 : (s.offline + s.offlineFatal + s.stub) / s.attributable;
  return s;
}

function truncateReason(r: string): string {
  const t = r.replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

/** Null when the sweep is trustworthy; otherwise the message to fail with. */
export function liveReachFailure(
  s: ReachSummary,
  opts: { maxOfflineRate?: number } = {},
): string | null {
  const max = opts.maxOfflineRate ?? DEFAULT_MAX_OFFLINE_RATE;
  const breakdown = Object.entries(s.byReason)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `      ${String(n).padStart(5)} × ${reason}`)
    .join("\n");
  const tail =
    `\n  Analyzed messages: ${s.total} (${s.model} reached the model, ${s.offline} degraded, ` +
    `${s.offlineFatal} fell back offline, ${s.stub} came from the stub seam, ${s.fastPath} ` +
    `never needed the model, ${s.gated} were gated or routed \`none\`, ${s.unowned} were ` +
    `routed somewhere and owned by nobody).` +
    (breakdown ? `\n  Why they missed:\n${breakdown}` : "");

  if (s.attributable === 0) {
    return (
      `LIVE SWEEP DID NOT HAPPEN — no message reached an owner at all, so there is ` +
      `nothing to report and certainly nothing to pass.${tail}`
    );
  }
  // §10 STEP 8's OWN FAILURE SHAPE. With the mega-prompt deleted, a live
  // run with an unusable key, with every route flag off, or with a
  // router that answered nothing does not produce error verdicts — it
  // produces silence. `unowned > model` says more messages were decided
  // by nobody than by a model, which no correctly-configured sweep
  // produces and every misconfigured one does. The threshold is a
  // comparison rather than a percentage on purpose: a real sweep's
  // legitimate hand-backs (`rename`, `swap`, an answer engine declining
  // a money question) are a handful against a majority that reached a
  // model, and no arbitrary number has to be chosen or defended.
  if (s.unowned > s.model) {
    return (
      `LIVE SWEEP DECIDED ALMOST NOTHING — ${s.unowned} message(s) were routed and then ` +
      `owned by nobody, against ${s.model} that reached a model. Since §10 step 8 there is ` +
      `no analyzer behind the owners, so this is a silent bot being scored as a result.\n` +
      `  The attendance path has no flag any more (ROUTER_GATE_ENABLED and ` +
      `ATTENDANCE_ENGINE_ENABLED were deleted with it), and step 7's four default ON, so ` +
      `this is NOT the usual "somebody forgot to export a flag" — check for a ` +
      `*_ENGINE_ENABLED=0 in the environment, a router that answered nothing, and the ` +
      `degradation lines below.${tail}`
    );
  }
  if (s.stub > 0) {
    return (
      `LIVE SWEEP WAS STUBBED — ${s.stub} verdict(s) came from the deterministic stub seam ` +
      `while ${LIVE_ENV_FLAG}=1. The numbers are the stub's, not the model's.${tail}`
    );
  }
  if (s.offlineFatal > 0) {
    return (
      `LIVE SWEEP IS NOT A MEASUREMENT — ${s.offlineFatal} verdict(s) fell back to the ` +
      `offline placeholder for a configuration or API reason. Every one of those messages ` +
      `was scored as if the model had answered and stayed silent.${tail}`
    );
  }
  if (s.offlineRate > max) {
    return (
      `LIVE SWEEP IS TOO THIN TO TRUST — ${(s.offlineRate * 100).toFixed(1)}% of messages ` +
      `never reached the model (tolerance ${(max * 100).toFixed(1)}%).${tail}`
    );
  }
  return null;
}

export function describeReach(s: ReachSummary): string {
  return (
    `[live] ${s.model} of ${s.attributable} analyzed messages reached the real model` +
    (s.offline ? `, ${s.offline} degraded call(s)` : "") +
    (s.fastPath ? `, ${s.fastPath} answered by a deterministic fast path` : "") +
    (s.gated ? `, ${s.gated} gated out or routed \`none\`` : "") +
    (s.unowned ? `, ${s.unowned} routed and owned by nobody` : "") +
    `.`
  );
}

/** Minimal shape of `e2e/helpers/test-db.ts`'s TestDb, so this module
 *  stays free of `pg` and can be unit-tested without a database. */
export interface ReachDb {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * A watermark to read reach FROM. Call it before the sweep starts: not
 * every live spec truncates first (the replay sweep does not), and rows
 * left behind by an earlier STUBBED run would otherwise be counted as
 * this run's stubbed verdicts and fail it for the wrong reason.
 *
 * IT IS THE TABLE'S OWN HIGH-WATER MARK, NOT A CLOCK, and that is not
 * fussiness. The first version of this asked Postgres for `now()`, and
 * the whole before/after S12 arm then reported "0 of 0 messages reached
 * the model" while the metering proxy was simultaneously reporting 100
 * real calls and $1.48 billed. Prisma maps `DateTime` to
 * `timestamp(3)` — WITHOUT time zone — and writes UTC into it, while
 * `now()` is a `timestamptz`. Comparing the two makes Postgres read the
 * naive column in the SESSION's zone, which in Europe/London in summer
 * is UTC+1, so every row of the run landed an hour "before" a watermark
 * taken an instant before it. Reading `max("createdAt")` off the same
 * column compares like with like: no clock, no zone, no conversion.
 *
 * `null` (an empty table) means "read everything".
 */
export async function reachWatermark(db: ReachDb): Promise<Date | null> {
  const rows = await db.all<{ high: Date | string | null }>(
    `SELECT max("createdAt") AS high FROM "AnalyzedMessage"`,
  );
  const high = rows[0]?.high ?? null;
  if (high === null) return null;
  return high instanceof Date ? high : new Date(high);
}

export async function readReach(db: ReachDb, since?: Date | null): Promise<ReachSummary> {
  const rows = since
    ? await db.all<ReachRow>(
        `SELECT reasoning, "handledBy" FROM "AnalyzedMessage" WHERE "createdAt" > $1`,
        [since],
      )
    : await db.all<ReachRow>(`SELECT reasoning, "handledBy" FROM "AnalyzedMessage"`);
  return summariseReach(rows);
}

/**
 * Call this at the END of any live sweep, before reporting a number.
 * Throws with the full breakdown when the sweep cannot be shown to have
 * been live.
 */
export async function assertLiveSweepReachedModel(
  db: ReachDb,
  opts: { maxOfflineRate?: number; since?: Date | null } = {},
): Promise<ReachSummary> {
  const summary = await readReach(db, opts.since);
  const failure = liveReachFailure(summary, opts);
  if (failure) throw new Error(failure);
  return summary;
}
