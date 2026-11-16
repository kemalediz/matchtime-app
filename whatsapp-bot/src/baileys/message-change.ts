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
 * AN EDIT (round 4): its new content is returned for the driver to hand up
 * as the edited message, IN MEMORY ONLY: an author's edit to a message
 * still waiting in the Pi's batch replaces it there (and is analysed once);
 * an edit to a message already sent is a purge. The content is never
 * logged, written to disk or posted as a change.
 *
 * A MERGED EDIT: after a reconnect Baileys can merge an edit into the
 * original's own upsert (`Utils/event-buffer.js`), so the original arrives
 * as `editedMessage` holding the NEW content itself. That is not a change
 * but the message, in its edited form (`isMergedEdit`).
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
  /** An edit's new content. In memory only; never logged. */
  content?: proto.IMessage;
}

/** PURE. An original Baileys merged its edit into: `editedMessage` around the new content, not around an edit notice. */
export function isMergedEdit(msg: WAMessage): boolean {
  const inner = (msg?.message as { editedMessage?: { message?: proto.IMessage | null } | null } | null | undefined)?.editedMessage?.message;
  return !!inner && !inner.protocolMessage;
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
    if (type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
      return { kind: "edit", chatJid, targetId, ...(protocol.editedMessage ? { content: protocol.editedMessage } : {}) };
    }
    return null;
  } catch {
    return null;
  }
}
