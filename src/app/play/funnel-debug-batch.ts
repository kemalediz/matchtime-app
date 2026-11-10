/**
 * TEMPORARY (2026-11-10): the server half of the /play funnel diagnostic
 * (`funnel-debug.ts`, POST /api/play/debug). Remove both once the reason the
 * Facebook in-app browser sent no beacon is known.
 *
 * A batch is read field by field onto a fresh object: only the fields the
 * recorder sends, numbers and booleans as such, strings short and plain
 * (letters, digits, `_ : . -`). A one-character `key` is dropped, as that
 * would be the character typed, and free text (`msg`) is kept only on an
 * error record. So whatever a page sends, the log never holds his words.
 */

export const FUNNEL_DEBUG_LOG_PREFIX = "[pool-funnel-debug] ";
/** The longest log line, in characters. */
export const FUNNEL_DEBUG_LOG_MAX = 8000;
/** The largest body the endpoint reads, in bytes. */
export const FUNNEL_DEBUG_MAX_BYTES = 16 * 1024;
const MAX_EVENTS = 200;
const TRUNCATED = "…(truncated)";

export type DebugValue = string | number | boolean;
export type DebugRecord = { k: string } & Record<string, DebugValue>;
export interface FunnelDebugBatch {
  v: 1;
  sid: string;
  seq: number;
  why?: string;
  prev?: string;
  drop?: number;
  ev: DebugRecord[];
}

const NUMBERS = new Set(["t", "len", "bl", "kc", "dl", "dn", "dd", "mk", "n"]);
const BOOLEANS = new Set(["tr", "ch", "ck", "comp", "f", "sv", "ss", "dr", "sbf", "pre", "ok", "held", "hb", "per"]);
const STRINGS = new Set(["it", "tag", "ty", "nm", "key", "nav", "rs", "vis", "st", "step", "v", "ev", "src", "via"]);
const PLAIN = /^[A-Za-z0-9_:.-]{1,40}$/;
const SID = /^[A-Za-z0-9]{6,32}$/;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const plain = (x: unknown): string | undefined => (typeof x === "string" && PLAIN.test(x) ? x : undefined);

function readRecord(raw: unknown): DebugRecord | null {
  if (!isObj(raw)) return null;
  const k = plain(raw.k);
  if (!k) return null;
  const out: DebugRecord = { k };
  for (const [name, value] of Object.entries(raw)) {
    if (name === "k") continue;
    if (NUMBERS.has(name)) {
      if (typeof value === "number" && Number.isFinite(value)) out[name] = value;
    } else if (BOOLEANS.has(name)) {
      if (typeof value === "boolean") out[name] = value;
    } else if (STRINGS.has(name)) {
      const s = plain(value);
      if (s && !(name === "key" && s.length < 2)) out[name] = s;
    } else if (name === "msg" && k === "error" && typeof value === "string") {
      out.msg = value.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 160);
    }
  }
  return out;
}

/** A batch as the recorder sends it, or null for anything else. */
export function readFunnelDebugBatch(body: unknown): FunnelDebugBatch | null {
  if (!isObj(body) || body.v !== 1) return null;
  if (typeof body.sid !== "string" || !SID.test(body.sid)) return null;
  if (typeof body.seq !== "number" || !Number.isInteger(body.seq) || body.seq < 0 || body.seq > 100_000) return null;
  if (!Array.isArray(body.ev) || body.ev.length > MAX_EVENTS) return null;
  const batch: FunnelDebugBatch = { v: 1, sid: body.sid, seq: body.seq, ev: [] };
  const why = plain(body.why);
  if (why) batch.why = why;
  const prev = plain(body.prev);
  if (prev) batch.prev = prev;
  if (typeof body.drop === "number" && Number.isInteger(body.drop) && body.drop >= 0) batch.drop = body.drop;
  for (const raw of body.ev) {
    const rec = readRecord(raw);
    if (rec) batch.ev.push(rec);
  }
  return batch;
}

/** The one log line for a batch: the prefix, then JSON with the user agent, cut to a few KB. */
export function funnelDebugLogLine(batch: FunnelDebugBatch, userAgent: string | null): string {
  const line = FUNNEL_DEBUG_LOG_PREFIX + JSON.stringify({ ua: userAgent ? userAgent.slice(0, 400) : null, ...batch });
  return line.length <= FUNNEL_DEBUG_LOG_MAX ? line : line.slice(0, FUNNEL_DEBUG_LOG_MAX - TRUNCATED.length) + TRUNCATED;
}

/** A fixed-window counter per key, in memory (one per server instance: approximate, which is fine here). */
export function createRateLimiter({ limit, windowMs }: { limit: number; windowMs: number }) {
  const seen = new Map<string, { start: number; count: number }>();
  return (key: string, now: number): boolean => {
    if (seen.size > 5000) {
      for (const [k, w] of seen) if (now - w.start >= windowMs) seen.delete(k);
    }
    const w = seen.get(key);
    if (!w || now - w.start >= windowMs) {
      seen.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= limit) return false;
    w.count += 1;
    return true;
  };
}
