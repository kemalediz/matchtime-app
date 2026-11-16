/**
 * The Baileys driver hands a delete-for-everyone and an edit up on their
 * own event, `onMessageChange`, and NEVER as a chat message (2026-11-15).
 * Against a fake socket: no WhatsApp connection, no send. Simulated
 * numbers and made-up people.
 */
import { describe, it, expect } from "vitest";
import { proto, type WAMessage } from "baileys";
import type { InboundMessage, MessageChangeEvent } from "../driver.js";
import { FakeSocket, manualScheduler } from "../baileys/fake-socket.js";
import { createBaileysConnection } from "../baileys/lifecycle.js";
import { createSessionLedger } from "../baileys/session-ledger.js";
import { makeBaileysDriver } from "./baileys.js";

const GROUP = "120363000000000000@g.us";
const PLAYER_PN = "447700900123@s.whatsapp.net";
const PLAYER_LID = "158055467598020@lid";
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
    await tick();
    await tick();
  };
  return { driver, changes, messages, logs, errors, upsert };
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
const edit = (text: string) => ({
  editedMessage: { message: { protocolMessage: { key: { id: TARGET, remoteJid: GROUP, fromMe: true }, type: P.MESSAGE_EDIT, editedMessage: { conversation: text } } } },
});

describe("onMessageChange", () => {
  it("a group delete: handed up with the deleted id and the group, never as a message", async () => {
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
        fromMe: false,
      },
    ]);
  });

  it("a group edit: the new text travels on the event, and the log line never carries it", async () => {
    const t = await started();
    await t.upsert(wa(edit("my new secret words")));
    expect(t.messages).toEqual([]);
    expect(t.changes).toHaveLength(1);
    expect(t.changes[0]).toMatchObject({ kind: "edit", chatId: GROUP, messageId: TARGET, text: "my new secret words", senderPhone: "447700900123" });
    expect([...t.logs, ...t.errors].join("\n")).not.toContain("secret");
    expect(t.logs.some((l) => /an edit of 3EB0AAAABBBBCCCC0001/.test(l))).toBe(true);
  });

  it("a delete MatchTime's own phone made (an admin on the bot's number) is still handed up", async () => {
    const t = await started();
    await t.upsert(wa(revoke, { fromMe: true, participant: undefined, participantAlt: undefined }));
    expect(t.changes).toHaveLength(1);
    expect(t.changes[0]).toMatchObject({ kind: "revoke", fromMe: true, messageId: TARGET });
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
    expect(t.changes).toEqual([
      expect.objectContaining({ kind: "revoke", chatId: "447700900123@c.us", isGroup: false, messageId: TARGET }),
    ]);
  });

  it("an ordinary message is still a message, and not a change", async () => {
    const t = await started();
    await t.upsert(wa({ conversation: "in" }, { id: "3EB0ORDINARY0001" }));
    expect(t.changes).toEqual([]);
    expect(t.messages).toHaveLength(1);
  });
});
