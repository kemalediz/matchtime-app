/**
 * THE CLUB SCENARIOS' MODEL CASSETTE. Pure: no I/O.
 *
 * A record run sends every model request to Anthropic (on the developer key)
 * and keeps the request and the answer. A replay run answers every request
 * from what was kept, with no network at all, and FAILS on a request it never
 * saw. That is the point of it: when a branch changes a prompt, the replay
 * names the request that changed instead of quietly calling the model again.
 *
 * Requests are matched on a KEY: a hash of the fields that decide the answer
 * (model, system, messages, tools, schema, thinking, token ceiling), after
 * masking what differs from one run to the next without changing the meaning:
 * database ids the server generates, link tokens, timestamps below the
 * minute, and the app's own address (http://localhost:<MT_E2E_APP_PORT>,
 * which goes into every link the server writes, becomes "<app>", so a
 * recording made on one port replays on any other). The key is always recomputed from the stored request when a
 * cassette is loaded, so a better mask never needs a new recording.
 *
 * The same request can be asked more than once in a run (the same question
 * twice). Its answers are served in the order they were recorded; asked more
 * often than recorded, the last answer is served again and counted as a
 * repeat, so a branch that calls more often is visible without failing.
 */
import { createHash } from "node:crypto";

/** One model call as it went over the wire. */
export interface RecordedCall {
  /** The request body, parsed. */
  request: unknown;
  status: number;
  /** The response body, verbatim. */
  body: string;
}

export interface CassetteMiss {
  key: string;
  model: string;
  /** The first words of the system prompt, to say which call site it was. */
  site: string;
  /** The recorded request most like this one, if any. */
  nearest: { key: string; site: string } | null;
  /** Both sides around the first place the normalised requests differ. */
  firstDifference: string;
}

export class CassetteMissError extends Error {
  constructor(readonly miss: CassetteMiss) {
    super(
      `cassette miss: no recorded answer for a ${miss.model} request (${miss.site}).\n` +
        (miss.nearest ? `  nearest recorded request differs here:\n${miss.firstDifference}` : "  nothing recorded for this model."),
    );
    this.name = "CassetteMissError";
  }
}

// ── Normalising ──────────────────────────────────────────────────────

/** The fields of a Messages request that decide its answer. */
const KEY_FIELDS = [
  "model",
  "system",
  "messages",
  "tools",
  "tool_choice",
  "output_config",
  "thinking",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "max_tokens",
] as const;

const CUID = /\bc[a-z0-9]{24}\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** A link: keep the host and the first path segment (what kind of link), mask the rest. */
const LINK = /(https?:\/\/[^\s/"'<>)]+\/[A-Za-z0-9_-]+)\/[^\s"'<>)]*/g;
/**
 * The app under test's origin. Its port is MT_E2E_APP_PORT, so it is noise:
 * masked whole (scheme and port too). No word boundary before "http": a
 * prompt quoting an earlier message holds "\\nhttp://…" (backslash, n), where
 * there is none. Applied after LINK, whose host class stops at "<", so
 * masking twice changes nothing.
 */
const APP_ORIGIN = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?![\w.:-])/g;
const ISO_SECONDS = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g;

export function normaliseVolatileText(s: string): string {
  return s
    .replace(LINK, "$1/<tok>")
    .replace(APP_ORIGIN, "<app>")
    .replace(ISO_SECONDS, (_m, minute: string, zone: string | undefined) => `${minute}${zone ?? ""}`)
    .replace(UUID, "<uuid>")
    .replace(CUID, "<id>");
}

function deepNormalise(v: unknown): unknown {
  if (typeof v === "string") return normaliseVolatileText(v);
  if (Array.isArray(v)) return v.map(deepNormalise);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      // A cache marker changes the price, never the answer.
      if (k === "cache_control") continue;
      out[k] = deepNormalise(x);
    }
    return out;
  }
  return v;
}

/** The request reduced to what decides its answer, with run-to-run noise masked. */
export function normaliseRequest(body: unknown): unknown {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of KEY_FIELDS) if (b[k] !== undefined) out[k] = deepNormalise(b[k]);
  return out;
}

/** JSON with object keys sorted, so key order never changes a hash. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function requestKey(body: unknown): string {
  return sha(stableStringify(normaliseRequest(body))).slice(0, 32);
}

function sortLines(v: unknown): unknown {
  if (typeof v === "string") return v.split("\n").sort().join("\n");
  if (Array.isArray(v)) return v.map(sortLines);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = sortLines(x);
    return out;
  }
  return v;
}

/**
 * The key with every text's lines sorted: the same words in another order.
 * The server under test sometimes lists rows that share a timestamp (an HQ
 * message and MatchTime's reply to it are both written with the request's
 * "now") in whatever order Postgres returns them, which can differ between
 * a record run and a replay. Matching on this key is a fallback, counted
 * and listed as "reordered", never a silent hit.
 */
export function looseRequestKey(body: unknown): string {
  return sha(stableStringify(sortLines(normaliseRequest(body)))).slice(0, 32);
}

function siteOf(body: unknown): string {
  const sys = (body as { system?: unknown })?.system;
  const text = typeof sys === "string" ? sys : Array.isArray(sys) ? sys.map((s) => (s as { text?: string })?.text ?? "").join(" ") : "";
  return text.replace(/\s+/g, " ").trim().slice(0, 90) || "(no system prompt)";
}

function modelOf(body: unknown): string {
  return String((body as { model?: unknown })?.model ?? "unknown");
}

function firstDifference(a: string, b: string, width = 160): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 40);
  return `    asked:    …${a.slice(from, from + width)}…\n    recorded: …${b.slice(from, from + width)}…`;
}

