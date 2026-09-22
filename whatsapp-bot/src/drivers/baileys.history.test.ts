/**
 * The restart replay under Baileys: `fetchRecentGroupMessages`.
 *
 * ── What is being decided here, and what is not ─────────────────────
 * Plan §2.15 is still an OPEN MEASUREMENT: nobody knows whether WhatsApp
 * hands a reconnecting Baileys device the messages sent while it was
 * down, or with which `messages.upsert` type. These tests do not pretend
 * to settle it. They pin the version that WORKS IF IT DOES: whatever the
 * socket delivers around an open is remembered, and the catch-up walk is
 * served from that, oldest messages included, `notify` and `append`
 * alike.
 *
 * If the replay turns out NOT to happen, this path serves nothing and the
 * log says so in the line the Phase 5 runbook tells the operator to grep
 * for. That is the point: the answer arrives as a reading, not as a
 * surprise on Sutton's group.
 *
 * The settle window is the other half. The catch-up runs inside
 * `index.ts`'s open handler, which fires the instant the socket opens,
 * so an answer given immediately would race the replay burst and report
 * "nothing to catch up on" every single time. So the driver waits out a
 * short window after the open before it answers.
 */
import { describe, it, expect } from "vitest";
import { proto, type WAMessage } from "baileys";
import { safeRead } from "../wa-read.js";
import { FakeSocket, manualScheduler } from "../baileys/fake-socket.js";
import { createBaileysConnection } from "../baileys/lifecycle.js";
import { createSessionLedger } from "../baileys/session-ledger.js";
import { makeBaileysDriver } from "./baileys.js";

const GROUP = "120363000000000000@g.us";
const OTHER = "120363000000000009@g.us";
const PLAYER_PN = "447700900123@s.whatsapp.net";

const tick = () => new Promise((r) => setImmediate(r));

