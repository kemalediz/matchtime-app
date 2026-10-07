/**
 * The history diagnostic, wired into the driver: it LOGS and does nothing
 * else.
 *
 * The formatting is pinned in `baileys/history-sync.test.ts`. What is
 * pinned here is the promise that matters on a live club's group: nothing
 * the diagnostic sees is remembered for the catch-up, handed to the
 * analyzer, or printed as text.
 */
import { describe, it, expect } from "vitest";
import { proto, type WAMessage } from "baileys";
import { FakeSocket, manualScheduler } from "../baileys/fake-socket.js";
import { createBaileysConnection } from "../baileys/lifecycle.js";
import { createSessionLedger } from "../baileys/session-ledger.js";
import { makeBaileysDriver } from "./baileys.js";

const GROUP = "120363000000000000@g.us";
const PLAYER_PN = "447700900123@s.whatsapp.net";
const SECRET_TEXT = "see you at the pitch on Tuesday";
const JOINED = 1_760_000_000;

const tick = () => new Promise((r) => setImmediate(r));

async function opened() {
  const sockets: FakeSocket[] = [];
  const logs: string[] = [];
  const handed: unknown[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let clock = JOINED * 1000;
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
  const driver = makeBaileysDriver({
    connection: connection as never,
    now: () => clock,
    wait: async (ms: number) => {
      clock += ms;
    },
    schedule: (fn, ms) => {
      timers.push({ fn, ms });
      return { cancel: () => {} };
    },
    log: (l) => logs.push(l),
    error: (l) => logs.push(l),
  });
  driver.onMessage((m) => {
    handed.push(m);
  });
  await driver.start();
  sockets[0].open();
  await tick();
  return {
    driver,
    sock: sockets[0],
    logs,
    handed,
    timers,
    advance: (ms: number) => {
      clock += ms;
    },
    history: () => logs.filter((l) => l.startsWith("[baileys][history-sync]")),
  };
}

function wa(message: proto.IMessage | null, id: string, tsSec: number, extra: Record<string, unknown> = {}): WAMessage {
  return {
    key: { remoteJid: GROUP, fromMe: false, id, participant: PLAYER_PN },
    message: message ? proto.Message.fromObject(message) : undefined,
    messageTimestamp: tsSec,
    ...extra,
  } as WAMessage;
}

const joinNotice = () => wa(null, "JOIN", JOINED, { messageStubType: 20 });
const bundle = (id: string) =>
  wa(
    {
      messageHistoryBundle: {
        mimetype: "application/x-protobuf",
        mediaKey: Buffer.from("super-secret-media-key"),
        directPath: "/v/secret-path",
        messageHistoryMetadata: { messageCount: 40, oldestMessageTimestamp: JOINED - 86_400 },
      },
    },
    id,
    JOINED + 1,
  );

describe("messaging-history.set is logged in counts and goes nowhere else", () => {
  it("prints the summary, and neither the catch-up nor the analyzer sees a message from it", async () => {
    const t = await opened();
    t.sock.emit("messaging-history.set", {
      syncType: proto.HistorySync.HistorySyncType.RECENT,
      isLatest: true,
      chats: [{ id: GROUP }, { id: PLAYER_PN }],
      contacts: [{ id: PLAYER_PN, name: "Sam Secret" }],
      messages: [
        wa({ conversation: SECRET_TEXT }, "H1", JOINED - 200),
        wa({ conversation: SECRET_TEXT }, "H2", JOINED - 100),
      ],
    });
    await tick();

    expect(t.history()).toEqual([
      "[baileys][history-sync] messaging-history.set syncType=RECENT(3) chats=2 contacts=1 messages=2 " +
        "isLatest=true progress=n/a chunkOrder=n/a onDemandRequest=none groupChats=1 groupMessages=2 otherMessages=0",
      `[baileys][history-sync]   group ${GROUP} messages=2 oldest=2025-10-09T08:50:00Z newest=2025-10-09T08:51:40Z`,
    ]);
    expect(t.logs.join("\n")).not.toContain(SECRET_TEXT);
    expect(t.logs.join("\n")).not.toContain("Sam Secret");

    expect(t.handed).toEqual([]);
    t.advance(60_000);
    expect(await t.driver.fetchRecentGroupMessages(GROUP, 50)).toEqual([]);
  });

  it("logs a sync milestone", async () => {
    const t = await opened();
    t.sock.emit("messaging-history.status", {
      syncType: proto.HistorySync.HistorySyncType.RECENT,
      status: "complete",
      explicit: true,
    });
    await tick();
    expect(t.history()).toEqual([
      "[baileys][history-sync] messaging-history.status syncType=RECENT(3) status=complete explicit=true",
    ]);
  });
});

describe("the add of 2026-10-07, replayed: a join notice, then two messages with no content type", () => {
  it("names what the skipped messages carried and tallies the group, and still skips them", async () => {
    const t = await opened();
    t.sock.emit("messages.upsert", { messages: [joinNotice()], type: "append" });
    t.sock.emit("messages.upsert", { messages: [bundle("B1")], type: "notify" });
    t.sock.emit("messages.upsert", { messages: [wa({ messageHistoryNotice: {} }, "N1", JOINED + 1)], type: "notify" });
    await tick();

    // What the driver did before this change is unchanged.
    expect(t.logs.filter((l) => l.includes("skipped: no content type"))).toHaveLength(2);
    expect(t.logs.some((l) => l.includes("skipped: a system notice (stub type 20)"))).toBe(true);
    expect(t.handed).toEqual([]);
    expect(t.driver.stats().skipped).toBe(3);

    expect(t.history()).toEqual([
      `[baileys][history-sync] after-join ${GROUP}: tallying everything that arrives in this group for the next 300s`,
      `[baileys][history-sync] upsert=notify chat=${GROUP} id=B1 is a group history BUNDLE ` +
        "(messageCount=40 oldest=2025-10-08T08:53:20Z receivers=0 mimetype=application/x-protobuf " +
        "downloadable=yes); Baileys 7.0.0-rc14 does not unpack it",
      `[baileys][history-sync] upsert=notify chat=${GROUP} id=B1 has no content type: ` +
        "fields=[messageHistoryBundle] wrappers=[] messageContextInfo=absent fromMe=no participant=present " +
        "stubType=none messageHistoryBundle{messageCount=40 oldest=2025-10-08T08:53:20Z receivers=0 " +
        "mimetype=application/x-protobuf}",
      `[baileys][history-sync] upsert=notify chat=${GROUP} id=N1 is a group history NOTICE (no metadata)`,
      `[baileys][history-sync] upsert=notify chat=${GROUP} id=N1 has no content type: ` +
        "fields=[messageHistoryNotice] wrappers=[] messageContextInfo=absent fromMe=no participant=present " +
        "stubType=none messageHistoryNotice{no metadata}",
    ]);
    expect(t.logs.join("\n")).not.toContain("secret");

    // Nothing was remembered for the catch-up.
    t.advance(60_000);
    expect(await t.driver.fetchRecentGroupMessages(GROUP, 50)).toEqual([]);
  });

  it("prints the tally when the window closes, older messages and failed decrypts included", async () => {
    const t = await opened();
    t.sock.emit("messages.upsert", { messages: [joinNotice()], type: "append" });
    t.sock.emit("messages.upsert", { messages: [bundle("B1")], type: "notify" });
    t.sock.emit("messages.upsert", {
      messages: [
        wa({ conversation: SECRET_TEXT }, "OLD1", JOINED - 3600),
        wa(null, "BAD1", JOINED - 1800, { messageStubType: 2, messageStubParameters: ["No session found"] }),
      ],
      type: "append",
    });
    await tick();

    const timer = t.timers.find((x) => x.ms === 301_000);
    expect(timer).toBeDefined();
    const before = t.history().length;
    t.advance(301_000);
    timer!.fn();

    expect(t.history().slice(before)).toEqual([
      `[baileys][history-sync] after-join ${GROUP}: in the 300s after we were added, 4 message(s) arrived, ` +
        "2 of them sent BEFORE the add",
      "[baileys][history-sync]   1 x at-or-after-add upsert=append skipped: a system notice (stub type 20)",
      "[baileys][history-sync]   1 x at-or-after-add upsert=notify skipped: no content type",
      '[baileys][history-sync]   1 x older-than-add upsert=append could not be decrypted ("No session found")',
      "[baileys][history-sync]   1 x older-than-add upsert=append handed up (chat)",
    ]);
    expect(t.history().join("\n")).not.toContain(SECRET_TEXT);
  });

  it("an ordinary message in a group we were not just added to produces no diagnostic line", async () => {
    const t = await opened();
    t.sock.emit("messages.upsert", { messages: [wa({ conversation: SECRET_TEXT }, "M1", JOINED)], type: "notify" });
    await tick();
    expect(t.history()).toEqual([]);
    expect(t.handed).toHaveLength(1);
  });
});
