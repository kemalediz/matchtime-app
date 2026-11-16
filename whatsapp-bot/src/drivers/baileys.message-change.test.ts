/**
 * The Baileys driver hands a delete-for-everyone and an edit up on their
 * own event, `onMessageChange`, and NEVER as a chat message (2026-11-15).
 * Round 2: whether the sender is a group admin (read from the group's
 * metadata), and an edit's new content as a message, so its mentions are
 * read the way an inbound message's are. Against a fake socket: no
 * WhatsApp connection, no send. Simulated numbers and made-up people.
 */
import { describe, it, expect } from "vitest";
import { proto, type GroupMetadata, type WAMessage } from "baileys";
import type { InboundMessage, MessageChangeEvent } from "../driver.js";
import { FakeSocket, manualScheduler } from "../baileys/fake-socket.js";
import { createBaileysConnection } from "../baileys/lifecycle.js";
import { createSessionLedger } from "../baileys/session-ledger.js";
import { makeBaileysDriver } from "./baileys.js";

const GROUP = "120363000000000000@g.us";
const PLAYER_PN = "447700900123@s.whatsapp.net";
const PLAYER_LID = "158055467598020@lid";
const ADMIN_LID = "158055467598021@lid";
const ADMIN_PN = "447700900124@s.whatsapp.net";
const TARGET = "3EB0AAAABBBBCCCC0001";
const P = proto.Message.ProtocolMessage.Type;
const tick = () => new Promise((r) => setImmediate(r));

