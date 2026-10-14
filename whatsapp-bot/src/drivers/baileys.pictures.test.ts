/**
 * The picture hook in the Baileys driver's message handler: a picture the
 * reader wants is handed up by the reader (once, possibly with a
 * transcript); everything else, and every picture when there is no
 * reader, is handed up exactly as before. Fake socket, stub reader.
 */
import { describe, expect, it, vi } from "vitest";
import { proto, type WAMessage } from "baileys";
import type { InboundMessage } from "../driver.js";
import { FakeSocket, manualScheduler } from "../baileys/fake-socket.js";
import { createBaileysConnection } from "../baileys/lifecycle.js";
import { createSessionLedger } from "../baileys/session-ledger.js";
import { createPictureReader, type PictureReader } from "../picture-reader.js";
import { makeBaileysDriver } from "./baileys.js";

const GROUP = "120363000000000000@g.us";
const PLAYER_PN = "447700900123@s.whatsapp.net";
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

async function started(pictures?: PictureReader | null) {
  const sockets: FakeSocket[] = [];
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
    log: () => {},
    error: () => {},
  });
  const driver = makeBaileysDriver({ connection: connection as never, log: () => {}, error: () => {}, pictures });
  await driver.start();
  sockets[0].open();
  const got: InboundMessage[] = [];
  driver.onMessage((m) => {
    got.push(m);
  });
  return { sock: sockets[0], got };
}

function wa(message: Record<string, unknown>, id: string): WAMessage {
  return {
    key: { remoteJid: GROUP, fromMe: false, id, participant: PLAYER_PN },
    message: proto.Message.fromObject(message),
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Sam",
  } as WAMessage;
}

const IMAGE = { imageMessage: { caption: "Friday list", mimetype: "image/jpeg" } };

function stubReader(transcript: string | null) {
  const download = vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  const reader = createPictureReader({
    isMonitored: (g) => g === GROUP,
    check: async () => ({ read: true }),
    download,
    shrink: async (b) => ({ data: b, mediaType: "image/jpeg" }),
    read: async () => ({ read: true, transcript }),
    log: () => {},
  });
  return { reader, download };
}

describe("the picture hook in the message handler", () => {
  it("no reader: a picture is handed up at once with its caption, as before", async () => {
    const t = await started();
    t.sock.emit("messages.upsert", { messages: [wa(IMAGE, "PIC1")], type: "notify" });
    await settle();
    expect(t.got).toHaveLength(1);
    expect((t.got[0] as { body: string }).body).toBe("Friday list");
  });

  it("a wanted picture is handed up once, by the reader, with the transcript under the caption", async () => {
    const { reader, download } = stubReader("[Picture] Poster: 1. Ali 2. Ben");
    const t = await started(reader);
    t.sock.emit("messages.upsert", { messages: [wa(IMAGE, "PIC2")], type: "notify" });
    await settle();
    expect(download).toHaveBeenCalledTimes(1);
    expect(t.got).toHaveLength(1);
    const v = t.got[0] as { body: string; type: string; id: { _serialized: string } };
    expect(v.body).toBe("Friday list\n[Picture] Poster: 1. Ali 2. Ben");
    expect(v.type).toBe("image");
    expect(v.id._serialized).toContain("PIC2");
  });

  it("a text message never goes near the reader", async () => {
    const { reader, download } = stubReader("[Picture] x");
    const wants = vi.spyOn(reader, "wants");
    const t = await started(reader);
    t.sock.emit("messages.upsert", { messages: [wa({ conversation: "in" }, "TXT1")], type: "notify" });
    await settle();
    expect(t.got).toHaveLength(1);
    expect((t.got[0] as { body: string }).body).toBe("in");
    expect(download).not.toHaveBeenCalled();
    expect(wants).toHaveBeenCalledTimes(1);
  });
});
