/**
 * The Pi's half of the health signal, driven through the REAL enqueue →
 * flush pipeline.
 *
 * Every counter here exists because a specific failure was invisible. The
 * assertions are therefore about what the SERVER will be able to see, not
 * about what the Pi logged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InboundMessage } from "./driver.js";
import { makeWwebjsDriver, type WwebjsClientLike } from "./drivers/wwebjs.js";

const postAnalyzeFull = vi.fn();
const postHeartbeat = vi.fn();

vi.mock("./api.js", () => ({
  postAnalyzeFull: (...args: unknown[]) => postAnalyzeFull(...args),
  postHeartbeat: (...args: unknown[]) => postHeartbeat(...args),
}));

const {
  enqueueForAnalysis,
  reportHealth,
  recordDegradedCapability,
  _test_flushNow,
  _test_reset,
  _test_getInboundStats,
} = await import("./smart-analysis.js");

/**
 * `asClient` now wraps the fake in the REAL whatsapp-web.js driver
 * (Phase 2, MDs/baileys-migration-plan-2026-09-21.md). The fakes and every
 * assertion below are unchanged: the driver is a pass-through, so a test
 * that watched `client.sendMessage` still watches `client.sendMessage`.
 * That is the point: these tests are the proof the refactor changed no
 * behaviour, and they only prove it while they run through the seam.
 */
const asClient = (c: unknown) => makeWwebjsDriver(c as unknown as WwebjsClientLike);
const asMessage = (m: unknown) => m as unknown as InboundMessage;

const GROUP = "120363000@g.us";

function makeMsg(
  id: string,
  body: string,
  opts: {
    author?: string;
    notifyName?: string | null;
    contact?: Record<string, unknown> | null;
    contactThrows?: boolean;
  } = {},
) {
  const data: Record<string, unknown> = { body };
  if (opts.notifyName !== undefined && opts.notifyName !== null) {
    data.notifyName = opts.notifyName;
  }
  return {
    id: { _serialized: id },
    from: GROUP,
    author: opts.author ?? "447700900001@c.us",
    body,
    timestamp: 1_756_000_000,
    mentionedIds: [],
    _data: data,
    getContact: opts.contactThrows
      ? () => {
          throw new Error("r");
        }
      : async () => opts.contact ?? { pushname: "Contact Name", isMe: false },
  };
}

function healthyClient() {
  return {
    info: { wid: { _serialized: "447000000000@c.us" } },
    getContactById: async () => ({ isMe: false, pushname: "Someone" }),
    sendMessage: vi.fn(async () => ({ id: { _serialized: "out" } })),
    getChatById: async () => ({ sendMessage: vi.fn() }),
    getMessageById: async () => ({ react: vi.fn(async () => undefined) }),
  };
}

