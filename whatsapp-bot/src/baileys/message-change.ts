/**
 * A delete for everyone, or an edit, read off the protocol message that
 * carries it (2026-11-15).
 *
 * WhatsApp sends both as a `protocolMessage` (Baileys 7.0.0-rc14,
 * `Utils/process-message.js`):
 *
 *   REVOKE        `protocolMessage.key.id` is the deleted message. The
 *                 notice's own sender is whoever deleted it, which in a
 *                 group can be an ADMIN deleting somebody else's message,
 *                 so only the id is used.
 *   MESSAGE_EDIT  `protocolMessage.key.id` is the edited message and
 *                 `protocolMessage.editedMessage` its whole new content.
 *                 It usually arrives inside an `editedMessage` wrapper,
 *                 which `normalizeMessageContent` peels; an edit of an edit
 *                 is followed inwards, as the history bundle does
 *                 (`group-history-bundle.ts`).
 *
 * `mapInboundMessage` still returns null for both: neither is ever handed
 * up as a chat message, so an edit is never analysed again. The driver
 * reads this first and hands the change up on its own event.
 *
 * Pure and total: a malformed notice is null, never a throw.
 */
import { getContentType, normalizeMessageContent, proto } from "baileys";
import type { WAMessage } from "baileys";

export type ReadMessageChange =
  | { kind: "revoke"; chatJid: string; targetId: string }
  | { kind: "edit"; chatJid: string; targetId: string; text: string };

/** A WhatsApp message id: never '@', never a space (`group-history-bundle.ts`). */
const PLAUSIBLE_ID = /^[0-9A-Za-z._:-]{8,64}$/;
const MAX_EDIT_DEPTH = 3;

/** The text or caption of a message's content, trimmed; "" when there is none. */
function textOf(message: proto.IMessage | null | undefined): string {
  const content = normalizeMessageContent(message ?? undefined);
  if (!content) return "";
  const type = getContentType(content);
  if (type === "conversation") return (content.conversation ?? "").trim();
  if (type === "extendedTextMessage") return (content.extendedTextMessage?.text ?? "").trim();
  if (type === "imageMessage" || type === "videoMessage" || type === "documentMessage") {
    return ((content[type] as { caption?: string | null } | null | undefined)?.caption ?? "").trim();
  }
  return "";
}

export function readMessageChange(msg: WAMessage): ReadMessageChange | null {
  try {
    const chatJid = msg?.key?.remoteJid;
    if (!chatJid) return null;
    const protocol = normalizeMessageContent(msg.message ?? undefined)?.protocolMessage;
    if (!protocol) return null;
    const targetId = protocol.key?.id;
    if (typeof targetId !== "string" || !PLAUSIBLE_ID.test(targetId)) return null;

    // `type` is an enum whose zero is REVOKE, so an unset type decodes as
    // one; the key naming a message is what makes it a real delete.
    if ((protocol.type ?? proto.Message.ProtocolMessage.Type.REVOKE) === proto.Message.ProtocolMessage.Type.REVOKE) {
      return { kind: "revoke", chatJid, targetId };
    }
    if (protocol.type !== proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) return null;

    let content: proto.IMessage | null | undefined = protocol.editedMessage;
    for (let depth = 0; depth < MAX_EDIT_DEPTH; depth++) {
      const inner = normalizeMessageContent(content ?? undefined)?.protocolMessage?.editedMessage;
      if (!inner) break;
      content = inner;
    }
    const text = textOf(content);
    return text ? { kind: "edit", chatJid, targetId, text } : null;
  } catch {
    return null;
  }
}
