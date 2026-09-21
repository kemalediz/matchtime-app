/**
 * One inbound Baileys message, flattened into something the rest of the
 * bot can read without knowing what a protobuf is.
 *
 * ── The contrast worth appreciating ─────────────────────────────────
 * `wa-read.ts` exists because whatsapp-web.js's injected page code turns
 * `msg.body`, `msg.from` and `msg.id` into THROWING GETTERS when the live
 * WhatsApp Web build moves underneath it, and an unguarded read took the
 * whole message with it (`MDs/whatsapp-layer-independent-audit-2026-08-30.md`).
 * There is nothing like that here. A Baileys `WAMessage` is a decoded
 * protobuf: plain data, already in this process, with nothing to be out of
 * step with. The defensive reads are gone because the hazard is gone.
 *
 * What replaces them are two much smaller hazards, both real:
 *
 *   1. `normalizeMessageContent` must run BEFORE `getContentType`. An
 *      ephemeral, view-once, device-sent or caption-wrapped message hides
 *      the real content one level down, and without the unwrap a perfectly
 *      ordinary "in" typed in a disappearing-messages group reads as an
 *      unknown type and is silently dropped.
 *   2. Protobuf numbers are `Long`, not `number`. `messageTimestamp` and
 *      `fileLength` both are. `String(long)` and `long > x` do not do what
 *      they look like they do.
 *
 * ── Type names ──────────────────────────────────────────────────────
 * The `type` field deliberately reuses whatsapp-web.js's vocabulary
 * (`chat`, `ptt`, `audio`, `image`, `video`, `document`, `sticker`). The
 * DM nudge in `index.ts` already switches on exactly those strings, so one
 * classifier serves both drivers and the cutover does not need to touch it.
 */
import { getContentType, normalizeMessageContent } from "baileys";
import type { WAMessage, WAMessageKey } from "baileys";
import { isGroupJid } from "./jid.js";

export interface MappedInbound {
  /** The bare WhatsApp id. Always present; this is not whatsapp-web.js. */
  id: string;
  /** The whole key, kept because a reaction cannot be sent without it. */
  key: WAMessageKey;
  chatJid: string;
  /** Who sent it: `participant` in a group, `remoteJid` in a DM. */
  senderJid: string | null;
  isGroup: boolean;
  fromMe: boolean;
  /** whatsapp-web.js's type vocabulary, so one classifier serves both. */
  type: string;
  /** Text, or a media caption, trimmed. Empty for captionless media. */
  body: string;
  hasMedia: boolean;
  /** The sender's self-set profile name, or null. */
  pushName: string | null;
  /** Unix seconds. Normalised out of a protobuf Long. */
  timestampSec: number;
  /** Raw mentioned JIDs. Names are NOT resolved here; see mentions.ts. */
  mentionedJids: string[];
}

/**
 * A protobuf `Long`, a number, or nothing, as a number.
 *
 * `fileLength` and `messageTimestamp` are `Long` in practice, and a `Long`
 * compares and stringifies to something that is not the value.
 */
export function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof (v as { toNumber?: unknown }).toNumber === "function") {
    return (v as { toNumber: () => number }).toNumber();
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Media node shapes we read a caption and a mimetype off. */
interface MediaNode {
  caption?: string | null;
  mimetype?: string | null;
  ptt?: boolean | null;
}

/**
 * Map one message, or null if there is nothing here worth forwarding.
 *
 * Returns null for: a message that failed to decrypt (no content), a
 * message with no id, an empty or whitespace-only text, and every content
 * type this phase does not handle (reactions, which arrive on their own
 * event; protocol messages, which are edits and deletes; polls, locations,
 * contact cards). Those are later phases and must not be mistaken for text.
 *
 * Never throws. A malformed message is worth dropping; it is not worth
 * taking the upsert handler down, which would drop the rest of the batch
 * with it.
 */
export function mapInboundMessage(msg: WAMessage): MappedInbound | null {
  try {
    const key = msg?.key;
    const id = key?.id;
    const chatJid = key?.remoteJid;
    if (!id || !chatJid) return null;

    // The unwrap comes first. See the header.
    const content = normalizeMessageContent(msg.message);
    if (!content) return null;
    const contentType = getContentType(content);
    if (!contentType) return null;
    // `proto.IMessage` has a named field per content type and no index
    // signature, while `getContentType` hands us the name as a string.
    // One cast here beats one per lookup.
    const bag = content as unknown as Record<string, unknown>;

    const isGroup = isGroupJid(chatJid);
    const base = {
      id,
      key,
      chatJid,
      senderJid: key.participant || (isGroup ? null : chatJid),
      isGroup,
      fromMe: key.fromMe === true,
      pushName: msg.pushName?.trim() || null,
      timestampSec: toNumber(msg.messageTimestamp),
      mentionedJids: readMentions(bag, contentType),
    };

    if (contentType === "conversation" || contentType === "extendedTextMessage") {
      const raw =
        contentType === "conversation" ? content.conversation : content.extendedTextMessage?.text;
      const body = (raw || "").trim();
      // An empty text is a shape we do not understand, not a message.
      if (!body) return null;
      return { ...base, type: "chat", body, hasMedia: false };
    }

    const type = mediaTypeName(contentType, bag);
    if (!type) return null;

    const node = bag[contentType] as MediaNode | undefined;
    return { ...base, type, body: (node?.caption || "").trim(), hasMedia: true };
  } catch {
    // Total, deliberately. One odd message must not cost the batch.
    return null;
  }
}

/** whatsapp-web.js's name for this media type, or null if we skip it. */
function mediaTypeName(contentType: string, content: Record<string, unknown>): string | null {
  switch (contentType) {
    case "audioMessage":
      // whatsapp-web.js called a voice note "ptt" and ordinary audio
      // "audio", and the DM nudge in index.ts switches on both.
      return (content.audioMessage as MediaNode | undefined)?.ptt ? "ptt" : "audio";
    case "imageMessage":
      return "image";
    case "videoMessage":
    case "ptvMessage": // a round video note
      return "video";
    case "documentMessage":
      return "document";
    case "stickerMessage":
      return "sticker";
    default:
      return null;
  }
}

/**
 * The mentioned JIDs, raw.
 *
 * Deliberately NOT resolved to names here. `mentions.ts` measured what
 * happens when the Pi pastes a mentioned person's pushname into the
 * analyser's input: "@Shahrokh Sutton Football Club" arrived as "@DC" and
 * a real drop was classified as noise. The raw token travels, and the
 * server checks any name against the org roster.
 */
function readMentions(content: Record<string, unknown>, contentType: string): string[] {
  const node = content[contentType] as { contextInfo?: { mentionedJid?: string[] | null } } | undefined;
  const list = node?.contextInfo?.mentionedJid;
  return Array.isArray(list) ? list.filter((j): j is string => typeof j === "string") : [];
}
