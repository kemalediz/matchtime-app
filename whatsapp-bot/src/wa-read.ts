/**
 * Total reads over whatsapp-web.js objects.
 *
 * ── Why (the 2026-08-28 → 08-30 injected-layer breakage) ─────────────
 * When whatsapp-web.js's injected page code falls out of step with the live
 * WhatsApp Web build, the objects it hands us stop being trustworthy: a
 * property that was a plain value yesterday can today be a getter that
 * throws a minified `r`, or be missing entirely. An unguarded read then
 * throws from wherever it sits, and because almost every handler on the Pi
 * is one big `try { … } catch (err) { console.error(...) }`, the throw
 * aborts the WHOLE handler — losing the customer's message, not just the
 * field we were reading.
 *
 * That is precisely how attendance died for three days: one unreadable
 * field, one early `return`, and every "IN" in a paying customer's group
 * went in the bin with no error anywhere.
 *
 * The rule: reading a field off a WhatsApp object is ALWAYS best-effort and
 * must NEVER be able to abort the pipeline. Two identical copies of this
 * helper had already grown inside message-id.ts and smart-analysis.ts while
 * index.ts had none — hence one module all three share.
 *
 * Everything here is pure and dependency-free so it is trivially testable
 * against booby-trapped objects.
 */

/** Read one property. A throwing getter, a null, or a primitive yields `undefined`. */
export function safeRead(obj: unknown, key: string): unknown {
  try {
    if (obj === null || typeof obj !== "object") return undefined;
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Walk a nested path, stopping (not throwing) at the first unreadable segment. */
export function safePath(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    cur = safeRead(cur, k);
    if (cur === undefined || cur === null) return undefined;
  }
  return cur;
}

/** A string when the value is a usable one, otherwise "". */
export function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * The message's text.
 *
 * `msg.body` is authoritative, but on chats WhatsApp hasn't fully synced to
 * the headless session it is empty while the raw payload still carries the
 * text in `_data.body` — discovered when 50+ roster-survey DM replies all
 * logged `bodyLen=0` even though they were plainly text in WhatsApp. Both
 * reads are total, because on the broken build either can throw.
 */
export function readMessageBody(msg: unknown): string {
  const body = asString(safeRead(msg, "body"));
  if (body.length > 0) return body;
  return asString(safePath(msg, "_data", "body"));
}

/**
 * The sender's WhatsApp pushname as carried ON THE MESSAGE ITSELF.
 *
 * This is the single most valuable field on the degraded path. `_data` is
 * the raw serialised payload attached to the Message when the event fired —
 * a plain object property, NOT a call back into the injected page code — so
 * it keeps working when `msg.getContact()` / `client.getContactById()` are
 * throwing the minified `r`.
 *
 * That matters because of how the server resolves WHO spoke
 * (`/api/whatsapp/analyze` → `resolveSender`): phone first, then a fuzzy
 * match on the author's name. Group senders in WhatsApp's privacy mode
 * arrive as opaque `@lid` JIDs that carry NO phone at all, so the NAME is
 * the only identity available for them. Lose it and the sender resolves to
 * `{ userId: null }` — the message reaches the analyzer and is still thrown
 * away, just one layer later.
 *
 * Returns the trimmed name, or null when there isn't a usable one.
 */
export function readNotifyName(msg: unknown): string | null {
  const raw = safePath(msg, "_data", "notifyName");
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * First candidate that is a non-blank string, trimmed. Used to express
 * "prefer the enriched contact name, fall back to the pushname on the
 * payload" as one readable expression.
 *
 * Deliberately does NOT enforce a minimum length: the server already has
 * the rules for that (a 2-char pushname resolves against the roster but is
 * never provisioned as a new player), and second-guessing them here would
 * throw away an identity the server could have used.
 */
export function firstUsableName(...candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const t = c.trim();
    if (t.length > 0) return t;
  }
  return null;
}

/** The headline fields index.ts's `message` handler branches on. */
export interface InboundHeadline {
  /** Chat JID: "<id>@g.us" for a group, "@c.us"/"@lid" for a DM. "" when unreadable. */
  from: string;
  /** Did the BOT send this? Defaults to false — see below. */
  fromMe: boolean;
  /** whatsapp-web.js message type ("chat", "ptt", "image", …). "" when unreadable. */
  type: string;
  /** Message text, `_data.body` when `msg.body` is empty or throws. */
  body: string;
  hasMedia: boolean;
  /** WhatsApp's own timestamp in SECONDS, falling back to now. */
  timestampSec: number;
  /** Sender's pushname off the raw payload; the degraded path's only identity. */
  notifyName: string | null;
}

/**
 * Read everything the `message` handler needs, in one total pass.
 *
 * ── Why this is not paranoia ─────────────────────────────────────────
 * PRs #11 and #13 made `enqueueForAnalysis` total, but the handler that
 * CALLS it still read `msg.body`, `msg._data.body`, `msg.from`, `msg.type`
 * and `msg.hasMedia` directly, several statements earlier. Optional
 * chaining (`msg._data?.body`) guards a null `_data`; it does NOT guard a
 * `_data` that is a THROWING GETTER, which is exactly what the broken
 * injected build produces. A throw there lands in the handler's outer
 * `catch { console.error("message handler failed") }` and the message is
 * lost just as completely as it was under the old id guard — only one
 * frame earlier, and with a log line that looks like a one-off.
 *
 * `fromMe` deliberately defaults to FALSE. Defaulting it to true would make
 * the handler skip a real player's message as if the bot had sent it, which
 * is the same silent-drop failure we are removing. False risks re-processing
 * one of the bot's own messages, which the analyzer classifies as noise.
 */
export function readInboundHeadline(msg: unknown): InboundHeadline {
  const ts = safeRead(msg, "timestamp");
  return {
    from: asString(safeRead(msg, "from")),
    fromMe: safeRead(msg, "fromMe") === true,
    type: asString(safeRead(msg, "type")),
    body: readMessageBody(msg),
    hasMedia: safeRead(msg, "hasMedia") === true,
    timestampSec: typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now() / 1000,
    notifyName: readNotifyName(msg),
  };
}