// ── The cassette ─────────────────────────────────────────────────────

export interface CassetteStats {
  recorded: number;
  hits: number;
  repeats: number;
  /** Served after matching on the line-order-blind key (looseRequestKey). */
  reordered: number;
  misses: number;
}

export class Cassette {
  private readonly byKey = new Map<string, RecordedCall[]>();
  private readonly byLooseKey = new Map<string, RecordedCall[]>();
  private readonly servedLoose = new Map<string, number>();
  private readonly reorderedCalls: Array<{ key: string; site: string }> = [];
  private readonly served = new Map<string, number>();
  private readonly normalised: Array<{ key: string; model: string; site: string; text: string }> = [];
  private readonly misses: CassetteMiss[] = [];
  private hits = 0;
  private repeats = 0;

  constructor(calls: RecordedCall[]) {
    for (const c of calls) {
      const key = requestKey(c.request);
      const list = this.byKey.get(key) ?? [];
      list.push(c);
      this.byKey.set(key, list);
      const loose = looseRequestKey(c.request);
      this.byLooseKey.set(loose, [...(this.byLooseKey.get(loose) ?? []), c]);
      if (list.length === 1)
        this.normalised.push({ key, model: modelOf(c.request), site: siteOf(c.request), text: stableStringify(normaliseRequest(c.request)) });
    }
    this.recorded = calls.length;
  }

  private readonly recorded: number;

  /** The recorded answer for this request. Throws CassetteMissError on a miss. */
  take(request: unknown): RecordedCall {
    const key = requestKey(request);
    const list = this.byKey.get(key);
    if (!list) {
      const loose = looseRequestKey(request);
      const same = this.byLooseKey.get(loose);
      if (same) {
        const n = this.servedLoose.get(loose) ?? 0;
        this.servedLoose.set(loose, n + 1);
        this.reorderedCalls.push({ key, site: siteOf(request) });
        return same[Math.min(n, same.length - 1)];
      }
      const miss = this.describeMiss(request, key);
      this.misses.push(miss);
      throw new CassetteMissError(miss);
    }
    const n = this.served.get(key) ?? 0;
    this.served.set(key, n + 1);
    if (n < list.length) {
      this.hits++;
      return list[n];
    }
    this.repeats++;
    return list[list.length - 1];
  }

  private describeMiss(request: unknown, key: string): CassetteMiss {
    const model = modelOf(request);
    const text = stableStringify(normaliseRequest(request));
    let best: (typeof this.normalised)[number] | null = null;
    let bestLen = -1;
    for (const n of this.normalised) {
      if (n.model !== model) continue;
      let i = 0;
      while (i < text.length && i < n.text.length && text[i] === n.text[i]) i++;
      if (i > bestLen) {
        bestLen = i;
        best = n;
      }
    }
    return {
      key,
      model,
      site: siteOf(request),
      nearest: best ? { key: best.key, site: best.site } : null,
      firstDifference: best ? firstDifference(text, best.text) : "",
    };
  }

  stats(): CassetteStats {
    return { recorded: this.recorded, hits: this.hits, repeats: this.repeats, reordered: this.reorderedCalls.length, misses: this.misses.length };
  }

  reorderedList(): Array<{ key: string; site: string }> {
    return [...this.reorderedCalls];
  }

  missList(): CassetteMiss[] {
    return [...this.misses];
  }
}

// ── On disk ──────────────────────────────────────────────────────────

/** Strings at least this long are stored once, by hash (system prompts). */
const BLOB_MIN = 1500;
const BLOB_REF = "\u0000blob:";

export interface CassetteFile {
  version: 1;
  club: string;
  /** What recording it cost, measured off the wire. */
  meter: { calls: number; costUsd: number; byModel?: Record<string, { calls: number; costUsd: number }> };
  blobs: Record<string, string>;
  entries: Array<{ key: string; model: string; site: string; status: number; request: unknown; body: string }>;
}

function packValue(v: unknown, blobs: Record<string, string>): unknown {
  if (typeof v === "string" && v.length >= BLOB_MIN) {
    const h = sha(v).slice(0, 24);
    blobs[h] = v;
    return `${BLOB_REF}${h}`;
  }
  if (Array.isArray(v)) return v.map((x) => packValue(x, blobs));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = packValue(x, blobs);
    return out;
  }
  return v;
}

function unpackValue(v: unknown, blobs: Record<string, string>): unknown {
  if (typeof v === "string" && v.startsWith(BLOB_REF)) {
    const h = v.slice(BLOB_REF.length);
    if (!(h in blobs)) throw new Error(`cassette: missing blob ${h}`);
    return blobs[h];
  }
  if (Array.isArray(v)) return v.map((x) => unpackValue(x, blobs));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = unpackValue(x, blobs);
    return out;
  }
  return v;
}

export function packCassette(input: { club: string; calls: RecordedCall[]; meter: CassetteFile["meter"] }): CassetteFile {
  const blobs: Record<string, string> = {};
  const entries = input.calls.map((c) => ({
    key: requestKey(c.request),
    model: modelOf(c.request),
    site: siteOf(c.request),
    status: c.status,
    request: packValue(c.request, blobs),
    body: c.body,
  }));
  return { version: 1, club: input.club, meter: input.meter, blobs, entries };
}

export function unpackCassette(file: CassetteFile): { club: string; calls: RecordedCall[]; meter: CassetteFile["meter"] } {
  if (file.version !== 1) throw new Error(`cassette: unsupported version ${String(file.version)}`);
  return {
    club: file.club,
    meter: file.meter,
    calls: file.entries.map((e) => ({ request: unpackValue(e.request, file.blobs), status: e.status, body: e.body })),
  };
}
