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
 *   extractions[].facts          THE FACTS, by an allowlist (round 9):
 *                                every number, boolean and null; strings
 *                                only under an ENUM key (kind, action,
 *                                topic, polarity, ...: an identifier, never
 *                                a space), a checked FORMAT (a London time
 *                                "HH:MM", "YYYY-MM-DD HH:MM", a month
 *                                "YYYY-MM"), and `clubRef` in a recruit
 *                                from partner clubs only (below). Every
 *                                other string, names and refs included, is
 *                                blanked to "": a name the message wrote
 *                                is its words.
 *   extractions[].calls[] ms,    cost and timing: the AI budget's history.
 *     stopReason, inputTokens,
 *     cacheReadTokens,
 *     cacheWriteTokens,
 *     outputTokens, costUsd
 *
 * DROPPED: calls[].raw (the model's raw output) and calls[].error (it can
 * quote it); every degradations list (diagnostic lines that can carry
 * words); hqSquadReader and any other key.
 *
 * `clubRef` IS FREE TEXT (the club's name as the message wrote it). It is
 * kept only in an admin recruit from partner clubs, because "try again"
 * (`refused-ask-retry.ts`) repeats exactly that ask, to that club; it reads
 * nothing else that is a string beyond kind and action.
 */

/** Keys whose string values are enums (identifiers): kept when they look like one. */
const ENUM_KEYS = new Set([
  "kind",
  "action",
  "subject",
  "personKind",
  "polarity",
  "conditionOn",
  "tense",
  "affirmation",
  "sideRequests",
  "topic",
  "feature",
  "badge",
  "table",
  "listEnd",
  "unit",
  "team",
]);
const ENUM_VALUE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const HHMM = /^\d{2}:\d{2}$/;
const YYYY_MM = /^\d{4}-\d{2}$/;
/** Keys whose string values are checked formats, never words. */
const FORMAT_KEYS: Record<string, RegExp> = {
  remindAt: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
  quietFrom: HHMM,
  quietTo: HHMM,
  newTime: HHMM,
  breakMonths: YYYY_MM,
  playMonths: YYYY_MM,
};
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

/** PURE. A string under `key`, kept only when it is an enum or a checked format. */
function keptString(key: string | null, x: string): string {
  if (key && ENUM_KEYS.has(key)) return ENUM_VALUE.test(x) ? x : "";
  if (key && FORMAT_KEYS[key]) return FORMAT_KEYS[key].test(x) ? x : "";
  return "";
}

/** PURE. Facts by the allowlist (see the header). `key`: the key the value sits under (an array's elements share it). */
function factsWithoutText(v: unknown, key: string | null = null): unknown {
  if (typeof v === "string") return keptString(key, v);
  if (Array.isArray(v)) return v.map((x) => factsWithoutText(x, key));
  if (!isObj(v)) return v;
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) out[k] = factsWithoutText(x, k);
  // The one free-text exception: the club a partner-club recruit names, for "try again".
  if (v.kind === "admin" && v.action === "recruit" && v.partnerClubs === true && typeof v.clubRef === "string") out.clubRef = v.clubRef;
  return out;
}

/** PURE. Facts (or a list of them, e.g. the none-bucket shadow's claims) by the same allowlist. */
export function textFreeFacts(facts: unknown): unknown {
  return factsWithoutText(facts);
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

/** PURE. Is there no free text left in it? */
export function isTextFree(trace: unknown): boolean {
  return sameJson(textFreeTrace(trace), trace ?? null);
}
