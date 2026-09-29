/**
 * A message the bot could not decrypt at first (2026-09-29, match day).
 *
 * Right after a restart the admin posted "@Match Time generate the teams".
 * Baileys could not decrypt it (`No session found to decrypt message`, a
 * group sender key it did not hold) and upserted a CIPHERTEXT stub (stub
 * type 2) in its place. Baileys then sends ONE retry receipt to the sender
 * and asks our own phone for the content. Whatever answers arrives as a
 * fresh `messages.upsert` with the SAME id: `notify` for a live resend,
 * `append` if it lands in an offline batch, or `notify` with a
 * `requestId` for the phone's placeholder resend.
 *
 * These tests pin that the driver hands that later copy up whatever its
 * upsert type and age, that the stub never burns the id in the dedupe,
 * that a real duplicate is still collapsed, and that a stub nothing ever
 * answers is reported loudly instead of disappearing.
 */
import { describe, it, expect } from "vitest";
import { proto, type WAMessage } from "baileys";
import type { InboundMessage } from "../driver.js";
import { readInboundHeadline } from "../wa-read.js";
import { FakeSocket, manualScheduler } from "../baileys/fake-socket.js";
import { createBaileysConnection } from "../baileys/lifecycle.js";
import { createSessionLedger } from "../baileys/session-ledger.js";
import { UNDECRYPTABLE_GRACE_MS } from "../baileys/undecryptable.js";
import { makeBaileysDriver, type UndecryptableEvent } from "./baileys.js";

const GROUP = "447525334985-1607872139@g.us";
const ADMIN_LID = "89485761081551:59@lid";
const ADMIN_PN = "447525334985@s.whatsapp.net";
const ID = "3B878B2822E41994AF38";
const BODY = "@Match Time generate the teams. Put me on red team.";

const tick = () => new Promise((r) => setImmediate(r));
const nowSec = () => Math.floor(Date.now() / 1000);

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
  const timers = manualScheduler();
  const driver = makeBaileysDriver({
    connection: connection as never,
    schedule: timers.schedule,
    log: (l) => logs.push(l),
    error: (l) => errors.push(l),
  });
  await driver.start();
  sockets[sockets.length - 1].open();
  const got: InboundMessage[] = [];
  driver.onMessage((m) => {
    got.push(m);
  });
  const lost: UndecryptableEvent[] = [];
  driver.onUndecryptable((e) => {
    lost.push(e);
  });
  const emit = (messages: WAMessage[], type: string, requestId?: string) =>
    sockets[sockets.length - 1].emit("messages.upsert", { messages, type, ...(requestId ? { requestId } : {}) });
  return { driver, got, lost, logs, errors, timers, emit };
}

function stub(): WAMessage {
  return {
    key: { remoteJid: GROUP, fromMe: false, id: ID, participant: ADMIN_LID, participantAlt: ADMIN_PN },
    messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
    messageStubParameters: ["No session found to decrypt message"],
    messageTimestamp: nowSec() - 2,
    pushName: "Kaan",
  } as WAMessage;
}

function decrypted(extra: Partial<WAMessage> = {}): WAMessage {
  return {
    key: { remoteJid: GROUP, fromMe: false, id: ID, participant: ADMIN_LID, participantAlt: ADMIN_PN },
    message: proto.Message.fromObject({ conversation: BODY }),
    messageTimestamp: nowSec() - 2,
    pushName: "Kaan",
    ...extra,
  } as WAMessage;
}

