/**
 * Regression tests for the 2026-08-28 "attendance silently stopped" breakage.
 *
 * The Pi kept receiving WhatsApp messages but nothing ever reached
 * /api/whatsapp/analyze, so no attendance was recorded for a live customer
 * fixture. whatsapp-web.js's injected page code had started throwing (`r: r`)
 * against the current WhatsApp Web build, and every contact/chat lookup on
 * the inbound path went down with it.
 *
 * These tests drive the REAL enqueue → flush pipeline with a fake client and
 * a mocked API module, and assert the pipeline survives a totally broken
 * WhatsApp client.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client, Message } from "whatsapp-web.js";

const postAnalyzeFull = vi.fn();

vi.mock("./api.js", () => ({
  postAnalyzeFull: (...args: unknown[]) => postAnalyzeFull(...args),
}));

const { enqueueForAnalysis, _test_flushNow, _test_reset } = await import(
  "./smart-analysis.js"
);

/** The fakes below only implement the surface the pipeline touches. */
const asClient = (c: unknown) => c as unknown as Client;
const asMessage = (m: unknown) => m as unknown as Message;

// ── Fakes ───────────────────────────────────────────────────────────
function makeMsg(
  groupId: string,
  id: string,
  body: string,
  opts: { getContactThrows?: boolean; mentionedIds?: string[] } = {},
) {
  return {
    from: groupId,
    author: "447700900001@c.us",
    id: { _serialized: id },
    body,
    timestamp: 1_756_000_000,
    mentionedIds: opts.mentionedIds ?? [],
    _data: { body },
    getContact: opts.getContactThrows
      ? () => {
          // Not a rejected promise — a SYNCHRONOUS throw, which is what kills
          // `msg.getContact().catch(...)`.
          throw new Error("r");
        }
      : async () => ({ pushname: "Kemal", name: "Kemal", isMe: false }),
  };
}

/** A client whose every page-backed call explodes, like the broken build. */
function brokenClient() {
  return {
    info: {
      get wid(): never {
        throw new Error("r");
      },
    },
    getContactById: async () => {
      throw new Error("r");
    },
    getChatById: async () => {
      throw new Error("r");
    },
    sendMessage: vi.fn(async () => undefined),
  };
}

function healthyClient() {
  return {
    info: { wid: { _serialized: "447700900999@c.us" } },
    getContactById: async () => ({ pushname: "Someone", name: "Someone", isMe: false }),
    getChatById: async () => ({ sendMessage: vi.fn(async () => ({})) }),
    sendMessage: vi.fn(async () => ({ id: { _serialized: "sent" } })),
  };
}

beforeEach(() => {
  postAnalyzeFull.mockReset();
  _test_reset();
});

describe("flush resilience against a broken WhatsApp client", () => {
  it("still POSTs every message (with its RAW body) when enrichment blows up", async () => {
    const gid = "120363000000000001@g.us";
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
    const client = brokenClient();

    await enqueueForAnalysis(asClient(client), asMessage(makeMsg(gid, "m1", "in", { getContactThrows: true })));
    await enqueueForAnalysis(
      asClient(client),
      asMessage(makeMsg(gid, "m2", "out sorry", { getContactThrows: true, mentionedIds: ["999@lid"] })),
    );
    await enqueueForAnalysis(asClient(client), asMessage(makeMsg(gid, "m3", "im in too", { getContactThrows: true })));

    await _test_flushNow(gid);

    expect(postAnalyzeFull).toHaveBeenCalledOnce();
    const payload = postAnalyzeFull.mock.calls[0][0];
    expect(payload.groupId).toBe(gid);
    expect(payload.messages.map((m: { waMessageId: string }) => m.waMessageId)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    expect(payload.messages.map((m: { body: string }) => m.body)).toEqual([
      "in",
      "out sorry",
      "im in too",
    ]);
    // Raw mention JIDs are still forwarded so the server can do its own
    // resolution even though the Pi couldn't.
    expect(payload.messages[1].mentions).toEqual(["999@lid"]);
  });

  it("enqueue never throws when the client is broken", async () => {
    const gid = "120363000000000002@g.us";
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
    await expect(
      enqueueForAnalysis(asClient(brokenClient()), asMessage(makeMsg(gid, "x1", "in", { getContactThrows: true }))),
    ).resolves.toBeUndefined();
  });

  it("a broken message does not stop the rest of the batch reaching the analyzer", async () => {
    const gid = "120363000000000003@g.us";
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
    const client = healthyClient();

    await enqueueForAnalysis(asClient(client), asMessage(makeMsg(gid, "ok1", "in")));
    await enqueueForAnalysis(asClient(client), asMessage(makeMsg(gid, "bad", "maybe", { getContactThrows: true })));
    await enqueueForAnalysis(asClient(client), asMessage(makeMsg(gid, "ok2", "out")));

    await _test_flushNow(gid);

    const payload = postAnalyzeFull.mock.calls[0][0];
    expect(payload.messages.map((m: { waMessageId: string }) => m.waMessageId)).toEqual([
      "ok1",
      "bad",
      "ok2",
    ]);
    // The healthy ones still got their pushname; the broken one degrades to null.
    expect(payload.messages[0].authorName).toBe("Kemal");
    expect(payload.messages[1].authorName).toBeNull();
  });

  it("replies fall back to client.sendMessage when getChatById is broken", async () => {
    const gid = "120363000000000004@g.us";
    const client = brokenClient();
    postAnalyzeFull.mockResolvedValue({
      results: [{ waMessageId: "r1", handledBy: "llm", reply: "You're in 👍" }],
      nextKickoffMs: null,
    });

    await enqueueForAnalysis(asClient(client), asMessage(makeMsg(gid, "r1", "am i in?")));
    await _test_flushNow(gid);

    expect(client.sendMessage).toHaveBeenCalledWith(gid, "You're in 👍");
  });
});

describe("flush retry on analyzer failure", () => {
  it("re-queues the batch when the analyze POST fails, instead of dropping it", async () => {
    const gid = "120363000000000005@g.us";
    const client = healthyClient();
    postAnalyzeFull.mockRejectedValueOnce(new Error("ECONNRESET"));
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });

    await enqueueForAnalysis(asClient(client), asMessage(makeMsg(gid, "q1", "in")));
    await _test_flushNow(gid); // fails
    await _test_flushNow(gid); // retry

    expect(postAnalyzeFull).toHaveBeenCalledTimes(2);
    const payload = postAnalyzeFull.mock.calls[1][0];
    expect(payload.messages.map((m: { waMessageId: string }) => m.waMessageId)).toEqual(["q1"]);
  });

  it("gives up after the attempt ceiling so a poison batch can't loop forever", async () => {
    const gid = "120363000000000006@g.us";
    const client = healthyClient();
    postAnalyzeFull.mockRejectedValue(new Error("500"));

    await enqueueForAnalysis(asClient(client), asMessage(makeMsg(gid, "p1", "in")));
    for (let i = 0; i < 6; i++) await _test_flushNow(gid);

    // 3 attempts total (initial + 2 retries), then the batch is dropped and
    // subsequent flushes are no-ops.
    expect(postAnalyzeFull).toHaveBeenCalledTimes(3);
  });
});
