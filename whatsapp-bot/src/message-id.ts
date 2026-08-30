/**
 * Inbound WhatsApp message-id resolution.
 *
 * ── Why this exists (2026-08-30 attendance outage) ───────────────────
 * `enqueueForAnalysis` opened with:
 *
 *     const waMessageId = waMessageIdFrom(msg);
 *     if (!waMessageId) return;          // ← silently dropped EVERY message
 *
 * That guard was written for the SEND path (PR #11), where `sendMessage()`
 * legitimately resolves to `undefined` and there is nothing to ACK. Reusing
 * it on the INBOUND path turned "we couldn't read an id" into "throw the
 * message away".
 *
 * When whatsapp-web.js's injected page code fell out of step with the live
 * WhatsApp Web build (the minified `r: r` failures all over the Pi's logs),
 * inbound `Message` objects stopped exposing a usable `id._serialized`, so
 * every group message hit that `return` before it was buffered. `[msg]`
 * lines kept scrolling, ~111 flushes ran over 18.5h and logged nothing
 * (`flushGroup` returned early on an empty buffer WITHOUT logging), zero
 * `AnalyzedMessage` rows were written, and a paying customer's attendance
 * tracking was dead for three days with no error anywhere.
 *
 * ── The rule this module encodes ─────────────────────────────────────
 * An unreadable id is a DEGRADED read, not a reason to discard a customer's
 * "IN". We synthesise a stand-in id and carry on.
 *
 * ── Determinism is the correctness property ──────────────────────────
 * `/api/whatsapp/analyze` dedupes on `AnalyzedMessage.waMessageId` (unique).
 * The id's only jobs are that dedupe and reaction mapping. So a synthetic id
 * MUST be a pure function of the message's own content: the same underlying
 * message seen twice — e.g. re-fed by `recoverGroupMessages`, which replays
 * the last 2h of history after every restart — must hash to the SAME id, or
 * the server would treat the replay as new and register attendance twice.
 *
 * Hence: no `Date.now()`, no randomness, no counter. Only fields that do NOT
 * go through the broken injected code (`from`, `author`, `timestamp`, body),
 * read totally (each behind its own try/catch, because any of them can be a
 * throwing getter on the broken build).
 *
 * Known, accepted limitation: two byte-identical messages from the same
 * author in the same group carrying the same WhatsApp timestamp (1s
 * resolution) collide, and the server dedupes the second away. Registering
 * one "in" once instead of twice is harmless; losing every message is not.
 */
import { createHash } from "node:crypto";

/** Marks an id we invented because the library couldn't give us a real one.
 *  Deliberately obvious in `AnalyzedMessage.waMessageId` and in the logs. */
export const SYNTHETIC_WA_ID_PREFIX = "synthetic:";

export interface ResolvedWaMessageId {
  /** Always a non-empty string — the server 400s on an empty waMessageId. */
  waMessageId: string;
  /** True when the real id was unreadable and this one was synthesised. */
  synthetic: boolean;
}

/** Read one property totally: a throwing getter yields `undefined`. */
function read(obj: unknown, key: string): unknown {
  try {
    if (obj === null || typeof obj !== "object") return undefined;
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function asText(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/**
 * Deterministic stand-in id for a message whose real id can't be read.
 *
 * Pure: same parts in, same id out, in this process and in every future one.
 */
export function synthesizeWaMessageId(parts: {
  from?: unknown;
  author?: unknown;
  timestamp?: unknown;
  body?: unknown;
}): string {
  // NUL-separated so ("ab", "c") and ("a", "bc") can't hash to the same thing
  // (a NUL byte cannot appear in a WhatsApp JID, timestamp or message body).
  const material = [
    asText(parts.from),
    asText(parts.author),
    asText(parts.timestamp),
    asText(parts.body),
  ].join("\u0000");
  const hash = createHash("sha256").update(material, "utf8").digest("hex").slice(0, 16);
  return `${SYNTHETIC_WA_ID_PREFIX}${hash}`;
}

/** Was this id invented by us rather than issued by WhatsApp? */
export function isSyntheticWaMessageId(id: string): boolean {
  return typeof id === "string" && id.startsWith(SYNTHETIC_WA_ID_PREFIX);
}

/**
 * The id to use for an inbound message: the real `id._serialized` when the
 * library can give us one, a deterministic synthetic id when it can't.
 *
 * Total — never throws, whatever shape (or booby-trapped proxy) it is given.
 */
export function resolveWaMessageId(msg: unknown): ResolvedWaMessageId {
  const serialized = read(read(msg, "id"), "_serialized");
  if (typeof serialized === "string" && serialized.length > 0) {
    return { waMessageId: serialized, synthetic: false };
  }

  // Body: `msg.body` is sometimes empty on unsynced chats while the raw
  // payload still carries the text (same fallback the message handler uses).
  const body = read(msg, "body");
  const dataBody = read(read(msg, "_data"), "body");
  return {
    waMessageId: synthesizeWaMessageId({
      from: read(msg, "from"),
      author: read(msg, "author"),
      timestamp: read(msg, "timestamp"),
      body: typeof body === "string" && body.length > 0 ? body : dataBody,
    }),
    synthetic: true,
  };
}

/**
 * Should the Nth synthetic id be logged?
 *
 * Loud on the first one (this is a "the library is broken" event an operator
 * must see), then exponentially rarer so a busy group can't drown the log,
 * then every 1000 forever so it can never go permanently quiet.
 */
export function shouldLogSyntheticId(count: number): boolean {
  if (!Number.isFinite(count) || count < 1) return false;
  if (count === 1 || count === 10 || count === 100) return true;
  return count % 1000 === 0;
}

/** The loud explanation logged alongside a synthesised id. */
export function missingMessageIdMessage(count: number, sampleId: string): string {
  return (
    `CRITICAL: could not read id._serialized on an inbound message (occurrence #${count}) — ` +
    `using the deterministic synthetic id ${sampleId} instead so the message still reaches ` +
    "the analyzer and attendance is recorded. Reaction tracking for such messages is lost " +
    "(there is no real WhatsApp id to react to). This almost always means whatsapp-web.js's " +
    "injected page code is out of step with the live WhatsApp Web build — check WA_WEB_VERSION " +
    "and the whatsapp-web.js version."
  );
}
