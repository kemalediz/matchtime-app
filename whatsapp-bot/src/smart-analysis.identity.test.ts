/**
 * RED-first spec for the LAST hole left by the 2026-08-28 → 08-30 breakage:
 * WHO sent the message.
 *
 * ── The hole ─────────────────────────────────────────────────────────
 * PR #11 and #13 made sure a message always REACHES /api/whatsapp/analyze
 * even when whatsapp-web.js's injected page code is throwing. But reaching
 * the analyzer is only half the job: the server still has to work out which
 * player spoke before it can register attendance.
 *
 * It has exactly two ways of doing that:
 *   • `authorPhone` — derived on the Pi from the sender's JID. WhatsApp's
 *     privacy mode gives group senders opaque `<digits>@lid` JIDs that carry
 *     NO phone, so `phoneFromAuthor()` returns "" for them.
 *   • `authorName` — the sender's WhatsApp pushname, used for the roster
 *     name match.
 *
 * `authorName` was ONLY ever produced by `msg.getContact()`, which is an
 * injected-page-code call. So on the broken build an `@lid` player's "IN"
 * arrived at the analyzer with authorPhone "" AND authorName null — no
 * identity at all. The message was no longer dropped on the Pi; it was
 * dropped one layer later, by the server, for exactly the same net effect:
 * no attendance.
 *
 * ── The fix these tests pin ──────────────────────────────────────────
 * `msg._data.notifyName` is the sender's pushname as carried ON THE MESSAGE
 * ITSELF — plain serialised data attached when the event fired, NOT a call
 * back into the page. It survives the breakage. The `message` handler in
 * index.ts already read it (for the history buffer) and then threw it away
 * instead of forwarding it. These tests require that it reaches the
 * analyzer, on the healthy path and — crucially — on every degraded one.
 *
 * Also pinned: `Contact.number` resolves an `@lid` sender to a REAL phone
 * when the layer is healthy. The DM path already did this (index.ts); the
 * group path did not, so an `@lid` player who could have been matched by
 * phone was matched by name (or not at all).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client, Message } from "whatsapp-web.js";

const postAnalyzeFull = vi.fn();

vi.mock("./api.js", () => ({
  postAnalyzeFull: (...args: unknown[]) => postAnalyzeFull(...args),
}));

const { enqueueForAnalysis, _test_flushNow, _test_reset } = await import("./smart-analysis.js");

const asClient = (c: unknown) => c as unknown as Client;
const asMessage = (m: unknown) => m as unknown as Message;

const LID_GROUP = "120363000000009001@g.us";
/** An opaque privacy JID: digits, but NOT a phone number. */
const LID_AUTHOR = "158055467598020@lid";

function healthyClient(contact: Record<string, unknown> = {}) {
  return {
    info: { wid: { _serialized: "447700900999@c.us" } },
    getContactById: async () => ({ pushname: "Someone", isMe: false, ...contact }),
    getChatById: async () => ({ sendMessage: vi.fn(async () => ({})) }),
    sendMessage: vi.fn(async () => ({ id: { _serialized: "sent" } })),
  };
}

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

/** Grab the single message the pipeline POSTed to /api/whatsapp/analyze. */
function postedMessage() {
  expect(postAnalyzeFull).toHaveBeenCalledTimes(1);
  const body = postAnalyzeFull.mock.calls[0][0] as {
    messages: Array<Record<string, unknown>>;
  };
  expect(body.messages).toHaveLength(1);
  return body.messages[0];
}

beforeEach(() => {
  postAnalyzeFull.mockReset();
  postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
  _test_reset();
});

