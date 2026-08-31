/**
 * RED-first spec for the SECOND half of the attendance loop: telling the
 * player it worked.
 *
 * ── The rule ─────────────────────────────────────────────────────────
 * A player types "in"; the server registers the attendance and hands back
 * `react: "✅"` (or "🪑" for the bench). The bot places that reaction on
 * their message. The reaction IS the confirmation — it is the ONLY thing
 * the player sees, and it is why the bot does not reply in words to every
 * "in" (twenty text replies in an evening would be unusable in a customer's
 * group).
 *
 * ── What broke, twice ────────────────────────────────────────────────
 * FIRST (2026-08-28): `Message.react()` calls into whatsapp-web.js's
 * injected page code, which THREW the minified `r` on a build mismatch. The
 * old code caught that and logged `[smart] react failed:` — a bare line with
 * no statement of what it cost. Fixed by the CRITICAL log + text catch-up
 * below.
 *
 * SECOND (2026-08-31), and far worse: `Message.react()` opens with
 * `if (!messageId) return null;` where `messageId` is `this.id._serialized`
 * — which the same frontend change made UNREADABLE. So it stopped throwing
 * and started RESOLVING WITHOUT DOING ANYTHING. A silent resolve is
 * indistinguishable from success, so the catch never ran, the CRITICAL never
 * fired, the catch-up never posted, and reactions were dead for days while
 * every signal said healthy.
 *
 * The fix: react through OUR resolved id (`react-with-id.ts`), and treat an
 * un-understood return value as a failure rather than a success.
 *
 * ── What these tests pin ─────────────────────────────────────────────
 * 1. The id used for the reaction is the SAME id reported to the analyzer.
 * 2. A silent `null` from the page is reported, not swallowed.
 * 3. A `synthetic:` id is never attempted, and says so.
 * 4. A failed reaction NEVER stops the rest of the batch being processed.
 * 5. Exactly ONE catch-up message per flush for the WHOLE batch.
 * 6. On the healthy path this machinery is completely silent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Client, Message } from "whatsapp-web.js";

const postAnalyzeFull = vi.fn();

vi.mock("./api.js", () => ({
  postAnalyzeFull: (...args: unknown[]) => postAnalyzeFull(...args),
}));

const { enqueueForAnalysis, _test_flushNow, _test_reset } = await import("./smart-analysis.js");

const asClient = (c: unknown) => c as unknown as Client;
const asMessage = (m: unknown) => m as unknown as Message;

const GID = "120363000000007001@g.us";

function makeMsg(id: string, body: string, name: string): Record<string, unknown> {
  return {
    from: GID,
    author: "447700900001@c.us",
    body,
    timestamp: 1_756_100_000,
    id: { _serialized: id },
    mentionedIds: [],
    _data: { body, notifyName: name },
    getContact: async () => ({ pushname: name, isMe: false }),
    // Present ON PURPOSE and expected NEVER to be called: `Message.react()`
    // is the silent no-op we are replacing. If a change ever routes back
    // through it, `neverCalled` below turns red.
    react: vi.fn(async () => undefined),
  };
}

/**
 * A message whose real id could not be read at all, so `resolveWaMessageId`
 * synthesises one. Nothing here may expose a usable id.
 */
function makeUnidentifiableMsg(body: string, name: string): Record<string, unknown> {
  return {
    from: GID,
    author: "447700900002@c.us",
    body,
    timestamp: 1_756_100_042,
    id: {},
    mentionedIds: [],
    _data: { body, notifyName: name },
    getContact: async () => ({ pushname: name, isMe: false }),
    react: vi.fn(async () => undefined),
  };
}

/** How the fake page responds to a reaction attempt. */
type PageReact = (messageId: string, emoji: string) => unknown | Promise<unknown>;

