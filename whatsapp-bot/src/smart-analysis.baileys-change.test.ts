/**
 * THE BAILEYS PATH, END TO END ON THE PI (2026-11-15, round 2).
 *
 * The batch tests in `smart-analysis.message-change.test.ts` drive the old
 * whatsapp-web.js driver. This drives the LIVE one: the Baileys driver over
 * a fake socket, wired as `index.ts` wires it (recent chat, then the batch;
 * the change handler with the real local record and the real edit reader),
 * and reads what the next analyze POST carries. No WhatsApp connection, no
 * send, no server: the post is a mock. Simulated numbers, made-up people.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { proto, type GroupMetadata, type WAMessage } from "baileys";
import type { InboundMessage } from "./driver.js";
import { FakeSocket, manualScheduler } from "./baileys/fake-socket.js";
import { createBaileysConnection } from "./baileys/lifecycle.js";
import { createSessionLedger } from "./baileys/session-ledger.js";
import { makeBaileysDriver } from "./drivers/baileys.js";
import { readInboundHeadline } from "./wa-read.js";
import { resolveWaMessageId } from "./message-id.js";

const postAnalyzeFull = vi.fn();
vi.mock("./api.js", () => ({
  postAnalyzeFull: (...args: unknown[]) => postAnalyzeFull(...args),
  releaseInstruction: async () => {},
  ackInstruction: async () => {},
}));

const { enqueueForAnalysis, recordHistory, applyMessageChangeLocally, readGroupMessageForServer, _test_flushNow, _test_reset } = await import("./smart-analysis.js");
const { handleMessageChange } = await import("./message-change.js");

const GROUP = "120363000000007700@g.us";
const SAM_PN = "447700900123@s.whatsapp.net";
const SAM_LID = "158055467598020@lid";
const ALI_PN = "447700900456@s.whatsapp.net";
const ALI_LID = "158055467598022@lid";
const P = proto.Message.ProtocolMessage.Type;
const tick = () => new Promise((r) => setImmediate(r));
const SECRET = "my door code is 4321";

async function wired() {
  const sockets: FakeSocket[] = [];
  const connection = createBaileysConnection<FakeSocket>({
    makeSocket: () => {
      const s = new FakeSocket();
      s.groups[GROUP] = {
        id: GROUP,
        subject: "Sim FC",
        addressingMode: "lid",
        participants: [
          { id: SAM_LID, phoneNumber: SAM_PN, admin: null },
          { id: ALI_LID, phoneNumber: ALI_PN, admin: null },
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
    log: () => {},
    error: () => {},
  });
  const driver = makeBaileysDriver({ connection: connection as never, log: () => {}, error: () => {} });
  await driver.start();
  sockets[sockets.length - 1].open();
  const outbox: unknown[] = [];
  // As index.ts wires it.
  driver.onMessage(async (msg: InboundMessage) => {
    const head = readInboundHeadline(msg);
    if (head.fromMe || !head.from.endsWith("@g.us")) return;
    recordHistory(head.from, { authorName: head.notifyName ?? null, body: head.body, timestamp: new Date(head.timestampSec * 1000).toISOString() }, resolveWaMessageId(msg).waMessageId);
    await enqueueForAnalysis(driver, msg);
  });
  driver.onMessageChange!(async (change) => {
    await handleMessageChange(change, {
      applyLocally: applyMessageChangeLocally,
      readEdit: async (view) => {
        const r = await readGroupMessageForServer(driver, view);
        return r ? { text: r.text, botMentioned: r.botMentioned, mentions: r.mentions, mentionNames: r.mentionNames } : null;
      },
      record: (c) => {
        outbox.push(c);
        return "k";
      },
      attempt: async () => true,
      whenFlushIdle: async () => true,
      log: () => {},
      error: () => {},
    });
  });
  const upsert = async (m: WAMessage) => {
    sockets[sockets.length - 1].emit("messages.upsert", { messages: [m], type: "notify" });
    for (let i = 0; i < 10; i++) await tick();
  };
  return { driver, upsert, outbox };
}

function wa(id: string, message: Record<string, unknown>, from: { lid: string; pn: string } = { lid: SAM_LID, pn: SAM_PN }): WAMessage {
  return {
    key: { remoteJid: GROUP, fromMe: false, id, participant: from.lid, participantAlt: from.pn },
    message: proto.Message.fromObject(message),
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: from.lid === SAM_LID ? "Sam" : "Ali",
  } as WAMessage;
}
const revokeOf = (id: string) => ({ protocolMessage: { key: { id, remoteJid: GROUP, fromMe: true }, type: P.REVOKE } });
const editOf = (id: string, edited: Record<string, unknown>) => ({
  editedMessage: { message: { protocolMessage: { key: { id, remoteJid: GROUP, fromMe: true }, type: P.MESSAGE_EDIT, editedMessage: edited } } },
});
const posted = () => postAnalyzeFull.mock.calls[0][0] as { messages: Array<Record<string, unknown>>; history: Array<Record<string, unknown>> };

beforeEach(() => {
  postAnalyzeFull.mockReset();
  postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
  _test_reset();
});

describe("the Baileys driver, the local record and the batch together", () => {
  it("a delete by its author: the next analyze POST carries none of the words, in the batch, the recent chat or a reply's quote", async () => {
    const t = await wired();
    await t.upsert(wa("3EB0BAILEYS00001", { conversation: SECRET }));
    await t.upsert(
      wa(
        "3EB0BAILEYS00002",
        { extendedTextMessage: { text: "is that right?", contextInfo: { stanzaId: "3EB0BAILEYS00001", participant: SAM_LID, quotedMessage: { conversation: SECRET } } } },
        { lid: ALI_LID, pn: ALI_PN },
      ),
    );
    await t.upsert(wa("3EB0NOTICE000001", revokeOf("3EB0BAILEYS00001")));
    expect(t.outbox).toEqual([expect.objectContaining({ kind: "revoke", messageId: "3EB0BAILEYS00001", byAdmin: false })]);
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.body)).toEqual(["is that right?"]);
    expect(JSON.stringify(postAnalyzeFull.mock.calls)).not.toContain("4321");
  });

  it("a delete by somebody else who is no admin changes nothing", async () => {
    const t = await wired();
    await t.upsert(wa("3EB0BAILEYS00011", { conversation: SECRET }));
    await t.upsert(wa("3EB0NOTICE000011", revokeOf("3EB0BAILEYS00011"), { lid: ALI_LID, pn: ALI_PN }));
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.body)).toEqual([SECRET]);
  });

  it("an edit by its author: the batch carries the new words and the mentions read from the NEW content", async () => {
    const t = await wired();
    await t.upsert(wa("3EB0BAILEYS00021", { conversation: SECRET }));
    await t.upsert(
      wa("3EB0NOTICE000021", editOf("3EB0BAILEYS00021", { extendedTextMessage: { text: "ask @158055467598022", contextInfo: { mentionedJid: [ALI_LID] } } })),
    );
    await _test_flushNow(GROUP);
    const m = posted().messages[0];
    expect(m.body).toBe("ask @158055467598022");
    expect(m.mentions).toEqual([ALI_LID]);
    expect(posted().history.map((h) => h.body)).toEqual(["ask @158055467598022"]);
    expect(JSON.stringify(posted())).not.toContain("4321");
  });

  it("an edit by somebody else is ignored", async () => {
    const t = await wired();
    await t.upsert(wa("3EB0BAILEYS00031", { conversation: SECRET }));
    await t.upsert(wa("3EB0NOTICE000031", editOf("3EB0BAILEYS00031", { conversation: "I owe everyone £50" }), { lid: ALI_LID, pn: ALI_PN }));
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.body)).toEqual([SECRET]);
  });
});
