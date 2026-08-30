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

const { enqueueForAnalysis, _test_flushNow, _test_reset, _test_getInboundStats } =
  await import("./smart-analysis.js");

/** The fakes below only implement the surface the pipeline touches. */
const asClient = (c: unknown) => c as unknown as Client;
const asMessage = (m: unknown) => m as unknown as Message;

// ── Fakes ───────────────────────────────────────────────────────────
function makeMsg(
  groupId: string,
  id: string,
  body: string,
  opts: {
    getContactThrows?: boolean;
    mentionedIds?: string[];
    /** Simulate the broken injected code: `msg.id` is simply absent. */
    noId?: boolean;
    /** Simulate the broken injected code: reading `msg.id` throws `r: r`. */
    idThrows?: boolean;
    author?: string;
    timestamp?: number;
  } = {},
) {
  const msg: Record<string, unknown> = {
    from: groupId,
    author: opts.author ?? "447700900001@c.us",
    body,
    timestamp: opts.timestamp ?? 1_756_000_000,
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
  // Defined AFTER the literal: an object spread would invoke a throwing
  // getter while building the fake, which is not what we're simulating.
  if (opts.idThrows) {
    Object.defineProperty(msg, "id", {
      get() {
        throw new Error("r");
      },
      enumerable: true,
    });
  } else if (!opts.noId) {
    msg.id = { _serialized: id };
  }
  return msg;
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

// ── The 2026-08-30 outage itself ────────────────────────────────────
describe("inbound messages with an UNREADABLE id are still analysed", () => {
  it("buffers and POSTs a message whose `id` is missing (was: silently dropped)", async () => {
    const gid = "120363000000000010@g.us";
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });

    await enqueueForAnalysis(
      asClient(healthyClient()),
      asMessage(makeMsg(gid, "", "im in", { noId: true })),
    );
    await _test_flushNow(gid);

    expect(postAnalyzeFull).toHaveBeenCalledOnce();
    const payload = postAnalyzeFull.mock.calls[0][0];
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].body).toBe("im in");
    expect(payload.messages[0].waMessageId).toMatch(/^synthetic:/);
  });

  it("buffers and POSTs a message whose `id` getter throws (the live `r: r`)", async () => {
    const gid = "120363000000000011@g.us";
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });

    await enqueueForAnalysis(
      asClient(brokenClient()),
      asMessage(makeMsg(gid, "", "out sorry", { idThrows: true, getContactThrows: true })),
    );
    await _test_flushNow(gid);

    const payload = postAnalyzeFull.mock.calls[0][0];
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].body).toBe("out sorry");
    expect(payload.messages[0].waMessageId).toMatch(/^synthetic:/);
  });

  it("gives the SAME synthetic id when the same message is re-fed (recoverGroupMessages)", async () => {
    // The server dedupes on waMessageId. If the re-feed produced a fresh id,
    // the same "in" would be analysed twice and attendance registered twice.
    const gid = "120363000000000012@g.us";
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
    const client = healthyClient();

    await enqueueForAnalysis(asClient(client), asMessage(makeMsg(gid, "", "in", { noId: true })));
    await _test_flushNow(gid);
    await enqueueForAnalysis(asClient(client), asMessage(makeMsg(gid, "", "in", { noId: true })));
    await _test_flushNow(gid);

    const first = postAnalyzeFull.mock.calls[0][0].messages[0].waMessageId;
    const second = postAnalyzeFull.mock.calls[1][0].messages[0].waMessageId;
    expect(first).toBe(second);
  });

  it("gives DIFFERENT synthetic ids to different messages in one batch", async () => {
    const gid = "120363000000000013@g.us";
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
    const client = healthyClient();

    await enqueueForAnalysis(asClient(client), asMessage(makeMsg(gid, "", "in", { noId: true })));
    await enqueueForAnalysis(
      asClient(client),
      asMessage(makeMsg(gid, "", "out", { noId: true, author: "447700900002@c.us" })),
    );
    await enqueueForAnalysis(
      asClient(client),
      asMessage(makeMsg(gid, "", "in", { noId: true, timestamp: 1_756_000_060 })),
    );
    await _test_flushNow(gid);

    const ids = postAnalyzeFull.mock.calls[0][0].messages.map(
      (m: { waMessageId: string }) => m.waMessageId,
    );
    expect(new Set(ids).size).toBe(3);
  });

  it("real ids are left completely alone when the client is healthy", async () => {
    const gid = "120363000000000014@g.us";
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });

    await enqueueForAnalysis(asClient(healthyClient()), asMessage(makeMsg(gid, "real_1", "in")));
    await _test_flushNow(gid);

    expect(postAnalyzeFull.mock.calls[0][0].messages[0].waMessageId).toBe("real_1");
  });

  it("logs CRITICAL the first time, but does not log once per message", async () => {
    const gid = "120363000000000015@g.us";
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
    const client = healthyClient();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    for (let i = 0; i < 40; i++) {
      await enqueueForAnalysis(
        asClient(client),
        asMessage(makeMsg(gid, "", `msg ${i}`, { noId: true })),
      );
    }

    const critical = spy.mock.calls.filter((c) =>
      String(c[0]).includes("CRITICAL") && String(c[0]).includes("id"),
    );
    expect(critical.length).toBeGreaterThanOrEqual(1);
    expect(critical.length).toBeLessThan(10);
    spy.mockRestore();
  });
});

