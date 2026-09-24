/**
 * WHAT THE MODEL SAID ABOUT A MESSAGE, KEPT ON ITS ROW (2026-09-24).
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────
 * On 2026-09-24 the attendance extractor returned `polarity: "bench"`
 * for Erdal's plain "in" and the engine, correctly given that fact,
 * benched him. We could not prove it. `AnalyzedMessage` stores what the
 * ENGINE decided (intent, action, reasoning) and never what the MODEL
 * returned, so "was it the extractor or the engine?" had no answer in
 * the database, and a live re-run is a different sample of a
 * non-deterministic model, not a replay.
 *
 * So every analysed message now carries `AnalyzedMessage.pipelineTrace`:
 * the router's route for it and each extractor's FACTS, with the model
 * that produced them and the stage's degradations. Enough to read "what
 * did the model say, and why did the engine do X" off one row.
 *
 * ─────────────────────────────────────────────────────────────────────
 * HOW IT IS COLLECTED
 * ─────────────────────────────────────────────────────────────────────
 * The same way `lib/analyze-batch-context.ts` stamps `batchId`, and for
 * the same reason: five batch runners extract, one gate routes, and
 * `recordAnalysis` is called from over a dozen places, so threading a
 * trace through all of them would be a large diff for a value that is
 * per-request by nature. An `AsyncLocalStorage` collector follows the
 * request through every await and is invisible to any other request.
 *
 *   the route      `withPipelineTrace(...)` around the request, and
 *                  `persistPipelineTraces(writer)` once at its end
 *   the gate       `traceRouting(gate)` right after `gateBatch`
 *   each runner    `extractForRouteTraced(owner, ...)` in place of
 *                  `extractForRoute(...)`
 *
 * Saving ONCE AT THE END, by `waMessageId`, rather than inside
 * `recordAnalysis`: some rows are created before their message is
 * extracted (a clause-peeled message is recorded, then its residual is
 * routed and extracted), and an end-of-request update catches every one
 * of those without knowing which path wrote the row.
 *
 * `extractors.ts` is deliberately NOT touched. The traced extractor
 * wraps the MODEL it is handed, so it sees each raw response and each
 * failed attempt, and returns `extractForRoute`'s result unchanged.
 * Outside a trace context (dry runs, harnesses, unit tests) it is
 * `extractForRoute` and nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE TWO RULES
 * ─────────────────────────────────────────────────────────────────────
 *   1. TRACING NEVER BREAKS ANALYSIS. Every recording step and the save
 *      are wrapped: a failure is logged with `[pipeline-trace]` and
 *      swallowed. The worst case is a row with no trace.
 *   2. BOUNDED, AND NO NEW PII. Strings are truncated, arrays capped,
 *      the whole trace held under `TRACE_LIMITS.total`, and anything
 *      shaped like a phone number is replaced with `[phone]`. The raw
 *      model text is kept ONLY when the output did not parse cleanly,
 *      because otherwise the parsed facts are the output.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { extractForRoute, extractorFor, type ExtractionResult, type ExtractorMessage } from "./extractors";
import { ROUTER_MODEL, type PipelineModel } from "./llm";
import type { Degradation, Route, RoutedMessage } from "./types";

export const TRACE_LIMITS = {
  /** Any one string: a personRef, a degradation, a stats `since`. */
  string: 300,
  /** The raw model text, kept only for an output that did not parse. */
  raw: 1_500,
  /** Any one array: claims, coveredRefs. A pasted roster is the case. */
  array: 12,
  /** Degradations kept per stage. */
  degradations: 6,
  /** Extractions kept per message (one owner each, normally exactly one). */
  extractions: 4,
  depth: 6,
  /** The whole trace, as JSON characters. A typical one is ~600. */
  total: 16_000,
} as const;

export const PIPELINE_TRACE_VERSION = 1;

export interface RouterTrace {
  route: string;
  /** `model` | `floor` | `awaiting` | `fallback`, from `RoutedMessage`. */
  source: string;
  /** The route the model gave that the floor or an awaiting rule replaced. */
  overrodeRoute?: string;
  /** Null when no model was asked (the floor settled the whole batch). */
  model: string | null;
  floor: boolean;
  /** This message's router degradations, then the batch-wide ones. */
  degradations: string[];
}

export interface ExtractionCall {
  ms?: number;
  stopReason?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  /** Only when the output did not parse cleanly. */
  raw?: string;
  /** The attempt threw (transport, truncation). */
  error?: string;
}

export interface ExtractionTrace {
  /** Which batch runner asked: attendance, answer, score, admin_ops, team_ops. */
  owner: string;
  route: string;
  /** `extractorFor(route)`: which specialist prompt was used. */
  extractor: string;
  /** The model the request named. */
  model: string | null;
  /** The client that served it: `anthropic`, or a test stub's name. */
  client: string;
  /** The extractor's FACTS exactly as it returned them, before any
   *  caller-side clamp or substitution. */
  facts: unknown;
  degradations: string[];
  /** One per attempt; the attendance routes retry once. */
  calls: ExtractionCall[];
}

