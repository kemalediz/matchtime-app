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

const { enqueueForAnalysis, recordHistory, applyMessageChangeLocally, replacePendingWithEdit, readGroupMessageForServer, _test_flushNow, _test_reset } = await import("./smart-analysis.js");
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
  // As index.ts wires it, the inbound-running map included.
  const running = new Map<string, Promise<void>>();
  driver.onMessage(async (msg: InboundMessage) => {
    const head = readInboundHeadline(msg);
    let done!: () => void;
    const key = `${head.from}|${resolveWaMessageId(msg).waMessageId.split("_")[2]}`;
    running.set(key, new Promise<void>((r) => (done = r)));
    try {
      if (head.fromMe || !head.from.endsWith("@g.us")) return;
      // The real handler awaits a contact lookup here; the edit must still wait for it.
      await new Promise((r) => setTimeout(r, 20));
      recordHistory(head.from, { authorName: head.notifyName ?? null, body: head.body, timestamp: new Date(head.timestampSec * 1000).toISOString() }, resolveWaMessageId(msg).waMessageId);
      await enqueueForAnalysis(driver, msg);
    } finally {
      done();
    }
  });
  driver.onMessageChange!(async (change) => {
    await handleMessageChange(change, {
      waitForInbound: async (groupId, messageId) => {
        await running.get(`${groupId}|${messageId}`);
      },
      readEdit: async (view) => {
        const r = await readGroupMessageForServer(driver, view);
        return r ? { text: r.text, botMentioned: r.botMentioned, mentions: r.mentions, mentionNames: r.mentionNames } : null;
      },
      replacePending: replacePendingWithEdit,
      applyLocally: applyMessageChangeLocally,
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
  const upsert = async (...ms: WAMessage[]) => {
    sockets[sockets.length - 1].emit("messages.upsert", { messages: ms, type: "notify" });
    for (let i = 0; i < 10; i++) await tick();
    await new Promise((r) => setTimeout(r, 60));
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

  it("'Inn' fixed to 'In' while it waits: the batch carries 'In' (with the NEW content's mentions), analysed once; nothing recorded or posted", async () => {
    const t = await wired();
    await t.upsert(wa("3EB0BAILEYS00021", { conversation: "Inn" }));
    await t.upsert(wa("3EB0NOTICE000021", editOf("3EB0BAILEYS00021", { extendedTextMessage: { text: "In, ask @158055467598022", contextInfo: { mentionedJid: [ALI_LID] } } })));
    expect(t.outbox).toEqual([]);
    await _test_flushNow(GROUP);
    expect(postAnalyzeFull).toHaveBeenCalledTimes(1);
    expect(posted().messages).toHaveLength(1);
    expect(posted().messages[0]).toMatchObject({ body: "In, ask @158055467598022", mentions: [ALI_LID] });
    expect(JSON.stringify(postAnalyzeFull.mock.calls)).not.toContain("Inn");
  });

  it("an edit arriving in the SAME upsert as its original (no wait between): still a replacement, never a race that loses the IN", async () => {
    const t = await wired();
    await t.upsert(wa("3EB0BAILEYS00023", { conversation: "Inn" }), wa("3EB0NOTICE000023", editOf("3EB0BAILEYS00023", { conversation: "In" })));
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.body)).toEqual(["In"]);
    expect(t.outbox).toEqual([]);
  });

  it("after a reconnect Baileys merged the edit into the original: 'In' is analysed once, and no purge races it", async () => {
    const t = await wired();
    await t.upsert(wa("3EB0BAILEYS00024", { editedMessage: { message: { conversation: "In" } } }), wa("3EB0NOTICE000024", editOf("3EB0BAILEYS00024", { conversation: "In" })));
    expect(t.outbox).toEqual([]);
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.body)).toEqual(["In"]);
  });

  it("an edit of a message ALREADY SENT for analysis is a purge: recorded with no words, and every later copy kept out", async () => {
    const t = await wired();
    await t.upsert(wa("3EB0BAILEYS00025", { conversation: SECRET }));
    await _test_flushNow(GROUP);
    postAnalyzeFull.mockClear();
    await t.upsert(wa("3EB0NOTICE000025", editOf("3EB0BAILEYS00025", { conversation: "my new words" })));
    expect(t.outbox).toEqual([expect.objectContaining({ kind: "edit", messageId: "3EB0BAILEYS00025", byAdmin: false })]);
    expect(JSON.stringify(t.outbox)).not.toMatch(/my new words|4321/);
    await t.upsert(wa("3EB0BAILEYS00025", { conversation: SECRET })); // a replay of the original
    await _test_flushNow(GROUP);
    expect(postAnalyzeFull).not.toHaveBeenCalled();
  });

  it("an edit by somebody else is ignored", async () => {
    const t = await wired();
    await t.upsert(wa("3EB0BAILEYS00031", { conversation: SECRET }));
    await t.upsert(wa("3EB0NOTICE000031", editOf("3EB0BAILEYS00031", { conversation: "I owe everyone £50" }), { lid: ALI_LID, pn: ALI_PN }));
    await _test_flushNow(GROUP);
    expect(posted().messages.map((m) => m.body)).toEqual([SECRET]);
  });
});
