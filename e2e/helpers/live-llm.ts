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
 * when the orchestrator has no key, `getAnthropic()` returns null, and
 * every message gets `offlineVerdict(…, "ANTHROPIC_API_KEY not set")`.
 * Nothing errored. The same failure shape as the pre-#34 port collision
 * and for the same reason: a measurement that silently did not happen
 * still renders as a number, and a number renders as confidence.
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
 * path from its overlay, but the child is spawned with
 * `{ ...process.env, ...overlay }`, so an `MT_TEST_LLM_STUB_FILE`
 * already in the orchestrator's own environment survived into the dev
 * server and the "live" sweep was stubbed end to end. The overlay now
 * pins it to `""` (falsy — the analyzer's check is a plain truthiness
 * test) and this module asserts the result.
 */
import { E2EPreflightError } from "./preflight";

export const LIVE_ENV_FLAG = "MT_SIM_LIVE_LLM";
export const STUB_FILE_ENV = "MT_TEST_LLM_STUB_FILE";
export const KEY_ENV = "ANTHROPIC_API_KEY";

/**
 * The model `analyzeBatch` actually calls. Probing anything else would
 * prove the wrong thing — a key can be entitled to one model and not
 * another — so `live-llm.test.ts` reads `const MODEL` out of
 * `src/lib/message-analyzer.ts` and fails if these drift apart.
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
          `  Every message would fall through to offlineVerdict("${KEY_ENV} not set"), the ` +
          `sweep would score whatever an all-silent analyzer scores, and it would PASS. ` +
          `That is a fabricated measurement, not a result.\n` +
          `  Fix:  set -a; source .env; set +a   (the key lives in the repo-root .env)\n` +
          `  A fresh worktree has no .env of its own — copy one in, or export ${KEY_ENV} ` +
          `for this run.`,
      );
    }
    if (!blank(childEnv[STUB_FILE_ENV])) {
      throw new E2EPreflightError(
        `e2e: REFUSING to run — ${LIVE_ENV_FLAG}=1 asks for a LIVE model run, but the ` +
          `server under test would still see ${STUB_FILE_ENV}=${childEnv[STUB_FILE_ENV]}.\n` +
          `  analyzeBatch short-circuits to the stub file before it ever builds a prompt, so ` +
          `the "live" sweep would be stubbed end to end and would report the stub's numbers ` +
          `as the model's.\n` +
          `  Fix:  unset ${STUB_FILE_ENV} in your shell — the suite sets it itself for ` +
          `stubbed runs and pins it empty for live ones.`,
      );
    }
    return;
  }

  if (blank(childEnv[STUB_FILE_ENV])) {
    throw new E2EPreflightError(
      `e2e: REFUSING to run — this is a STUBBED run (${LIVE_ENV_FLAG} is not 1) but the ` +
        `server under test would have no ${STUB_FILE_ENV}, so analyzeBatch would try the ` +
        `real model.\n` +
        `  Fix:  run the suite via \`npm run test:e2e\`; do not clear ${STUB_FILE_ENV}.`,
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

/** The whole live pre-flight: seam, then a real token. Returns the probe
 *  so the caller can print it — a live run should say, on its own first
 *  lines, that it really is live. */