beforeEach(() => {
  postAnalyzeFull.mockReset();
  postHeartbeat.mockReset();
  postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
  postHeartbeat.mockResolvedValue(undefined);
  _test_reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("the sender's name comes off the raw payload first", () => {
  it("prefers _data.notifyName over the contact lookup", async () => {
    // `notifyName` is plain data serialised onto the message when the event
    // fired. `getContact()` is an injected page call that dies whenever
    // WhatsApp ships a frontend change. Preferring the one that cannot
    // break means the name the server matches against the roster is the
    // SAME string on a healthy build and a degraded one — which is what
    // makes a UserAlias keep working through an outage instead of silently
    // stopping matching halfway through.
    const client = asClient(healthyClient());
    await enqueueForAnalysis(
      client,
      asMessage(makeMsg("m1", "in", { notifyName: "Baki", contact: { pushname: "بكي" } })),
    );
    await _test_flushNow(GROUP);
    const sent = postAnalyzeFull.mock.calls[0][0] as {
      messages: Array<{ authorName: string | null }>;
    };
    expect(sent.messages[0].authorName).toBe("Baki");
  });

  it("still falls back to the contact when the payload carries no notifyName", async () => {
    const client = asClient(healthyClient());
    await enqueueForAnalysis(
      client,
      asMessage(makeMsg("m2", "in", { contact: { pushname: "Contact Name" } })),
    );
    await _test_flushNow(GROUP);
    const sent = postAnalyzeFull.mock.calls[0][0] as {
      messages: Array<{ authorName: string | null }>;
    };
    expect(sent.messages[0].authorName).toBe("Contact Name");
  });
});

describe("counters the server needs to see", () => {
  it("counts a message nobody could be identified from", async () => {
    // An @lid sender (no phone in the JID) whose contact lookup threw and
    // whose payload carries no notifyName. The server can resolve nobody,
    // writes no attendance, and returns HTTP 200 doing it.
    const client = asClient(healthyClient());
    await enqueueForAnalysis(
      client,
      asMessage(
        makeMsg("m3", "in", { author: "158055467598020@lid", contactThrows: true }),
      ),
    );
    expect(_test_getInboundStats().nameless).toBe(1);
  });

  it("does NOT count a message that still has a name", async () => {
    const client = asClient(healthyClient());
    await enqueueForAnalysis(
      client,
      asMessage(
        makeMsg("m4", "in", {
          author: "158055467598020@lid",
          notifyName: "Baki",
          contactThrows: true,
        }),
      ),
    );
    expect(_test_getInboundStats().nameless).toBe(0);
  });

  it("does NOT count a message that still has a phone", async () => {
    const client = asClient(healthyClient());
    await enqueueForAnalysis(
      client,
      asMessage(makeMsg("m5", "in", { author: "447700900001@c.us", contactThrows: true })),
    );
    expect(_test_getInboundStats().nameless).toBe(0);
  });

  it("counts a WHOLE enrichment that degraded", async () => {
    // A `getContact()` throw on its own is contained per-field and is NOT
    // a degraded enrichment — that containment is the 2026-08-30 fix and
    // counting it would make the number mean "something wobbled" rather
    // than "the enrichment collapsed". What counts is the enrichment
    // itself dying, which on the broken build is `client.info` throwing.
    const client = asClient({
      ...healthyClient(),
      get info(): never {
        throw new Error("r");
      },
    });
    await enqueueForAnalysis(client, asMessage(makeMsg("m6", "in", { notifyName: "Baki" })));
    expect(_test_getInboundStats().degradedEnrichment).toBe(1);
  });

  it("does NOT count a contact lookup that failed but was contained", async () => {
    const client = asClient(healthyClient());
    await enqueueForAnalysis(
      client,
      asMessage(makeMsg("m6b", "in", { notifyName: "Baki", contactThrows: true })),
    );
    expect(_test_getInboundStats().degradedEnrichment).toBe(0);
  });

  it("counts a failed analyze POST, and the messages eventually given up on", async () => {
    const client = asClient(healthyClient());
    postAnalyzeFull.mockRejectedValue(new Error("analyze post failed: 500"));
    await enqueueForAnalysis(client, asMessage(makeMsg("m7", "in", { notifyName: "Baki" })));

    // Three attempts: two requeues then the drop (MAX_FLUSH_ATTEMPTS = 3).
    await _test_flushNow(GROUP);
    expect(_test_getInboundStats().flushFailures).toBe(1);
    expect(_test_getInboundStats().droppedMessages).toBe(0);
    await _test_flushNow(GROUP);
    await _test_flushNow(GROUP);
    expect(_test_getInboundStats().flushFailures).toBe(3);
    expect(_test_getInboundStats().droppedMessages).toBe(1);
  });

  it("counts a reaction that could not be placed", async () => {
    const client = asClient({
      ...healthyClient(),
      // The failure mode observed in prod: the lookup resolves to nothing,
      // so `react` never runs and nothing throws.
      getMessageById: async () => null,
    });
    await enqueueForAnalysis(client, asMessage(makeMsg("m8", "in", { notifyName: "Baki" })));
    postAnalyzeFull.mockResolvedValue({
      results: [{ waMessageId: "m8", handledBy: "llm", intent: "in", react: "✅", reply: null }],
      nextKickoffMs: null,
    });
    await _test_flushNow(GROUP);
    expect(_test_getInboundStats().reactFailures).toBeGreaterThan(0);
  });
});

describe("reportHealth", () => {
  it("reports even when the group said nothing at all", async () => {
    // THE POINT OF THE WHOLE FEATURE. `flushGroup` returns early on an
    // empty buffer and never POSTs to analyze, so anything piggybacked on
    // that call is silent for exactly the failure being hunted: in August
    // every message was dropped before the buffer and every flush was
    // empty for three days.
    await reportHealth([GROUP]);
    expect(postHeartbeat).toHaveBeenCalledTimes(1);
    const hb = postHeartbeat.mock.calls[0][0] as { groupId: string; counters: { seen: number } };
    expect(hb.groupId).toBe(GROUP);
    expect(hb.counters.seen).toBe(0);
  });

  it("carries the current counters", async () => {
    const client = asClient(healthyClient());
    await enqueueForAnalysis(client, asMessage(makeMsg("m9", "in", { notifyName: "Baki" })));
    await reportHealth([GROUP]);
    const hb = postHeartbeat.mock.calls[0][0] as {
      counters: { seen: number; buffered: number };
    };
    expect(hb.counters.seen).toBe(1);
    expect(hb.counters.buffered).toBe(1);
  });

  it("reports once per monitored group", async () => {
    await reportHealth([GROUP, "other@g.us"]);
    expect(postHeartbeat).toHaveBeenCalledTimes(2);
  });

  it("forwards the capabilities the bot declared degraded", async () => {
    recordDegradedCapability("participant-sync");
    recordDegradedCapability("participant-sync");
    recordDegradedCapability("message-recovery");
    await reportHealth([GROUP]);
    const hb = postHeartbeat.mock.calls[0][0] as { degradedCapabilities: string[] };
    expect(hb.degradedCapabilities).toEqual(["participant-sync", "message-recovery"]);
  });

  it("cannot break message delivery when the report itself fails", async () => {
    postHeartbeat.mockRejectedValue(new Error("network down"));
    await expect(reportHealth([GROUP])).resolves.toBeUndefined();
  });
});
