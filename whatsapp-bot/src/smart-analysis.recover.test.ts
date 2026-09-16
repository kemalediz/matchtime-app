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
import type { Client } from "whatsapp-web.js";

vi.mock("./api.js", () => ({
  postAnalyzeFull: vi.fn(),
}));

const {
  recoverGroupMessages,
  resolveRecoveryWindow,
  recordHistory,
  _test_flushNow,
  _test_reset,
  _test_getInboundStats,
} = await import("./smart-analysis.js");
const api = await import("./api.js");
const postAnalyzeFull = api.postAnalyzeFull as unknown as ReturnType<typeof vi.fn>;

const GID = "447525334985-1607872139@g.us";
const asClient = (c: unknown) => c as unknown as Client;

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
// scripts in PR #85's report): with the batch's own lines visible, a bare
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