// ─────────────────────────────────────────────────────────────────────
describe("@lid sender identity survives a broken injected layer", () => {
  it("forwards _data.notifyName as authorName when getContact() throws", async () => {
    const msg = {
      from: LID_GROUP,
      author: LID_AUTHOR,
      body: "in",
      timestamp: 1_756_000_000,
      id: { _serialized: "false_g_A" },
      mentionedIds: [],
      _data: { body: "in", notifyName: "Mujeeb" },
      getContact: () => {
        throw new Error("r"); // synchronous throw, as on the broken build
      },
    };
    await enqueueForAnalysis(asClient(brokenClient()), asMessage(msg));
    await _test_flushNow(LID_GROUP);

    const posted = postedMessage();
    // Without this the server sees {authorPhone:"", authorName:null} and
    // has no way at all to know who typed "in".
    expect(posted.authorName).toBe("Mujeeb");
    expect(posted.body).toBe("in");
  });

  it("forwards _data.notifyName when the WHOLE enrichment degrades", async () => {
    // Nothing readable except the raw payload: `mentionedIds` throws, so
    // enrichInbound dies before it ever gets near a contact.
    const msg: Record<string, unknown> = {
      from: LID_GROUP,
      author: LID_AUTHOR,
      body: "im in",
      timestamp: 1_756_000_001,
      id: { _serialized: "false_g_B" },
      _data: { body: "im in", notifyName: "Kieran R" },
      getContact: async () => ({ pushname: "Kieran R" }),
    };
    Object.defineProperty(msg, "mentionedIds", {
      get() {
        throw new Error("r");
      },
      enumerable: true,
    });
    await enqueueForAnalysis(asClient(brokenClient()), asMessage(msg));
    await _test_flushNow(LID_GROUP);

    expect(postedMessage().authorName).toBe("Kieran R");
  });

  it("prefers the enriched contact pushname over notifyName when both exist", async () => {
    // The contact record is the better name (it reflects a rename the
    // cached payload may not have), so the healthy path must not regress.
    const msg = {
      from: LID_GROUP,
      author: LID_AUTHOR,
      body: "in",
      timestamp: 1_756_000_002,
      id: { _serialized: "false_g_C" },
      mentionedIds: [],
      _data: { body: "in", notifyName: "stale name" },
      getContact: async () => ({ pushname: "Fresh Name", isMe: false }),
    };
    await enqueueForAnalysis(asClient(healthyClient()), asMessage(msg));
    await _test_flushNow(LID_GROUP);

    expect(postedMessage().authorName).toBe("Fresh Name");
  });

  it("falls back to notifyName when the contact resolves but is nameless", async () => {
    const msg = {
      from: LID_GROUP,
      author: LID_AUTHOR,
      body: "in",
      timestamp: 1_756_000_003,
      id: { _serialized: "false_g_D" },
      mentionedIds: [],
      _data: { body: "in", notifyName: "Ayoub" },
      getContact: async () => ({ pushname: "", name: null, isMe: false }),
    };
    await enqueueForAnalysis(asClient(healthyClient()), asMessage(msg));
    await _test_flushNow(LID_GROUP);

    expect(postedMessage().authorName).toBe("Ayoub");
  });

  it("never invents a name: authorName stays null when there is genuinely none", async () => {
    const msg = {
      from: LID_GROUP,
      author: LID_AUTHOR,
      body: "in",
      timestamp: 1_756_000_004,
      id: { _serialized: "false_g_E" },
      mentionedIds: [],
      _data: { body: "in" },
      getContact: () => {
        throw new Error("r");
      },
    };
    await enqueueForAnalysis(asClient(brokenClient()), asMessage(msg));
    await _test_flushNow(LID_GROUP);

    const posted = postedMessage();
    // The raw @lid digits must NEVER be passed off as a player's name.
    // (The server has an `isRawDigitName` guard too, but the Pi must not
    // manufacture the problem in the first place.)
    expect(posted.authorName).toBeNull();
    expect(String(posted.authorName ?? "")).not.toContain("158055467598020");
  });

  it("ignores a blank / whitespace notifyName", async () => {
    const msg = {
      from: LID_GROUP,
      author: LID_AUTHOR,
      body: "in",
      timestamp: 1_756_000_005,
      id: { _serialized: "false_g_F" },
      mentionedIds: [],
      _data: { body: "in", notifyName: "   " },
      getContact: () => {
        throw new Error("r");
      },
    };
    await enqueueForAnalysis(asClient(brokenClient()), asMessage(msg));
    await _test_flushNow(LID_GROUP);

    expect(postedMessage().authorName).toBeNull();
  });

  it("trims a notifyName before forwarding it", async () => {
    const msg = {
      from: LID_GROUP,
      author: LID_AUTHOR,
      body: "in",
      timestamp: 1_756_000_006,
      id: { _serialized: "false_g_G" },
      mentionedIds: [],
      _data: { body: "in", notifyName: "  Elnur Mammadov \n" },
      getContact: () => {
        throw new Error("r");
      },
    };
    await enqueueForAnalysis(asClient(brokenClient()), asMessage(msg));
    await _test_flushNow(LID_GROUP);

    expect(postedMessage().authorName).toBe("Elnur Mammadov");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("@lid → phone recovery via Contact.number", () => {
  it("upgrades an empty authorPhone from the contact record", async () => {
    // The DM path has done this since the @lid incident; the GROUP path
    // never did, so a player whose phone WAS resolvable was still sent to
    // the server phone-less and had to survive on a fuzzy name match.
    const msg = {
      from: LID_GROUP,
      author: LID_AUTHOR,
      body: "in",
      timestamp: 1_756_000_007,
      id: { _serialized: "false_g_H" },
      mentionedIds: [],
      _data: { body: "in", notifyName: "Mujeeb" },
      getContact: async () => ({ pushname: "Mujeeb", number: "+447700900123", isMe: false }),
    };
    await enqueueForAnalysis(asClient(healthyClient()), asMessage(msg));
    await _test_flushNow(LID_GROUP);

    expect(postedMessage().authorPhone).toBe("447700900123");
  });

  it("leaves a @c.us sender's phone exactly as the JID gave it", async () => {
    const msg = {
      from: LID_GROUP,
      author: "447700900456@c.us",
      body: "in",
      timestamp: 1_756_000_008,
      id: { _serialized: "false_g_I" },
      mentionedIds: [],
      _data: { body: "in", notifyName: "Whoever" },
      // A contact whose `number` disagrees must NOT overwrite the JID phone.
      getContact: async () => ({ pushname: "Whoever", number: "999", isMe: false }),
    };
    await enqueueForAnalysis(asClient(healthyClient()), asMessage(msg));
    await _test_flushNow(LID_GROUP);

    expect(postedMessage().authorPhone).toBe("447700900456");
  });

  it("never sends a non-numeric or nonsense Contact.number as a phone", async () => {
    const msg = {
      from: LID_GROUP,
      author: LID_AUTHOR,
      body: "in",
      timestamp: 1_756_000_009,
      id: { _serialized: "false_g_J" },
      mentionedIds: [],
      _data: { body: "in", notifyName: "Odd" },
      getContact: async () => ({ pushname: "Odd", number: "n/a", isMe: false }),
    };
    await enqueueForAnalysis(asClient(healthyClient()), asMessage(msg));
    await _test_flushNow(LID_GROUP);

    expect(postedMessage().authorPhone).toBe("");
  });

  it("survives a Contact.number that throws", async () => {
    const contact: Record<string, unknown> = { pushname: "Boom", isMe: false };
    Object.defineProperty(contact, "number", {
      get() {
        throw new Error("r");
      },
      enumerable: true,
    });
    const msg = {
      from: LID_GROUP,
      author: LID_AUTHOR,
      body: "in",
      timestamp: 1_756_000_010,
      id: { _serialized: "false_g_K" },
      mentionedIds: [],
      _data: { body: "in", notifyName: "Boom" },
      getContact: async () => contact,
    };
    await enqueueForAnalysis(asClient(healthyClient()), asMessage(msg));
    await _test_flushNow(LID_GROUP);

    const posted = postedMessage();
    expect(posted.authorPhone).toBe("");
    expect(posted.authorName).toBe("Boom");
  });
});