const pageOk: PageReact = () => ({ ok: true });
/** The injected layer throwing — the 2026-08-28 failure. */
const pageThrows: PageReact = () => {
  throw new Error("Evaluation failed: r");
};
/** The library's silent no-op — the 2026-08-31 failure. */
const pageSilentNull: PageReact = () => null;

function client(react: PageReact = pageOk) {
  const evaluate = vi.fn(async (_fn: unknown, messageId: string, emoji: string) =>
    react(messageId, emoji),
  );
  return {
    info: { wid: { _serialized: "447700900999@c.us" } },
    getContactById: async () => ({ pushname: "Someone", isMe: false }),
    getChatById: async () => ({ sendMessage: vi.fn(async () => ({})) }),
    sendMessage: vi.fn(async () => ({ id: { _serialized: "sent" } })),
    pupPage: { evaluate },
  };
}

/** Every group post the bot made during the flush. */
function posts(c: ReturnType<typeof client>): string[] {
  return c.sendMessage.mock.calls
    .filter((args: unknown[]) => args[0] === GID && typeof args[1] === "string")
    .map((args: unknown[]) => args[1] as string);
}

/** Every (messageId, emoji) pair actually attempted against the page. */
function attempts(c: ReturnType<typeof client>): Array<[string, string]> {
  return c.pupPage.evaluate.mock.calls.map(
    (args: unknown[]) => [args[1], args[2]] as [string, string],
  );
}

/** Every waMessageId the analyzer was told about. */
function reportedIds(): string[] {
  return postAnalyzeFull.mock.calls.flatMap(
    (args: unknown[]) =>
      (args[0] as { messages: Array<{ waMessageId: string }> }).messages.map((m) => m.waMessageId),
  );
}

