/**
 * AN EDIT PURGES THE TEXT AND KEEPS THE FACTS (2026-11-16, PR #606 round 8).
 *
 * When a member edits their own message, MatchTime forgets the original
 * words but otherwise behaves as it does today: what it read stays what it
 * acts on. So a stored pipeline trace (`AnalyzedMessage.pipelineTrace`,
 * `AdminGroupMessage.pipelineTrace`, shape `pipeline/trace.ts`) keeps the
 * STRUCTURED reading later features act on, and loses every free-text
 * field. A WHITELIST: anything not named here is dropped.
 *
 * KEPT, and why:
 *   v, truncated                 the shape's version and its flag.
 *   router.route, source,        how the message was routed: the trace
 *     overrodeRoute, model,        viewer and the route-level checks.
 *     floor
 *   extractions[].owner, route,  which reading it was.
 *     extractor, model, client,
 *     sharedWith
 *   extractions[].facts          THE FACTS, as the extractor returned them:
 *                                intent and action, the refused-ask facts
 *                                (`refused-ask-retry.ts` reads kind, action,
 *                                partnerClubs, clubRef, pool), person and
 *                                club refs, mentioned ids, decisions,
 *                                counts and times. Free-text keys inside
 *                                them are blanked (below).
 *   extractions[].calls[] ms,    cost and timing: the AI budget's history.
 *     stopReason, inputTokens,
 *     cacheReadTokens,
 *     cacheWriteTokens,
 *     outputTokens, costUsd
 *
 * DROPPED: calls[].raw (the model's raw output) and calls[].error (it can
 * quote it); every degradations list (diagnostic lines that can carry
 * words); hqSquadReader and any other key; and, inside facts, the string
 * values of `note` (a reminder in the sender's own words), `phrase` (a time
 * "as written") and `reason` (a form note's few words), blanked to "".
 *
 * `heldQuestion`: the one exception, for an open "who do you mean?" (an
 * edited stats question whose clarification window is still open): its
 * question, kept only until `until` so the answer can still be read against
 * it (`pipeline/load-awaiting-answer.ts`), then dropped by the next clear.
 */

const FREE_TEXT_FACT_KEYS = new Set(["note", "phrase", "reason"]);
const CALL_KEYS = ["ms", "stopReason", "inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "costUsd"] as const;
const ROUTER_KEYS = ["route", "source", "overrodeRoute", "model", "floor"] as const;
const EXTRACTION_KEYS = ["owner", "route", "extractor", "model", "client"] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function pick(o: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (k in o) out[k] = o[k];
  return out;
}

/** PURE. Facts with their free-text values blanked, everything else as it was. */
function factsWithoutText(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(factsWithoutText);
  if (!isObj(v)) return v;
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) out[k] = FREE_TEXT_FACT_KEYS.has(k) && typeof x === "string" ? "" : factsWithoutText(x);
  return out;
}

/** PURE. The trace with no free text (see the header). Null stays null. */
export function textFreeTrace(trace: unknown): Obj | null {
  if (trace === null || trace === undefined) return null;
  const t: Obj = isObj(trace) ? trace : {};
  const out: Obj = { v: typeof t.v === "number" ? t.v : 1 };
  if (isObj(t.router)) out.router = { ...pick(t.router, ROUTER_KEYS), degradations: [] };
  out.extractions = (Array.isArray(t.extractions) ? t.extractions : []).filter(isObj).map((e) => ({
    ...pick(e, EXTRACTION_KEYS),
    facts: factsWithoutText(e.facts ?? null),
    degradations: [],
    calls: (Array.isArray(e.calls) ? e.calls : []).filter(isObj).map((c) => pick(c, CALL_KEYS)),
    ...(Array.isArray(e.sharedWith) ? { sharedWith: e.sharedWith.filter((s): s is string => typeof s === "string") } : {}),
  }));
  if (t.truncated === true) out.truncated = true;
  return out;
}

/** PURE. JSON in a key order of its own: Postgres JSONB hands keys back in ITS order, not ours. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** PURE. The same JSON value, whatever the key order. */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** PURE. Is there no free text left in it (a held question counts as text)? */
export function isTextFree(trace: unknown): boolean {
  return sameJson(textFreeTrace(trace), trace ?? null);
}

/** PURE. A text-free trace that also holds an open clarification's question until `until`. */
export function withHeldQuestion(trace: Obj | null, text: string, until: Date): Obj {
  return { ...(trace ?? { v: 1, extractions: [] }), heldQuestion: { text, until: until.toISOString() } };
}

/** PURE. The question held in a trace, or null. */
export function heldQuestionOf(trace: unknown): { text: string; until: Date } | null {
  const h = isObj(trace) ? trace.heldQuestion : null;
  if (!isObj(h) || typeof h.text !== "string" || typeof h.until !== "string") return null;
  const until = new Date(h.until);
  return Number.isNaN(until.getTime()) ? null : { text: h.text, until };
}