export interface PipelineTrace {
  v: typeof PIPELINE_TRACE_VERSION;
  router?: RouterTrace;
  extractions: ExtractionTrace[];
  /** Set when anything was cut to fit `TRACE_LIMITS.total`. */
  truncated?: true;
}

/** What is collected per message before it is bounded. */
export interface TraceEntry {
  router?: RouterTrace;
  extractions: ExtractionTrace[];
}

const storage = new AsyncLocalStorage<Map<string, TraceEntry>>();

function safely(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`[pipeline-trace] ${what} failed (analysis is unaffected):`, err);
  }
}

function entryFor(c: Map<string, TraceEntry>, id: string): TraceEntry {
  let e = c.get(id);
  if (!e) {
    e = { extractions: [] };
    c.set(id, e);
  }
  return e;
}

/**
 * Run one analyze request inside a fresh trace collector. Nested calls
 * share the outer one, like `withAnalyzeBatch`.
 */
export function withPipelineTrace<T>(fn: () => Promise<T>): Promise<T> {
  if (storage.getStore()) return fn();
  return storage.run(new Map(), fn);
}

/** The router gate's answer, per message. A no-op outside a trace. */
export function traceRouting(gate: {
  routes: RoutedMessage[];
  degradations: Degradation[];
  modelCalled: boolean;
  floorEnabled: boolean;
}): void {
  const c = storage.getStore();
  if (!c) return;
  safely("recording the router", () => {
    const batchWide = gate.degradations.filter((d) => d.messageId === null).map((d) => d.detail);
    for (const r of gate.routes) {
      entryFor(c, r.messageId).router = {
        route: r.route,
        source: r.source,
        ...(r.overrodeRoute ? { overrodeRoute: r.overrodeRoute } : {}),
        model: gate.modelCalled ? ROUTER_MODEL : null,
        floor: gate.floorEnabled,
        degradations: [
          ...gate.degradations.filter((d) => d.messageId === r.messageId).map((d) => d.detail),
          ...batchWide,
        ],
      };
    }
  });
}

/**
 * `extractForRoute`, with its output recorded against the message.
 *
 * Returns exactly what `extractForRoute` returns: the wrapper model
 * hands every response and every error through untouched, and all the
 * recording happens beside the call, never in its way.
 */
export async function extractForRouteTraced(
  owner: string,
  model: PipelineModel,
  route: Route,
  msg: ExtractorMessage,
): Promise<ExtractionResult> {
  const c = storage.getStore();
  if (!c) return extractForRoute(model, route, msg);

  const calls: ExtractionCall[] = [];
  let requested: string | null = null;
  const watched: PipelineModel = {
    name: model.name,
    async complete(req) {
      safely("recording the request", () => {
        requested = req.model;
      });
      let resp;
      try {
        resp = await model.complete(req);
      } catch (err) {
        safely("recording a failed call", () => {
          calls.push({ error: err instanceof Error ? err.message : String(err) });
        });
        throw err;
      }
      safely("recording a response", () => {
        calls.push({
          ms: resp.ms,
          stopReason: resp.stopReason,
          inputTokens: resp.usage.inputTokens + resp.usage.cacheReadTokens,
          outputTokens: resp.usage.outputTokens,
          raw: resp.text,
        });
      });
      return resp;
    },
  };

  const res = await extractForRoute(watched, route, msg);

  safely("recording the extraction", () => {
    // A clean parse means the facts ARE the output; the raw text would
    // only double the row. Anything less than clean keeps it, because
    // then the facts may not say what the model said.
    const clean = res.degradations.length === 0;
    entryFor(c, msg.id).extractions.push({
      owner,
      route,
      extractor: extractorFor(route),
      model: requested,
      client: model.name,
      // A SNAPSHOT. Callers adjust facts after extraction (the answer
      // batch writes a clarification's name into `personRef`), and the
      // trace is what the MODEL said, not what the caller made of it.
      facts: structuredClone(res.facts),
      degradations: res.degradations.map((d) => d.detail),
      calls: clean ? calls.map(({ raw: _raw, ...rest }) => rest) : calls,
    });
  });

  return res;
}

// ── Bounding ───────────────────────────────────────────────────────────

/**
 * Nine or more digits in a run of digits, spaces, dots, dashes and
 * brackets. Eight is the most a date carries ("2026-09-24"), so a stats
 * period survives and a UK or international number does not.
 */
const PHONE_LIKE = /\+?\d[\d\s().-]{6,}\d/g;

function redact(s: string): string {
  return s.replace(PHONE_LIKE, (m) => (m.replace(/\D/g, "").length >= 9 ? "[phone]" : m));
}

