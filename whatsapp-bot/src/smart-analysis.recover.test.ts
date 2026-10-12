/**
 * The restart catch-up walk, after the 2026-09-16 outage.
 *
 * The walk's FIRST injected call was `client.getChatById(gid)`, which on
 * the live WhatsApp Web build throws the minified `r` from inside
 * `getChatModel` (group metadata + lid migration). `chat.fetchMessages()`
 * never touches `getChatModel`, but the walk could only obtain a Chat via
 * `getChatById`, so it died before it ever tried to read a message. ~15h
 * of a customer's INs sat on the phone, unread.
 *
 * These tests drive the REAL whatsapp-web.js `Chat`/`Message` structures
 * against a fake page (`pupPage.evaluate`) and the real enqueue buffer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeWwebjsDriver, type WwebjsClientLike } from "./drivers/wwebjs.js";

vi.mock("./api.js", () => ({
  postAnalyzeFull: vi.fn(),
}));

const {
  recoverGroupMessages,
  isRecoverySweepRunning,
  resolveRecoveryWindow,
  recordHistory,
  _test_flushNow,
  _test_reset,
  _test_getInboundStats,
} = await import("./smart-analysis.js");
const api = await import("./api.js");
const postAnalyzeFull = api.postAnalyzeFull as unknown as ReturnType<typeof vi.fn>;

const GID = "447525334985-1607872139@g.us";
/**
 * `asClient` now wraps the fake in the REAL whatsapp-web.js driver
 * (Phase 2, MDs/baileys-migration-plan-2026-09-21.md). The fakes and every
 * assertion below are unchanged: the driver is a pass-through, so a test
 * that watched `client.sendMessage` still watches `client.sendMessage`.
 * That is the point: these tests are the proof the refactor changed no
 * behaviour, and they only prove it while they run through the seam.
 */
const asClient = (c: unknown) => makeWwebjsDriver(c as unknown as WwebjsClientLike);

/** What `Chat.fetchMessages` gets back from the page: serialised models. */
function pageMessage(id: string, body: string, tSec: number, fromMe = false) {
  return {
    id: { fromMe, remote: GID, id, _serialized: `${fromMe}_${GID}_${id}` },
    body,
    type: "chat",
    t: tSec,
    from: GID,
    author: "447700900001@c.us",
    notifyName: "Abid",
    mentionedJidList: [],
  };
}

/**
 * The live build as observed on 2026-09-16: `getChatById` throws `r`,
 * while the page itself can still load a chat's messages.
 */
function clientWithBrokenGetChat(pageMessages: unknown[], opts: { evaluateDelayMs?: number } = {}) {
  const evaluate = vi.fn(async () => {
    if (opts.evaluateDelayMs) await new Promise((r) => setTimeout(r, opts.evaluateDelayMs));
    return pageMessages;
  });
  return {
    client: {
      pupPage: { evaluate },
      getChatById: vi.fn(async () => {
        throw new Error("r");
      }),
      getContactById: async () => {
        throw new Error("r");
      },
      info: { wid: { _serialized: "447525334985@c.us" } },
    },
    evaluate,
  };
}

beforeEach(() => {
  _test_reset();
});

describe("resolveRecoveryWindow", () => {
  it("defaults to today's behaviour: 2h lookback, 50 messages", () => {
    expect(resolveRecoveryWindow({})).toEqual({ lookbackHours: 2, fetchLimit: 50 });
  });

  it("reads RECOVER_LOOKBACK_HOURS and RECOVER_FETCH_LIMIT for a one-off wide run", () => {
    expect(
      resolveRecoveryWindow({ RECOVER_LOOKBACK_HOURS: "24", RECOVER_FETCH_LIMIT: "400" }),
    ).toEqual({ lookbackHours: 24, fetchLimit: 400 });
  });

  it("ignores garbage and non-positive values rather than widening to nothing", () => {
    expect(resolveRecoveryWindow({ RECOVER_LOOKBACK_HOURS: "lots", RECOVER_FETCH_LIMIT: "0" })).toEqual({
      lookbackHours: 2,
      fetchLimit: 50,
    });
    expect(resolveRecoveryWindow({ RECOVER_LOOKBACK_HOURS: "-3" }).lookbackHours).toBe(2);
  });
});