export async function assertLiveLlmReady(opts: {
  childEnv: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}): Promise<ProbeResult> {
  assertSeamMatchesMode("live", opts.childEnv);
  return probeAnthropic({
    key: opts.childEnv[KEY_ENV]!.trim(),
    ...(opts.childEnv.ANTHROPIC_BASE_URL ? { baseUrl: opts.childEnv.ANTHROPIC_BASE_URL } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}

export function describeProbe(p: ProbeResult): string {
  return (
    `[e2e] LLM: LIVE — probe OK. ${p.model} answered in ${p.ms}ms and billed ` +
    `${p.inputTokens} in / ${p.outputTokens} out tokens to key ${p.fingerprint}` +
    (p.baseUrl === DEFAULT_BASE_URL ? "." : ` via ${p.baseUrl}.`)
  );
}

// ─── (4): the sweep really did ask the model ─────────────────────────

/**
 * How a single analyzed message got its verdict, read back off
 * `AnalyzedMessage.reasoning` — the one place the server already
 * records it, so none of this needs a change under `src/`.
 */
export type ReachClass = "model" | "offline" | "offline-fatal" | "stub" | "fast-path";

/** Offline fallbacks that are CONFIGURATION or INFRASTRUCTURE faults.
 *  None of these is ever tolerable in a run being reported as live. */
export const OFFLINE_FATAL_PREFIXES = [
  "ANTHROPIC_API_KEY not set",
  "Claude API error:",
  "Unknown group",
] as const;

/** Offline fallbacks that are real, occasional MODEL behaviour. The
 *  analyze route already DMs an admin about these in production. */
export const OFFLINE_TOLERATED_PREFIXES = [
  "Claude emitted no verdict for this id",
  "No text in Claude response",
] as const;

/** The stub seam's own fingerprints. Seeing either in a live sweep means
 *  the sweep was not live. */
export const STUB_PREFIXES = ["test-stub:", "sim default:"] as const;

export function classifyReasoning(
  reasoning: string | null | undefined,
  handledBy: string | null | undefined,
): ReachClass {
  const r = (reasoning ?? "").trim();
  if (STUB_PREFIXES.some((p) => r.startsWith(p))) return "stub";
  if (OFFLINE_FATAL_PREFIXES.some((p) => r.startsWith(p))) return "offline-fatal";
  if (OFFLINE_TOLERATED_PREFIXES.some((p) => r.startsWith(p))) return "offline";
  if (handledBy === "fast-path") return "fast-path";
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
    else s.fastPath += 1;
    if (cls !== "model" && cls !== "fast-path") {
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
    `\n  Analyzed messages: ${s.total} (${s.model} reached the model, ${s.offline} dropped, ` +
    `${s.offlineFatal} fell back offline, ${s.stub} came from the stub seam, ${s.fastPath} ` +
    `never needed the model).` +
    (breakdown ? `\n  Why they missed:\n${breakdown}` : "");

  if (s.attributable === 0) {
    return (
      `LIVE SWEEP DID NOT HAPPEN — no message reached the analyzer at all, so there is ` +
      `nothing to report and certainly nothing to pass.${tail}`
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
    (s.offline ? `, ${s.offline} dropped verdict(s)` : "") +
    (s.fastPath ? `, ${s.fastPath} answered by a deterministic fast path` : "") +
    `.`
  );
}

/** Minimal shape of `e2e/helpers/test-db.ts`'s TestDb, so this module
 *  stays free of `pg` and can be unit-tested without a database. */
export interface ReachDb {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * A watermark to read reach FROM, taken from the DATABASE's clock so no
 * clock skew can shift it. Call it before the sweep starts: not every
 * live spec truncates first (the replay sweep does not), and rows left
 * behind by an earlier STUBBED run would otherwise be counted as this
 * run's stubbed verdicts and fail it for the wrong reason.
 */
export async function reachWatermark(db: ReachDb): Promise<string> {
  const rows = await db.all<{ now: string }>(`SELECT now()::text AS now`);
  return rows[0]?.now ?? new Date(0).toISOString();
}

export async function readReach(db: ReachDb, since?: string): Promise<ReachSummary> {
  const rows = since
    ? await db.all<ReachRow>(
        `SELECT reasoning, "handledBy" FROM "AnalyzedMessage" WHERE "createdAt" >= $1::timestamptz`,
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
  opts: { maxOfflineRate?: number; since?: string } = {},
): Promise<ReachSummary> {
  const summary = await readReach(db, opts.since);
  const failure = liveReachFailure(summary, opts);
  if (failure) throw new Error(failure);
  return summary;
}