async function started() {
  const sockets: FakeSocket[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const connection = createBaileysConnection<FakeSocket>({
    makeSocket: () => {
      const s = new FakeSocket();
      s.groups[GROUP] = {
        id: GROUP,
        subject: "Sim FC",
        addressingMode: "lid",
        participants: [
          { id: PLAYER_LID, phoneNumber: PLAYER_PN, admin: null },
          { id: ADMIN_LID, phoneNumber: ADMIN_PN, admin: "admin" },
          { id: "158000000000001@lid", phoneNumber: "447700900001@s.whatsapp.net", admin: "admin" },
        ],
      } as unknown as GroupMetadata;
      sockets.push(s);
      return s;
    },
    pairPhone: "",
    ledger: createSessionLedger({ load: () => null, save: () => {} }),
    printQr: () => {},
    schedule: manualScheduler().schedule,
    exit: () => {},
    log: (l) => logs.push(l),
    error: (l) => errors.push(l),
  });
  const driver = makeBaileysDriver({ connection: connection as never, log: (l) => logs.push(l), error: (l) => errors.push(l) });
  await driver.start();
  sockets[sockets.length - 1].open();
  const changes: MessageChangeEvent[] = [];
  const messages: InboundMessage[] = [];
  driver.onMessageChange!((c) => {
    changes.push(c);
  });
  driver.onMessage((m) => {
    messages.push(m);
  });
  const upsert = async (m: WAMessage) => {
    sockets[sockets.length - 1].emit("messages.upsert", { messages: [m], type: "notify" });
    for (let i = 0; i < 6; i++) await tick();
  };
  return { driver, changes, messages, logs, errors, upsert, sock: () => sockets[sockets.length - 1] };
}

function wa(message: Record<string, unknown>, key: Partial<proto.IMessageKey> = {}): WAMessage {
  return {
    key: { remoteJid: GROUP, fromMe: false, id: "3EB0NOTICE000001", participant: PLAYER_LID, participantAlt: PLAYER_PN, ...key },
    message: proto.Message.fromObject(message),
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Sam",
  } as WAMessage;
}

const revoke = { protocolMessage: { key: { id: TARGET, remoteJid: GROUP, fromMe: true }, type: P.REVOKE } };
const editOf = (edited: Record<string, unknown>) => ({
  editedMessage: { message: { protocolMessage: { key: { id: TARGET, remoteJid: GROUP, fromMe: true }, type: P.MESSAGE_EDIT, editedMessage: edited } } },
});
const edit = (text: string) => editOf({ conversation: text });

describe("onMessageChange", () => {
  it("a group delete: handed up with the deleted id, the group and who sent it, never as a message", async () => {
    const t = await started();
    await t.upsert(wa(revoke));
    expect(t.messages).toEqual([]);
    expect(t.changes).toEqual([
      {
        kind: "revoke",
        chatId: GROUP,
        isGroup: true,
        messageId: TARGET,
        senderJids: [PLAYER_LID, "447700900123@c.us"],
        senderPhone: "447700900123",
        byAdmin: false,
        fromMe: false,
      },
    ]);
  });

  it("a delete by a group admin says so (read from the group's metadata)", async () => {
    const t = await started();
    await t.upsert(wa(revoke, { participant: ADMIN_LID, participantAlt: ADMIN_PN }));
    expect(t.changes[0]).toMatchObject({ kind: "revoke", byAdmin: true, senderJids: [ADMIN_LID, "447700900124@c.us"] });
  });

  it("with no group metadata to read, a delete's admin status is UNKNOWN (kept to be checked again), never 'not an admin' for good", async () => {
    const t = await started();
    await t.upsert(wa(revoke, { remoteJid: "120363000000009999@g.us", participant: ADMIN_LID, participantAlt: ADMIN_PN }));
    expect(t.changes[0]).toMatchObject({ kind: "revoke", byAdmin: false, adminUnknown: true });
  });

  it("isGroupAdmin answers the re-check: true, false, or null when it still cannot be read", async () => {
    const t = await started();
    expect(await t.driver.isGroupAdmin!(GROUP, [ADMIN_LID])).toBe(true);
    expect(await t.driver.isGroupAdmin!(GROUP, [PLAYER_LID])).toBe(false);
    t.sock().groupError = new Error("rate-overlimit");
    expect(await t.driver.isGroupAdmin!("120363000000009999@g.us", [ADMIN_LID])).toBeNull();
  });

  it("a group edit: handed up with the edited message as an in-memory view (its id, the new words and mentions); never an admin's; never logged", async () => {
    const t = await started();
    const calls = t.sock().metadataCalls.length;
    await t.upsert(wa(editOf({ extendedTextMessage: { text: "my new secret words @447700900456", contextInfo: { mentionedJid: ["447700900456@s.whatsapp.net"] } } }), { participant: ADMIN_LID, participantAlt: ADMIN_PN }));
    expect(t.messages).toEqual([]);
    expect(t.changes).toEqual([
      expect.objectContaining({ kind: "edit", chatId: GROUP, isGroup: true, messageId: TARGET, senderJids: [ADMIN_LID, "447700900124@c.us"], senderPhone: "447700900124", byAdmin: false, fromMe: false }),
    ]);
    const view = t.changes[0].edited as unknown as { body: string; from: string; mentionedIds: string[]; id: { _serialized: string } };
    expect(view.body).toBe("my new secret words @447700900456");
    expect(view.mentionedIds).toEqual(["447700900456@c.us"]);
    expect(view.id._serialized).toContain(TARGET);
    // No admin lookup for an edit: only its author may edit.
    expect(t.sock().metadataCalls.length).toBe(calls);
    expect([...t.logs, ...t.errors].join("\n")).not.toContain("secret");
    expect(t.logs.some((l) => /an edit of 3EB0AAAABBBBCCCC0001/.test(l))).toBe(true);
  });

  it("after a reconnect Baileys merges the edit into the original: the original is handed up ONCE with the new words, AND the notice behind it is handed up as an edit (recorded, posted)", async () => {
    const t = await started();
    const original = wa({ editedMessage: { message: { conversation: "In" } } }, { id: TARGET });
    const notice = wa(edit("In"), { id: "3EB0NOTICE000077" });
    t.sock().emit("messages.upsert", { messages: [original, notice], type: "notify" });
    for (let i = 0; i < 10; i++) await tick();
    expect(t.messages).toHaveLength(1);
    expect((t.messages[0] as unknown as { body: string }).body).toBe("In");
    expect(t.changes).toEqual([expect.objectContaining({ kind: "edit", messageId: TARGET })]);
  });

  it("an edit carries its own time", async () => {
    const t = await started();
    const at = 1_763_200_123_000;
    await t.upsert(wa({ protocolMessage: { key: { id: TARGET, remoteJid: GROUP, fromMe: true }, type: P.MESSAGE_EDIT, editedMessage: { conversation: "x" }, timestampMs: at } }));
    expect(t.changes[0].editedAtMs).toBe(at);
  });

  it("a delete from MatchTime's own phone (an admin on the bot's number) is handed up, as an admin's", async () => {
    const t = await started();
    await t.upsert(wa(revoke, { fromMe: true, participant: undefined, participantAlt: undefined }));
    expect(t.changes).toHaveLength(1);
    expect(t.changes[0]).toMatchObject({ kind: "revoke", fromMe: true, messageId: TARGET, byAdmin: true });
    expect(t.changes[0].senderJids).toEqual(expect.arrayContaining(["447700900001@c.us", "158000000000001@lid"]));
  });

  it("our own edits are not handed up: MatchTime's words are not a member's", async () => {
    const t = await started();
    await t.upsert(wa(edit("ours"), { fromMe: true }));
    expect(t.changes).toEqual([]);
    expect(t.messages).toEqual([]);
  });

  it("a DM delete is handed up as a DM, in the phone spelling the bot uses", async () => {
    const t = await started();
    await t.upsert(wa(revoke, { remoteJid: PLAYER_PN, participant: undefined, participantAlt: undefined }));
    expect(t.changes).toEqual([expect.objectContaining({ kind: "revoke", chatId: "447700900123@c.us", isGroup: false, messageId: TARGET, byAdmin: false })]);
  });

  it("an ordinary message is still a message, and not a change", async () => {
    const t = await started();
    await t.upsert(wa({ conversation: "in" }, { id: "3EB0ORDINARY0001" }));
    expect(t.changes).toEqual([]);
    expect(t.messages).toHaveLength(1);
  });
});
