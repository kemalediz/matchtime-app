/**
 * A delete for everyone, or an edit, read off the protocol message that
 * carries it (2026-11-15).
 *
 * WhatsApp sends both as a `protocolMessage` (Baileys 7.0.0-rc14,
 * `Utils/process-message.js`):
 *
 *   REVOKE        `protocolMessage.key.id` is the deleted message. The
 *                 notice's own sender is whoever deleted it, which in a
 *                 group can be an ADMIN deleting somebody else's message.
 *   MESSAGE_EDIT  `protocolMessage.key.id` is the edited message. It usually
 *                 arrives inside an `editedMessage` wrapper, which
 *                 `normalizeMessageContent` peels.
 *
 * AN EDIT IS A PURGE (round 3): MatchTime forgets the original words of an
 * edited message and never keeps the new ones, so only WHICH message was
 * edited is read here. The new content is never read, returned or logged.
 *
 * `mapInboundMessage` still returns null for both: neither is ever handed
 * up as a chat message, so an edit is never analysed. The driver reads this
 * first and hands the change up on its own event.
 *
 * Pure and total: a malformed notice is null, never a throw.
 */
import { normalizeMessageContent, proto } from "baileys";
import type { WAMessage } from "baileys";

export interface ReadMessageChange {
  kind: "revoke" | "edit";
  chatJid: string;
  targetId: string;
}

/** A WhatsApp message id: never '@', never a space (`group-history-bundle.ts`). */
const PLAUSIBLE_ID = /^[0-9A-Za-z._:-]{8,64}$/;

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
    const type = protocol.type ?? proto.Message.ProtocolMessage.Type.REVOKE;
    if (type === proto.Message.ProtocolMessage.Type.REVOKE) return { kind: "revoke", chatJid, targetId };
    if (type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) return { kind: "edit", chatJid, targetId };
    return null;
  } catch {
    return null;
  }
}