function clip(s: string, max: number): string {
  const r = redact(s);
  return r.length <= max ? r : `${r.slice(0, max - 1)}…`;
}

function bound(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return clip(v, TRACE_LIMITS.string);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v === null) return v;
  if (depth >= TRACE_LIMITS.depth) return "[too deep]";
  if (Array.isArray(v)) {
    const kept = v.slice(0, TRACE_LIMITS.array).map((x) => bound(x, depth + 1));
    return v.length > TRACE_LIMITS.array ? [...kept, `… ${v.length - TRACE_LIMITS.array} more`] : kept;
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x !== undefined) out[k] = bound(x, depth + 1);
    }
    return out;
  }
  return v === undefined ? null : clip(String(v), TRACE_LIMITS.string);
}

function boundDegradations(ds: string[]): string[] {
  return ds.slice(0, TRACE_LIMITS.degradations).map((d) => clip(d, TRACE_LIMITS.string));
}

function boundCall(call: ExtractionCall): ExtractionCall {
  return {
    ...call,
    ...(call.stopReason != null ? { stopReason: clip(call.stopReason, TRACE_LIMITS.string) } : {}),
    ...(call.raw !== undefined ? { raw: clip(call.raw, TRACE_LIMITS.raw) } : {}),
    ...(call.error !== undefined ? { error: clip(call.error, TRACE_LIMITS.string) } : {}),
  };
}

const size = (t: PipelineTrace) => JSON.stringify(t).length;

/**
 * Turn what was collected for one message into what is stored: every
 * string clipped and redacted, every array capped, and the whole thing
 * under `TRACE_LIMITS.total`. Over budget, it gives things up in order
 * of how little they tell you: raw text first, then all but the first
 * degradation, and only then the facts themselves.
 */
export function buildPipelineTrace(entry: TraceEntry): PipelineTrace {
  const trace: PipelineTrace = {
    v: PIPELINE_TRACE_VERSION,
    ...(entry.router
      ? {
          router: {
            ...(bound(entry.router) as RouterTrace),
            degradations: boundDegradations(entry.router.degradations),
          },
        }
      : {}),
    extractions: entry.extractions.slice(0, TRACE_LIMITS.extractions).map((x) => ({
      owner: clip(x.owner, TRACE_LIMITS.string),
      route: clip(x.route, TRACE_LIMITS.string),
      extractor: clip(x.extractor, TRACE_LIMITS.string),
      model: x.model === null ? null : clip(x.model, TRACE_LIMITS.string),
      client: clip(x.client, TRACE_LIMITS.string),
      facts: bound(x.facts),
      degradations: boundDegradations(x.degradations),
      calls: x.calls.slice(0, TRACE_LIMITS.degradations).map(boundCall),
    })),
  };
  if (entry.extractions.length > TRACE_LIMITS.extractions) trace.truncated = true;

  const shrinks: Array<(t: PipelineTrace) => void> = [
    (t) => t.extractions.forEach((x) => x.calls.forEach((call) => delete call.raw)),
    (t) => {
      t.extractions.forEach((x) => (x.degradations = x.degradations.slice(0, 1)));
      if (t.router) t.router.degradations = t.router.degradations.slice(0, 1);
    },
    (t) => t.extractions.forEach((x) => (x.facts = "[dropped: over the trace budget]")),
    (t) => {
      t.extractions = [];
      if (t.router) t.router.degradations = [];
    },
  ];
  for (const shrink of shrinks) {
    if (size(trace) <= TRACE_LIMITS.total) break;
    shrink(trace);
    trace.truncated = true;
  }
  return trace;
}

// ── Saving ─────────────────────────────────────────────────────────────

export type TraceWriter = (waMessageId: string, trace: PipelineTrace) => Promise<unknown>;

/**
 * Save every trace this request collected, through `write`. Called
 * once, at the end of the request. NEVER throws: a failure is logged
 * and the other traces still save. Returns how many saved.
 *
 * The writer is the CALLER's (the analyze route writes the column),
 * because nothing in this directory touches the database:
 * `__tests__/zero-writes.test.ts` holds that line for the dry run.
 */
export async function persistPipelineTraces(write: TraceWriter): Promise<number> {
  const c = storage.getStore();
  if (!c || c.size === 0) return 0;
  try {
    const entries = [...c.entries()];
    c.clear();
    const results = await Promise.allSettled(
      entries.map(async ([id, entry]) => write(id, buildPipelineTrace(entry))),
    );
    let saved = 0;
    results.forEach((r, i) => {
      if (r.status === "fulfilled") saved += 1;
      else console.error(`[pipeline-trace] saving the trace for ${entries[i][0]} failed (analysis is unaffected):`, r.reason);
    });
    return saved;
  } catch (err) {
    console.error("[pipeline-trace] saving traces failed (analysis is unaffected):", err);
    return 0;
  }
}