let errs: string[];
beforeEach(() => {
  postAnalyzeFull.mockReset();
  _test_reset();
  errs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env.BOT_REACT_TEXT_FALLBACK;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
describe("the id used to react is the id we told the analyzer about", () => {
  it("reacts with OUR resolved id, never through Message.react()", async () => {
    // The regression guard. These two ids drifting apart is the whole bug:
    // we resolved a perfectly good id, POSTed it to the analyzer, and then
    // reacted through `this.id._serialized`, which was unreadable.
    const c = client();
    const m = makeMsg("false_120363000000007001@g.us_3B0B7E9", "in", "Kemal");
    await enqueueForAnalysis(asClient(c), asMessage(m));
    postAnalyzeFull.mockResolvedValue({
      results: [
        {
          waMessageId: "false_120363000000007001@g.us_3B0B7E9",
          handledBy: "llm",
          intent: "in",
          react: "✅",
          reply: null,
        },
      ],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    expect(attempts(c)).toEqual([["false_120363000000007001@g.us_3B0B7E9", "✅"]]);
    expect(attempts(c)[0][0]).toBe(reportedIds()[0]);
    expect(m.react).not.toHaveBeenCalled();
    expect(errs.join("\n")).not.toContain("CRITICAL");
  });

  it("uses the RECONSTRUCTED id when id._serialized is unreadable", async () => {
    // Production counters showed `reconstructed=9, synthetic=0`: the real id
    // was recoverable from `_data.id` for every recent message. Reactions
    // must ride on that id rather than degrading.
    const c = client();
    const m = makeMsg("ignored", "in", "Kemal");
    m.id = {}; // no _serialized
    (m._data as Record<string, unknown>).id = {
      fromMe: false,
      remote: "120363000000007001@g.us",
      id: "3B0B7E9",
    };
    await enqueueForAnalysis(asClient(c), asMessage(m));
    const expected = "false_120363000000007001@g.us_3B0B7E9";
    postAnalyzeFull.mockResolvedValue({
      results: [
        { waMessageId: expected, handledBy: "llm", intent: "in", react: "✅", reply: null },
      ],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    expect(reportedIds()).toEqual([expected]);
    expect(attempts(c)).toEqual([[expected, "✅"]]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a silent no-op is a FAILURE, not a success", () => {
  it("reports a null from the page instead of swallowing it", async () => {
    // Exactly what `Message.react()` resolved to for days.
    const c = client(pageSilentNull);
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal")));
    postAnalyzeFull.mockResolvedValue({
      results: [{ waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null }],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    const joined = errs.join("\n");
    expect(joined).toContain("CRITICAL");
    expect(joined).toContain("unknown-result");
    expect(posts(c)[0]).toContain("Kemal"); // the player still gets told
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a synthetic id is never attempted", () => {
  it("skips it, says why, and still tells the player in words", async () => {
    const c = client();
    await enqueueForAnalysis(asClient(c), asMessage(makeUnidentifiableMsg("in", "Ayoub")));
    const synthId = reportedIds; // resolved below, after the flush POSTs
    postAnalyzeFull.mockImplementation(async (payload: { messages: Array<{ waMessageId: string }> }) => ({
      results: payload.messages.map((m) => ({
        waMessageId: m.waMessageId,
        handledBy: "llm",
        intent: "in",
        react: "✅",
        reply: null,
      })),
      nextKickoffMs: null,
    }));
    await _test_flushNow(GID);

    expect(synthId()[0]).toMatch(/^synthetic:/);
    // No page round-trip was spent on an id WhatsApp never issued.
    expect(attempts(c)).toEqual([]);
    const joined = errs.join("\n");
    expect(joined).toContain("synthetic");
    expect(joined).toContain("CRITICAL");
    expect(posts(c)[0]).toContain("Ayoub");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the healthy path stays completely silent", () => {
  it("posts NOTHING extra when every reaction lands", async () => {
    const c = client();
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal")));
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m2", "in", "Ayoub")));
    postAnalyzeFull.mockResolvedValue({
      results: [
        { waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null },
        { waMessageId: "m2", handledBy: "llm", intent: "in", react: "✅", reply: null },
      ],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    expect(attempts(c)).toEqual([
      ["m1", "✅"],
      ["m2", "✅"],
    ]);
    expect(posts(c)).toEqual([]);
    expect(errs.join("\n")).not.toContain("CRITICAL");
  });
});

describe("a broken reaction must not take the batch down with it", () => {
  it("still delivers the replies for the other messages in the batch", async () => {
    const c = client((id) => {
      if (id === "m1") throw new Error("Evaluation failed: r");
      return { ok: true };
    });
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal")));
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m2", "how many are we?", "Ayoub")));
    postAnalyzeFull.mockResolvedValue({
      results: [
        { waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null },
        { waMessageId: "m2", handledBy: "llm", intent: "question", react: null, reply: "9 so far" },
      ],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    expect(posts(c)).toContain("9 so far");
  });

  it("reports the failure as CRITICAL, names the reason, and names what the player lost", async () => {
    const c = client(pageThrows);
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal")));
    postAnalyzeFull.mockResolvedValue({
      results: [{ waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null }],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    const joined = errs.join("\n");
    expect(joined).toContain("CRITICAL");
    // The specific failure mode, so an operator can tell a broken injected
    // layer from a message that simply is not in the page's store.
    expect(joined).toContain("evaluate-threw");
    // The attendance IS recorded — the log must say so, or whoever reads it
    // at 9pm before a fixture will assume the roster is wrong and go
    // hand-editing production data.
    expect(joined.toLowerCase()).toContain("attendance");
    expect(joined).toContain("1"); // how many players were affected
  });

  it("distinguishes message-not-found from a broken page", async () => {
    const c = client(() => ({ ok: false, reason: "message-not-found" }));
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal")));
    postAnalyzeFull.mockResolvedValue({
      results: [{ waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null }],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    const joined = errs.join("\n");
    expect(joined).toContain("message-not-found");
    expect(joined).not.toContain("evaluate-threw");
  });

  it("never lets a reaction failure block anything — the flush still resolves", async () => {
    const c = client(pageThrows);
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal")));
    postAnalyzeFull.mockResolvedValue({
      results: [{ waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null }],
      nextKickoffMs: null,
    });
    await expect(_test_flushNow(GID)).resolves.toBeUndefined();
  });
});

describe("the text catch-up", () => {
  it("posts ONE message for the whole batch, naming every affected player", async () => {
    const c = client(pageThrows);
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal")));
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m2", "in", "Ayoub")));
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m3", "in", "Kieran")));
    postAnalyzeFull.mockResolvedValue({
      results: ["m1", "m2", "m3"].map((id) => ({
        waMessageId: id,
        handledBy: "llm",
        intent: "in",
        react: "✅",
        reply: null,
      })),
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    const p = posts(c);
    expect(p).toHaveLength(1); // NOT three
    expect(p[0]).toContain("Kemal");
    expect(p[0]).toContain("Ayoub");
    expect(p[0]).toContain("Kieran");
    expect(p[0]).toContain("✅");
  });

  it("keeps ✅ and 🪑 players apart — a benched player must not read as picked", async () => {
    const c = client(pageThrows);
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal")));
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m2", "in", "Ayoub")));
    postAnalyzeFull.mockResolvedValue({
      results: [
        { waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null },
        { waMessageId: "m2", handledBy: "llm", intent: "in", react: "🪑", reply: null },
      ],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    const p = posts(c)[0];
    expect(p).toMatch(/✅[^\n]*Kemal/);
    expect(p).toMatch(/🪑[^\n]*Ayoub/);
    expect(p).not.toMatch(/✅[^\n]*Ayoub/);
  });

  it("says nothing when the only failures are for players it cannot name", async () => {
    // A confirmation addressed to nobody is worse than silence, and printing
    // a raw @lid number as a player's name is a mistake this codebase has
    // already made once.
    const c = client(pageThrows);
    const nameless = makeMsg("m1", "in", "");
    (nameless._data as Record<string, unknown>).notifyName = undefined;
    nameless.getContact = () => {
      throw new Error("r");
    };
    await enqueueForAnalysis(asClient(c), asMessage(nameless));
    postAnalyzeFull.mockResolvedValue({
      results: [{ waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null }],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    expect(posts(c)).toEqual([]);
    // …but it must still SHOUT, because a player got no confirmation.
    expect(errs.join("\n")).toContain("CRITICAL");
  });

  it("is silenced by BOT_REACT_TEXT_FALLBACK=0 without silencing the alarm", async () => {
    process.env.BOT_REACT_TEXT_FALLBACK = "0";
    const c = client(pageThrows);
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal")));
    postAnalyzeFull.mockResolvedValue({
      results: [{ waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null }],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    expect(posts(c)).toEqual([]);
    expect(errs.join("\n")).toContain("CRITICAL");
  });

  it("does not post twice inside the cooldown window", async () => {
    const c = client(pageThrows);
    for (const [id, name] of [
      ["m1", "Kemal"],
      ["m2", "Ayoub"],
    ] as const) {
      await enqueueForAnalysis(asClient(c), asMessage(makeMsg(id, "in", name)));
      postAnalyzeFull.mockResolvedValue({
        results: [{ waMessageId: id, handledBy: "llm", intent: "in", react: "✅", reply: null }],
        nextKickoffMs: null,
      });
      await _test_flushNow(GID);
    }
    // Two flushes back to back, one catch-up post: a persistently broken
    // layer must not turn every 10-minute tick into a group post.
    expect(posts(c)).toHaveLength(1);
  });

  it("never lets a failing catch-up post break the flush", async () => {
    const c = client(pageThrows);
    c.sendMessage = vi.fn(async () => {
      throw new Error("r");
    }) as unknown as typeof c.sendMessage;
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal")));
    postAnalyzeFull.mockResolvedValue({
      results: [{ waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null }],
      nextKickoffMs: null,
    });
    await expect(_test_flushNow(GID)).resolves.toBeUndefined();
  });
});