describe("recoverGroupMessages reads the group without getChatById", () => {
  it("buffers messages fetched through a bare Chat handle when getChatById throws r", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { client, evaluate } = clientWithBrokenGetChat([
      pageMessage("AAA", "In", nowSec - 30 * 60),
      pageMessage("BBB", "in for tuesday", nowSec - 10 * 60),
    ]);
    const errs: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...a: unknown[]) => void errs.push(a.map(String).join(" ")));
    try {
      await recoverGroupMessages(asClient(client), [GID]);
    } finally {
      spy.mockRestore();
    }
    // The page was asked for the chat's messages by id, and the walk never
    // needed getChatById to succeed.
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[1]).toBe(GID);
    expect(_test_getInboundStats().buffered).toBe(2);
    // Real ids survive, so the server can dedupe and a ✅ can land on the
    // real message rather than a synthetic id.
    expect(_test_getInboundStats().synthetic).toBe(0);
    expect(errs.join("\n")).not.toContain("message-recovery");
  });

  it("honours the lookback: a message older than the window is not replayed", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { client } = clientWithBrokenGetChat([
      pageMessage("OLD", "in", nowSec - 30 * 3600), // 30h ago: outside 24h
      pageMessage("NEW", "in", nowSec - 15 * 3600), // 15h ago: inside 24h, outside the 2h default
    ]);
    await recoverGroupMessages(asClient(client), [GID], { lookbackHours: 24, fetchLimit: 400 });
    expect(_test_getInboundStats().buffered).toBe(1);
  });

  it("skips the bot's own messages", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { client } = clientWithBrokenGetChat([pageMessage("ME", "Squad so far", nowSec - 60, true)]);
    await recoverGroupMessages(asClient(client), [GID]);
    expect(_test_getInboundStats().buffered).toBe(0);
  });

  it("asks the page for the configured limit", async () => {
    const { client, evaluate } = clientWithBrokenGetChat([]);
    await recoverGroupMessages(asClient(client), [GID], { lookbackHours: 24, fetchLimit: 400 });
    expect(evaluate.mock.calls[0]?.[2]).toEqual({ limit: 400 });
  });

  it("still degrades loudly when the page read fails too", async () => {
    const client = {
      pupPage: {
        evaluate: async () => {
          throw new Error("r");
        },
      },
      getChatById: async () => {
        throw new Error("r");
      },
    };
    const errs: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...a: unknown[]) => void errs.push(a.map(String).join(" ")));
    try {
      await recoverGroupMessages(asClient(client), [GID]);
    } finally {
      spy.mockRestore();
    }
    expect(errs.join("\n")).toContain("message-recovery");
    expect(_test_getInboundStats().buffered).toBe(0);
  });

  // 2026-10-13. A club that has just gone live: its group was deliberately
  // not listened to before that instant, and the messages between go-live
  // and the Pi's refresh were dropped. The catch-up reads the second lot
  // back and must never feed the first.
  it("a floor per group: nothing from BEFORE it is replayed or shown to the model as context, everything from it on is", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const liveAtSec = nowSec - 120;
    const { client } = clientWithBrokenGetChat([
      pageMessage("BEFORE-1", "in", liveAtSec - 600),
      pageMessage("BEFORE-2", "who is playing tuesday", liveAtSec - 1),
      pageMessage("AT", "In", liveAtSec),
      pageMessage("AFTER", "in please", liveAtSec + 45),
    ]);
    postAnalyzeFull.mockClear();
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
    await recoverGroupMessages(asClient(client), [GID], undefined, {
      notBeforeMs: (gid) => (gid === GID ? liveAtSec * 1000 : null),
    });
    expect(_test_getInboundStats().buffered).toBe(2);
    await _test_flushNow(GID);
    const sent = postAnalyzeFull.mock.calls[0][0] as { messages: Array<{ body: string }>; history: Array<{ body: string }> };
    expect(sent.messages.map((m) => m.body)).toEqual(["In", "in please"]);
    // Not as a message, and not as "recent chat" either.
    expect(sent.history.map((h) => h.body)).toEqual(["In", "in please"]);
    expect(JSON.stringify(sent)).not.toContain("who is playing tuesday");
  });

  // PR #250 review, fix 4. WhatsApp stamps whole seconds; go-live has
  // milliseconds. The first version compared in milliseconds and so
  // dropped a message sent in the same second as go-live but AFTER it.
  // The side chosen: lose nothing a player said after GO. The price is
  // that a message in that same second but a few hundred milliseconds
  // BEFORE go-live may be fed.
  it("the floor is compared by the SECOND: a message stamped in the second the club went live is kept", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const liveAtMs = (nowSec - 60) * 1000 + 700; // went live at :00.7
    const { client } = clientWithBrokenGetChat([
      pageMessage("SECOND-BEFORE", "in", nowSec - 61), // :59 of the minute before: left out
      pageMessage("SAME-SECOND", "in", nowSec - 60), // stamped :00, sent at :00.9 for all we know: kept
      pageMessage("NEXT-SECOND", "in", nowSec - 59),
    ]);
    postAnalyzeFull.mockClear();
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
    await recoverGroupMessages(asClient(client), [GID], undefined, { notBeforeMs: () => liveAtMs });
    expect(_test_getInboundStats().buffered).toBe(2);
    await _test_flushNow(GID);
    const sent = postAnalyzeFull.mock.calls[0][0] as { messages: Array<{ waMessageId: string }> };
    expect(sent.messages.map((m) => m.waMessageId.split("_").at(-1))).toEqual(["SAME-SECOND", "NEXT-SECOND"]);
  });

  // PR #250 review, fix 7. The live handler buffers a message the moment
  // the group is monitored; a catch-up a second later re-reads the same
  // message from the driver. Both copies used to sit in one batch.
  it("a message that is already waiting in the group's batch is not added to it a second time", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const page = [pageMessage("AAA", "In", nowSec - 60), pageMessage("BBB", "in too", nowSec - 30)];
    postAnalyzeFull.mockClear();
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
    await recoverGroupMessages(asClient(clientWithBrokenGetChat(page).client), [GID]);
    // The same two again (a second sweep before the batch has gone), and one new one.
    await recoverGroupMessages(asClient(clientWithBrokenGetChat([...page, pageMessage("CCC", "and me", nowSec - 5)]).client), [GID]);
    expect(_test_getInboundStats().buffered).toBe(3);
    await _test_flushNow(GID);
    const sent = postAnalyzeFull.mock.calls[0][0] as { messages: Array<{ waMessageId: string }> };
    const ids = sent.messages.map((m) => m.waMessageId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
  });

  it("the page handing the same message back twice in one read: once in the batch", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const twice = [pageMessage("AAA", "In", nowSec - 60), pageMessage("AAA", "In", nowSec - 60)];
    await recoverGroupMessages(asClient(clientWithBrokenGetChat(twice).client), [GID]);
    expect(_test_getInboundStats().buffered).toBe(1);
  });

  it("no floor for a group (null, or no option at all) is exactly the catch-up it always was", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const page = [pageMessage("AAA", "In", nowSec - 30 * 60), pageMessage("BBB", "in for tuesday", nowSec - 10 * 60)];
    await recoverGroupMessages(asClient(clientWithBrokenGetChat(page).client), [GID], undefined, { notBeforeMs: () => null });
    expect(_test_getInboundStats().buffered).toBe(2);
    _test_reset();
    await recoverGroupMessages(asClient(clientWithBrokenGetChat(page).client), [GID]);
    expect(_test_getInboundStats().buffered).toBe(2);
  });

  it("says whether a sweep is running, so a catch-up that must not be skipped can wait for it", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { client } = clientWithBrokenGetChat([pageMessage("AAA", "In", nowSec - 60)], { evaluateDelayMs: 20 });
    expect(isRecoverySweepRunning()).toBe(false);
    const sweep = recoverGroupMessages(asClient(client), [GID]);
    expect(isRecoverySweepRunning()).toBe(true);
    await sweep;
    expect(isRecoverySweepRunning()).toBe(false);
  });

  it("refuses to run two sweeps at once (a repeat `ready` after a re-inject)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { client, evaluate } = clientWithBrokenGetChat([pageMessage("AAA", "In", nowSec - 60)], {
      evaluateDelayMs: 20,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await Promise.all([
        recoverGroupMessages(asClient(client), [GID]),
        recoverGroupMessages(asClient(client), [GID]),
      ]);
    } finally {
      warn.mockRestore();
    }
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(_test_getInboundStats().buffered).toBe(1);
    // ...and a later sweep is allowed again.
    await recoverGroupMessages(asClient(client), [GID]);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});

