/**
 * A WhatsApp delete-for-everyone and an edit, read off the protocol
 * message that carries them (2026-11-15, `message-change.ts`).
 *
 * Built with Baileys' own protobuf classes, as `inbound.test.ts` is, so a
 * field-name typo fails here and not on the Pi. Simulated numbers only.
 */
import { describe, it, expect } from "vitest";
import { proto } from "baileys";
import type { WAMessage } from "baileys";
import { isMergedEdit, readMessageChange } from "./message-change.js";
import { mapInboundMessage, skipReason } from "./inbound.js";

const GROUP = "120363000000000000@g.us";
const TARGET = "3EB0AAAABBBBCCCC0001";
const P = proto.Message.ProtocolMessage.Type;

function wa(message: Record<string, unknown> | null, key: Partial<proto.IMessageKey> = {}): WAMessage {
  return {
    key: { remoteJid: GROUP, fromMe: false, id: "3EB0NOTICE000001", participant: "447700900123@s.whatsapp.net", ...key },
    message: message === null ? null : proto.Message.fromObject(message),
    messageTimestamp: 1763200000,
    pushName: "Sam",
  } as WAMessage;
}

const revoke = (key: Record<string, unknown> = { id: TARGET, remoteJid: GROUP, fromMe: true }) => ({ protocolMessage: { key, type: P.REVOKE } });
const edit = (edited: Record<string, unknown>, id = TARGET) => ({
  protocolMessage: { key: { id, remoteJid: GROUP, fromMe: true }, type: P.MESSAGE_EDIT, editedMessage: edited, timestampMs: 1763200001000 },
});

describe("readMessageChange: a delete for everyone", () => {
  it("names the deleted message by its id, in the chat the notice came in", () => {
    expect(readMessageChange(wa(revoke()))).toEqual({ kind: "revoke", chatJid: GROUP, targetId: TARGET });
  });

  it("an admin deleting someone else's message is the same delete", () => {
    const m = wa(revoke({ id: TARGET, remoteJid: GROUP, fromMe: false, participant: "447700900456@s.whatsapp.net" }), {
      participant: "447700900999@s.whatsapp.net",
    });
    expect(readMessageChange(m)).toEqual({ kind: "revoke", chatJid: GROUP, targetId: TARGET });
  });

  it("inside a disappearing-messages wrapper too", () => {
    expect(readMessageChange(wa({ ephemeralMessage: { message: revoke() } }))).toEqual({ kind: "revoke", chatJid: GROUP, targetId: TARGET });
  });

  it("a revoke that names no message is nothing", () => {
    expect(readMessageChange(wa({ protocolMessage: { type: P.REVOKE } }))).toBeNull();
    expect(readMessageChange(wa(revoke({ id: "bad id with spaces", remoteJid: GROUP })))).toBeNull();
  });
});

describe("readMessageChange: an edit", () => {
  it("a text edited: the edited message's id only, never its new words", () => {
    const r = readMessageChange(wa(edit({ extendedTextMessage: { text: "new words" } })));
    expect(r).toEqual({ kind: "edit", chatJid: GROUP, targetId: TARGET });
  });

  it("inside the editedMessage wrapper, and an edit of a caption or of anything else", () => {
    expect(readMessageChange(wa({ editedMessage: { message: edit({ conversation: "wrapped edit" }) } }))).toMatchObject({ kind: "edit", chatJid: GROUP, targetId: TARGET });
    expect(readMessageChange(wa(edit({ imageMessage: { mimetype: "image/jpeg" } })))).toMatchObject({ kind: "edit", targetId: TARGET });
    expect(readMessageChange(wa(edit({ stickerMessage: { mimetype: "image/webp" } })))).toMatchObject({ kind: "edit", targetId: TARGET });
  });

  it("an ORIGINAL that Baileys merged its edit into (`editedMessage` holding the new content itself) is a message, not a change; `isMergedEdit` tells it apart", () => {
    const merged = wa({ editedMessage: { message: { conversation: "In" } } });
    expect(readMessageChange(merged)).toBeNull();
    expect(isMergedEdit(merged)).toBe(true);
    expect(isMergedEdit(wa(edit({ conversation: "x" })))).toBe(false);
    expect(isMergedEdit(wa({ conversation: "in" }))).toBe(false);
  });

  it("an edit that names no message is nothing", () => {
    expect(readMessageChange(wa({ protocolMessage: { type: P.MESSAGE_EDIT, editedMessage: { conversation: "x" } } }))).toBeNull();
  });
});

describe("readMessageChange: everything else is not a change", () => {
  it("ordinary messages, other protocol messages, and no content", () => {
    expect(readMessageChange(wa({ conversation: "in" }))).toBeNull();
    expect(readMessageChange(wa({ protocolMessage: { type: P.APP_STATE_SYNC_KEY_SHARE } }))).toBeNull();
    expect(readMessageChange(wa({ protocolMessage: { type: P.EPHEMERAL_SETTING, ephemeralExpiration: 86400 } }))).toBeNull();
    expect(readMessageChange(wa(null))).toBeNull();
    expect(readMessageChange({} as WAMessage)).toBeNull();
  });

  it("the live mapper still hands neither up as a chat message (it is not re-analysed)", () => {
    expect(mapInboundMessage(wa(revoke()))).toBeNull();
    expect(mapInboundMessage(wa(edit({ conversation: "edited" })))).toBeNull();
    expect(skipReason(wa(revoke()))).toMatch(/protocol message/);
  });
});