describe("a message that failed to decrypt at first", () => {
  it("the stub is logged with Baileys' reason, not handed up, and counted", async () => {
    const t = await started();
    t.emit([stub()], "notify");
    await tick();
    expect(t.got).toHaveLength(0);
    const line = t.logs.find((l) => l.includes(ID));
    expect(line).toMatch(/could not be decrypted/);
    expect(line).toMatch(/No session found to decrypt message/);
    expect(line).toMatch(/89485761081551:59@lid/);
    expect(t.driver.stats()).toMatchObject({ undecryptable: 1, decryptRecovered: 0, decryptLost: 0 });
  });

  it("stub then decrypted notify: the copy is handed up once, and the recovery is logged", async () => {
    const t = await started();
    t.emit([stub()], "notify");
    await tick();
    t.emit([decrypted()], "notify");
    await tick();
    expect(t.got).toHaveLength(1);
    expect(readInboundHeadline(t.got[0])).toMatchObject({ from: GROUP, body: BODY });
    expect(t.logs.some((l) => /recovered/.test(l) && l.includes(ID))).toBe(true);
    expect(t.driver.stats()).toMatchObject({ undecryptable: 1, decryptRecovered: 1, delivered: 1, duplicates: 0 });
    await t.timers.runAll();
    expect(t.lost).toEqual([]);
    expect(t.errors.filter((e) => e.includes(ID))).toEqual([]);
  });

  it("stub then decrypted APPEND, minutes old: still handed up (no type or age filter)", async () => {
    const t = await started();
    t.emit([stub()], "notify");
    await tick();
    t.emit([decrypted({ messageTimestamp: nowSec() - 9 * 60 })], "append");
    await tick();
    expect(t.got).toHaveLength(1);
    expect(readInboundHeadline(t.got[0]).body).toBe(BODY);
    expect(t.driver.stats().decryptRecovered).toBe(1);
  });

  it("stub then the phone's placeholder resend (notify with a requestId): handed up", async () => {
    const t = await started();
    t.emit([stub()], "notify");
    await tick();
    t.emit([decrypted()], "notify", "PDO-1");
    await tick();
    expect(t.got).toHaveLength(1);
    expect(t.logs.some((l) => l.includes("requestId=PDO-1") && l.includes(ID))).toBe(true);
  });

  it("a stub never recovered: a CRITICAL line and one onUndecryptable event after the grace period", async () => {
    const t = await started();
    t.emit([stub()], "notify");
    await tick();
    expect(t.timers.delays()).toEqual([UNDECRYPTABLE_GRACE_MS]);
    await t.timers.runAll();
    expect(t.got).toHaveLength(0);
    expect(t.lost).toHaveLength(1);
    expect(t.lost[0]).toMatchObject({ id: ID, chat: GROUP, sender: ADMIN_LID, reason: "No session found to decrypt message" });
    const critical = t.errors.filter((e) => e.startsWith("CRITICAL") && e.includes(ID));
    expect(critical).toHaveLength(1);
    expect(critical[0]).toMatch(/lost/);
    expect(t.driver.stats()).toMatchObject({ decryptLost: 1, decryptRecovered: 0 });
  });

  it("a copy that turns up after the alert is still handed up", async () => {
    const t = await started();
    t.emit([stub()], "notify");
    await tick();
    await t.timers.runAll();
    t.emit([decrypted()], "notify");
    await tick();
    expect(t.got).toHaveLength(1);
    expect(t.logs.some((l) => /recovered late/.test(l) && l.includes(ID))).toBe(true);
  });

  it("a true duplicate is still collapsed: decrypted, decrypted again, then a stray stub", async () => {
    const t = await started();
    t.emit([decrypted()], "notify");
    t.emit([decrypted()], "append");
    t.emit([stub()], "notify");
    await tick();
    expect(t.got).toHaveLength(1);
    expect(t.driver.stats()).toMatchObject({ delivered: 1, duplicates: 1 });
    await t.timers.runAll();
    // The message WAS delivered, so a failed extra copy is not a loss.
    expect(t.lost).toEqual([]);
  });

  it("a second stub for the same id (a retry that failed again) does not double the alert", async () => {
    const t = await started();
    t.emit([stub()], "notify");
    t.emit([stub()], "notify");
    await tick();
    await t.timers.runAll();
    expect(t.lost).toHaveLength(1);
  });
});