// ── The catch-up feeds the history buffer (2026-09-16) ────────────────
//
// The live `message` handler records every inbound message into the
// group's 15-line history buffer BEFORE enqueueing it, and the server's
// attendance extractor reads that buffer as "RECENT CHAT". The catch-up
// enqueued without recording, so a batch replayed after a restart reached
// the extractor with an EMPTY recent chat. Measured live (15 runs each,
// scripts in PR #87's report): with the batch's own lines visible, a bare
// lowercase "in" is extracted at 0.9-0.95 every run; with no recent chat
// it comes back at 0.6 in 3 of 15 and claimless in 6 more. Idris's "in"
// on 2026-09-16 was read in exactly that context.
describe("the catch-up feeds the history buffer, like the live handler", () => {
  it("a replayed batch reaches the analyzer with its own lines as recent chat, oldest first", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { client } = clientWithBrokenGetChat([
      // Newest first, as the page can hand them back: the buffer must still
      // read in chronological order.
      pageMessage("BBB", "in", nowSec - 60),
      pageMessage("AAA", "In", nowSec - 120),
    ]);
    postAnalyzeFull.mockClear();
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
    await recoverGroupMessages(asClient(client), [GID]);
    await _test_flushNow(GID);
    expect(postAnalyzeFull).toHaveBeenCalledOnce();
    const payload = postAnalyzeFull.mock.calls[0][0] as {
      messages: Array<{ body: string }>;
      history: Array<{ authorName: string | null; body: string; timestamp: string }>;
    };
    expect(payload.messages.map((m) => m.body)).toEqual(["In", "in"]);
    expect(payload.history.map((h) => h.body)).toEqual(["In", "in"]);
    expect(payload.history.map((h) => h.authorName)).toEqual(["Abid", "Abid"]);
    expect(payload.history[0].timestamp).toBe(new Date((nowSec - 120) * 1000).toISOString());
  });

  it("a line the live handler already recorded is not recorded twice", async () => {
    // The 2026-09-09 incident was the sender's own line appearing twice in
    // front of the extractor; a replay must not manufacture that shape.
    const nowSec = Math.floor(Date.now() / 1000);
    recordHistory(GID, {
      authorName: "Abid",
      body: "In",
      timestamp: new Date((nowSec - 120) * 1000).toISOString(),
    });
    const { client } = clientWithBrokenGetChat([pageMessage("AAA", "In", nowSec - 120)]);
    postAnalyzeFull.mockClear();
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
    await recoverGroupMessages(asClient(client), [GID]);
    await _test_flushNow(GID);
    const payload = postAnalyzeFull.mock.calls[0][0] as { history: Array<{ body: string }> };
    expect(payload.history.map((h) => h.body)).toEqual(["In"]);
  });
});