function setup(opts: { historySettleMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const logs: string[] = [];
  const waits: number[] = [];
  let clock = 1_000_000;
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
    // The wait is recorded and returns at once, so a test never sleeps.
    wait: async (ms: number) => {
      waits.push(ms);
      clock += ms;
    },
    historySettleMs: opts.historySettleMs,
    log: (l) => logs.push(l),
    error: (l) => logs.push(l),
  });
  return {
    driver,
    sock: () => sockets[sockets.length - 1],
    logs,
    waits,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function wa(text: string, id: string, tsSec: number, chat = GROUP): WAMessage {
  return {
    key: { remoteJid: chat, fromMe: false, id, participant: PLAYER_PN },
    message: proto.Message.fromObject({ conversation: text }),
    messageTimestamp: tsSec,
    pushName: "Sam",
  } as WAMessage;
}

async function opened(opts?: Parameters<typeof setup>[0]) {
  const t = setup(opts);
  await t.driver.start();
  t.sock().open();
  await tick();
  return t;
}

describe("fetchRecentGroupMessages is served from what the socket delivered", () => {
  it("hands back the group's messages, newest first, once the settle window has passed", async () => {
    const t = await opened();
    t.sock().emit("messages.upsert", {
      messages: [wa("offline 1", "A1", 1700), wa("offline 2", "A2", 1701)],
      type: "append",
    });
    await tick();
    t.advance(60_000);

    const out = await t.driver.fetchRecentGroupMessages(GROUP, 10);
    expect(out).toHaveLength(2);
    expect(out.map((m) => safeRead(m, "body"))).toEqual(["offline 2", "offline 1"]);
    // The catch-up sorts by timestamp itself; it needs the field present.
    expect(out.map((m) => m.timestamp)).toEqual([1701, 1700]);
  });

  it("takes `append` and `notify` alike, because which one a replay uses is unknown", async () => {
    const t = await opened();
    t.sock().emit("messages.upsert", { messages: [wa("notify one", "N1", 1700)], type: "notify" });
    t.sock().emit("messages.upsert", { messages: [wa("append one", "P1", 1701)], type: "append" });
    await tick();
    t.advance(60_000);

    const out = await t.driver.fetchRecentGroupMessages(GROUP, 10);
    expect(out.map((m) => safeRead(m, "body"))).toEqual(["append one", "notify one"]);
  });

  it("does not mix groups", async () => {
    const t = await opened();
    t.sock().emit("messages.upsert", {
      messages: [wa("ours", "A1", 1700), wa("theirs", "B1", 1701, OTHER)],
      type: "notify",
    });
    await tick();
    t.advance(60_000);

    expect(await t.driver.fetchRecentGroupMessages(GROUP, 10)).toHaveLength(1);
    expect(await t.driver.fetchRecentGroupMessages(OTHER, 10)).toHaveLength(1);
  });

  it("returns [] rather than throwing when nothing arrived, and says so in the log", async () => {
    const t = await opened();
    t.advance(60_000);
    const out = await t.driver.fetchRecentGroupMessages(GROUP, 10);
    expect(out).toEqual([]);
    const line = t.logs.filter((l) => l.includes("[baileys][history]")).join("\n");
    expect(line).toContain(GROUP);
    // The one thing the Phase 5 runbook tells the reader to look for.
    expect(line).toMatch(/2\.15|offline replay/i);
  });

  it("no longer refuses as not-built-yet", async () => {
    const t = await opened();
    t.advance(60_000);
    await expect(t.driver.fetchRecentGroupMessages(GROUP, 10)).resolves.toEqual([]);
  });
});

describe("the settle window around an open", () => {
  it("waits out the rest of the window when the open was a moment ago", async () => {
    const t = await opened({ historySettleMs: 10_000 });
    t.advance(2_000);
    await t.driver.fetchRecentGroupMessages(GROUP, 10);
    expect(t.waits).toEqual([8_000]);
  });

  it("does not wait at all once the window has passed", async () => {
    const t = await opened({ historySettleMs: 10_000 });
    t.advance(30_000);
    await t.driver.fetchRecentGroupMessages(GROUP, 10);
    expect(t.waits).toEqual([]);
  });

  it("restarts the window on a RECONNECT, because the replay comes after the new open", async () => {
    const t = await opened({ historySettleMs: 10_000 });
    t.advance(60_000);
    t.sock().closeWith(428);
    await tick();
    // The lifecycle builds a new socket on its own schedule; open the newest.
    t.advance(1_000);
    t.sock().open();
    await tick();
    t.advance(1_000);
    await t.driver.fetchRecentGroupMessages(GROUP, 10);
    expect(t.waits).toEqual([9_000]);
  });
});

describe("the measurement the shadow run has to read", () => {
  it("counts upserts by type since the last open, so notify vs append is a number", async () => {
    const t = await opened();
    t.sock().emit("messages.upsert", { messages: [wa("a", "A1", 1700)], type: "notify" });
    t.sock().emit("messages.upsert", {
      messages: [wa("b", "A2", 1701), wa("c", "A3", 1702)],
      type: "append",
    });
    await tick();
    const stats = t.driver.stats();
    expect(stats.sinceOpen).toEqual({ notify: 1, append: 2 });
    expect(stats.upserts).toEqual({ notify: 1, append: 2 });
  });

  it("clears the since-open tally on every open but keeps the process total", async () => {
    const t = await opened();
    t.sock().emit("messages.upsert", { messages: [wa("a", "A1", 1700)], type: "notify" });
    await tick();
    t.sock().closeWith(428);
    await tick();
    t.advance(1_000);
    t.sock().open();
    await tick();
    expect(t.driver.stats().sinceOpen).toEqual({});
    expect(t.driver.stats().upserts).toEqual({ notify: 1 });
  });

  it("counts what the catch-up was served, so an empty answer is visible off the Pi", async () => {
    const t = await opened();
    t.sock().emit("messages.upsert", { messages: [wa("a", "A1", 1700)], type: "append" });
    await tick();
    t.advance(60_000);
    await t.driver.fetchRecentGroupMessages(GROUP, 10);
    await t.driver.fetchRecentGroupMessages(OTHER, 10);
    const stats = t.driver.stats();
    expect(stats.historyRequests).toBe(2);
    expect(stats.historyServed).toBe(1);
    expect(stats.historyEmpty).toBe(1);
  });
});