// ── Diagnostics: "messages arrive but nothing is analysed" must be VISIBLE ──
describe("inbound counters + empty-flush heartbeat", () => {
  it("counts what came in, what was buffered, and what was synthesised", async () => {
    const gid = "120363000000000016@g.us";
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
    const client = healthyClient();

    await enqueueForAnalysis(asClient(client), asMessage(makeMsg(gid, "a", "in")));
    await enqueueForAnalysis(asClient(client), asMessage(makeMsg(gid, "", "in", { noId: true })));
    // A DM (not @g.us) is not an analysable group message.
    await enqueueForAnalysis(asClient(client), asMessage(makeMsg("447700900001@c.us", "d", "hi")));

    const stats = _test_getInboundStats();
    expect(stats.seen).toBe(3);
    expect(stats.buffered).toBe(2);
    expect(stats.synthetic).toBe(1);
    expect(stats.notGroup).toBe(1);
  });

  it("an EMPTY flush still logs, so a stalled pipeline is visible within minutes", async () => {
    const gid = "120363000000000017@g.us";
    // A DM sets the module's shared client without buffering anything, so the
    // group's buffer is genuinely empty when the flush runs.
    await enqueueForAnalysis(
      asClient(healthyClient()),
      asMessage(makeMsg("447700900001@c.us", "dm", "hi")),
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await _test_flushNow(gid); // nothing buffered

    const lines = spy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes(gid) && /empty/i.test(l))).toBe(true);
    spy.mockRestore();
  });

  it("the empty-flush line carries the inbound counters (seen vs buffered)", async () => {
    const gid = "120363000000000018@g.us";
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
    await enqueueForAnalysis(
      asClient(healthyClient()),
      asMessage(makeMsg(gid, "z", "in")),
    );
    await _test_flushNow(gid); // drains the buffer
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await _test_flushNow(gid); // now empty
    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => /empty/i.test(l));
    spy.mockRestore();
    expect(line).toBeDefined();
    expect(line).toMatch(/seen=1/);
    expect(line).toMatch(/buffered=1/);
  });

  it("_test_reset clears the counters between cases", () => {
    _test_reset();
    expect(_test_getInboundStats()).toEqual({
      seen: 0,
      buffered: 0,
      synthetic: 0,
      notGroup: 0,
    });
  });
});

describe("enqueue survives a totally booby-trapped Message", () => {
  /** Every property a broken injected build can turn into a throwing getter. */
  function boobyTrappedMsg(groupId: string) {
    const msg: Record<string, unknown> = { from: groupId };
    for (const key of ["id", "author", "body", "_data", "mentionedIds", "timestamp"]) {
      Object.defineProperty(msg, key, {
        get() {
          throw new Error("r");
        },
        enumerable: true,
      });
    }
    msg.getContact = () => {
      throw new Error("r");
    };
    return msg;
  }

  it("still buffers and POSTs the message (id, body, mentions and timestamp all throw)", async () => {
    const gid = "120363000000000019@g.us";
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });

    await expect(
      enqueueForAnalysis(asClient(brokenClient()), asMessage(boobyTrappedMsg(gid))),
    ).resolves.toBeUndefined();
    await _test_flushNow(gid);

    expect(postAnalyzeFull).toHaveBeenCalledOnce();
    const payload = postAnalyzeFull.mock.calls[0][0];
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].waMessageId).toMatch(/^synthetic:/);
    // Nothing readable, but the timestamp must still be a valid ISO string —
    // the analyzer parses it.
    expect(Number.isNaN(Date.parse(payload.messages[0].timestamp))).toBe(false);
    expect(_test_getInboundStats().buffered).toBe(1);
  });
});
