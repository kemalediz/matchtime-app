/**
 * A Baileys `WAMessage`, dressed as the message the bot has always read.
 *
 * ── Why a view, not a rewrite of the readers ────────────────────────
 * Phase 2 left the inbound message opaque (`driver.ts`, `InboundMessage`):
 * everything above the seam reads it through the total helpers in
 * `wa-read.ts` and `message-id.ts`, which know whatsapp-web.js's field
 * names. Changing those readers would change the whatsapp-web.js path
 * too, and Phase 2's promise is that the swap is one env var. So the
 * Baileys driver hands up an object with exactly those names:
 *
 *   id._serialized   `serializeKey(msg.key)`, the string the database
 *                    already holds for the same message (plan §2.5)
 *   from             the chat, in `@c.us` / `@lid` / `@g.us` spelling
 *   author           the group sender; the RESOLVED phone JID when the
 *                    envelope or the local store knew it (plan §2.7), so
 *                    `phoneFromAuthor` hands the server a phone rather than
 *                    leaving it to fuzzy-match a name. The unresolved LID
 *                    otherwise, never a guess from its digits
 *   fromMe, type, body, hasMedia, timestamp, mentionedIds
 *   _data.body, _data.notifyName   so `readMessageBody` / `readNotifyName`,
 *                    the degraded-path identity, read the pushname
 *
 * The id deliberately names the KEY, not the person: a LID participant
 * stays a LID in `id`, because reactions to this message will arrive
 * keyed the same way and the join is by exact string.
 *
 * The raw `WAMessage` rides along under a Symbol, for `replyTo`, which
 * must quote all of it. Symbol-keyed, so a stringified view never carries
 * the protobuf into a log line.
 *
 * Pure. No Baileys runtime import.
 */
import type { WAMessage } from "baileys";
import type { InboundMessage } from "../driver.js";
import { legacyJid, serializeKey } from "./key.js";
import type { MappedInbound } from "./inbound.js";

export const BAILEYS_RAW: unique symbol = Symbol.for("matchtime.baileys.raw") as never;

export interface BaileysInboundView extends InboundMessage {
  id?: { _serialized: string };
  from: string;
  author?: string;
  fromMe: boolean;
  type: string;
  body: string;
  hasMedia: boolean;
  timestamp?: number;
  mentionedIds: string[];
  _data: { body: string; notifyName?: string };
  /** Driver-side facts, for the log and for contactOf. Not read above the seam. */
  baileys: {
    upsertType: string;
    /** The sender as addressed on the wire, legacy spelling. */
    senderJid: string | null;
    /** Digits, when resolved. */
    senderPhone: string | null;
    pushName: string | null;
  };
  [BAILEYS_RAW]: WAMessage;
}

export function buildInboundView(
  raw: WAMessage,
  mapped: MappedInbound,
  extra: { upsertType: string; senderPhone: string | null },
): BaileysInboundView {
  const serialized = serializeKey(mapped.key);
  const senderJid = legacyJid(mapped.senderJid);
  const view: BaileysInboundView = {
    from: legacyJid(mapped.chatJid) ?? mapped.chatJid,
    fromMe: mapped.fromMe,
    type: mapped.type,
    body: mapped.body,
    hasMedia: mapped.hasMedia,
    mentionedIds: mapped.mentionedJids.map((j) => legacyJid(j) ?? j),
    _data: { body: mapped.body },
    baileys: {
      upsertType: extra.upsertType,
      senderJid,
      senderPhone: extra.senderPhone,
      pushName: mapped.pushName,
    },
    [BAILEYS_RAW]: raw,
  };
  if (serialized) view.id = { _serialized: serialized };
  // A missing timestamp stays missing, so the readers fall back to "now"
  // rather than to 1970.
  if (mapped.timestampSec > 0) view.timestamp = mapped.timestampSec;
  if (mapped.pushName) view._data.notifyName = mapped.pushName;
  if (mapped.isGroup && !mapped.fromMe) {
    const author = extra.senderPhone ? `${extra.senderPhone}@c.us` : senderJid;
    if (author) view.author = author;
  }
  return view;
}

/**
 * The raw `WAMessage` behind a view, or the argument itself when it
 * already is one, or null.
 */
export function rawOf(msg: unknown): WAMessage | null {
  if (!msg || typeof msg !== "object") return null;
  const carried = (msg as Record<symbol, unknown>)[BAILEYS_RAW];
  if (carried && typeof carried === "object") return carried as WAMessage;
  const key = (msg as { key?: { remoteJid?: unknown } }).key;
  return key && typeof key.remoteJid === "string" ? (msg as WAMessage) : null;
}
