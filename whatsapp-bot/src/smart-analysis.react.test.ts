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
 * THIRD (2026-09-16): whatsapp-web.js 1.34.7, the only build whose
 * injection matches the live frontend, defines NO `window.Store`. The
 * hand-rolled page code from the second fix read `window.Store.Msg` and
 * every reaction failed `store-unavailable` (the catch-up posted, as
 * designed). The reaction now goes through the library's own
 * `client.getMessageById` + `client.sendReaction`, still with OUR id, and
 * runs no page code of its own.
 *
 * ── What these tests pin ─────────────────────────────────────────────
 * 1. The id used for the reaction is the SAME id reported to the analyzer.
 * 2. A silent `null` from the page is reported, not swallowed.
 * 3. A `synthetic:` id is never attempted, and says so.
 * 4. A failed reaction NEVER stops the rest of the batch being processed.
 * 5. A failed reaction NEVER produces a message in the group (owner
 *    decision, 2026-09-16); it is counted and shouted in the log only.
 * 6. On the healthy path this machinery is completely silent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Client, Message } from "whatsapp-web.js";

const postAnalyzeFull = vi.fn();

vi.mock("./api.js", () => ({
  postAnalyzeFull: (...args: unknown[]) => postAnalyzeFull(...args),
}));

const { enqueueForAnalysis, _test_flushNow, _test_reset, _test_getInboundStats } = await import(
  "./smart-analysis.js"
);

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

/**
 * How the fake LIBRARY responds to a reaction attempt. The reaction goes
 * through whatsapp-web.js's own `client.getMessageById` + `client.sendReaction`
 * (2026-09-16: 1.34.7 has no `window.Store`, so hand-rolled page code is
 * dead); the fake page itself throws on ANY evaluate, like the real one did.
 */
type Lib = {
  getMessageById?: (id: string) => unknown;
  sendReaction?: (id: string, emoji: string) => unknown;
};

/** The injected layer throwing on the lookup — the 2026-08-28 failure shape. */
const libLookupThrows: Lib = {
  getMessageById: () => {
    throw new Error("Evaluation failed: r");
  },
};
/** The library not finding the message — the branch that used to be a silent null. */
const libNotFound: Lib = { getMessageById: () => null };

function client(lib: Lib = {}) {
  const getMessageById = vi.fn(async (id: string) =>
    lib.getMessageById ? lib.getMessageById(id) : { id: { _serialized: id } },
  );
  const sendReaction = vi.fn(async (id: string, emoji: string) =>
    lib.sendReaction ? lib.sendReaction(id, emoji) : undefined,
  );
  // whatsapp-web.js 1.34.7 defines no window.Store: any hand-rolled page
  // function that reaches for it dies exactly like this.
  const evaluate = vi.fn(async () => {
    throw new Error(
      "Evaluation failed: TypeError: Cannot read properties of undefined (reading 'Msg')",
    );
  });
  return {
    info: { wid: { _serialized: "447700900999@c.us" } },
    getContactById: async () => ({ pushname: "Someone", isMe: false }),
    getChatById: async () => ({ sendMessage: vi.fn(async () => ({})) }),
    sendMessage: vi.fn(async () => ({ id: { _serialized: "sent" } })),
    getMessageById,
    sendReaction,
    pupPage: { evaluate },
  };
}

/** Every group post the bot made during the flush. */
function posts(c: ReturnType<typeof client>): string[] {
  return c.sendMessage.mock.calls
    .filter((args: unknown[]) => args[0] === GID && typeof args[1] === "string")
    .map((args: unknown[]) => args[1] as string);
}

/** Every (messageId, emoji) pair actually handed to the library's sendReaction. */
function attempts(c: ReturnType<typeof client>): Array<[string, string]> {
  return c.sendReaction.mock.calls.map(
    (args: unknown[]) => [args[0], args[1]] as [string, string],
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
    // 1.34.7 has no window.Store: no page code of our own may run.
    expect(c.pupPage.evaluate).not.toHaveBeenCalled();
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
  it("names a message the page cannot find instead of firing sendReaction blind", async () => {
    // `Client.sendReaction` still carries the library's `if (!msg) return
    // null;` — exactly what `Message.react()` resolved to for days. So the
    // message is looked up first, a miss is reported by name, and the
    // silent branch is never reached.
    const c = client(libNotFound);
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal")));
    postAnalyzeFull.mockResolvedValue({
      results: [{ waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null }],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    const joined = errs.join("\n");
    expect(joined).toContain("CRITICAL");
    expect(joined).toContain("message-not-found");
    expect(c.sendReaction).not.toHaveBeenCalled();
    expect(posts(c)).toEqual([]); // and the group hears nothing about it
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the page has no window.Store (whatsapp-web.js 1.34.7, 2026-09-16)", () => {
  it("lands every reaction through the library and posts no catch-up", async () => {
    // The production failure: five recovered INs, five `store-unavailable`,
    // one text catch-up in the group. On this page every evaluate throws;
    // the library's own API is the only route, and it must be enough.
    const c = client();
    const recovered =
      "false_447525334985-1607872139@g.us_AC7E5E8D85C46B15C947935009390D7D_76643825668299@lid";
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg(recovered, "in", "Kemal")));
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m2", "out", "Ayoub")));
    postAnalyzeFull.mockResolvedValue({
      results: [
        { waMessageId: recovered, handledBy: "llm", intent: "in", react: "✅", reply: null },
        { waMessageId: "m2", handledBy: "llm", intent: "out", react: "🪑", reply: null },
      ],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    expect(c.pupPage.evaluate).not.toHaveBeenCalled();
    expect(c.getMessageById.mock.calls.map((a: unknown[]) => a[0])).toEqual([recovered, "m2"]);
    expect(attempts(c)).toEqual([
      [recovered, "✅"],
      ["m2", "🪑"],
    ]);
    expect(posts(c)).toEqual([]);
    expect(errs.join("\n")).not.toContain("CRITICAL");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a synthetic id is never attempted", () => {
  it("skips it, says why in the log, and says nothing in the group", async () => {
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
    expect(posts(c)).toEqual([]);
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
    const c = client({
      sendReaction: (id) => {
        if (id === "m1") throw new Error("Evaluation failed: r");
      },
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
    const c = client(libLookupThrows);
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
    expect(joined).toContain("lookup-threw");
    // The attendance IS recorded — the log must say so, or whoever reads it
    // at 9pm before a fixture will assume the roster is wrong and go
    // hand-editing production data.
    expect(joined.toLowerCase()).toContain("attendance");
    expect(joined).toContain("1"); // how many players were affected
  });

  it("distinguishes message-not-found from a broken page", async () => {
    const c = client(libNotFound);
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal")));
    postAnalyzeFull.mockResolvedValue({
      results: [{ waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null }],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    const joined = errs.join("\n");
    expect(joined).toContain("message-not-found");
    expect(joined).not.toContain("lookup-threw");
  });

  it("never lets a reaction failure block anything — the flush still resolves", async () => {
    const c = client(libLookupThrows);
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal")));
    postAnalyzeFull.mockResolvedValue({
      results: [{ waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null }],
      nextKickoffMs: null,
    });
    await expect(_test_flushNow(GID)).resolves.toBeUndefined();
  });
});

describe("a failed reaction never speaks in the group (owner decision, 2026-09-16)", () => {
  // Until today a batch of failed reactions produced ONE text post in the
  // group ("WhatsApp won't let me add my usual reactions right now, so here
  // it is in words: …"). It fired for real on 2026-09-16, on a day the live
  // group had already had too many bot messages. Kemal: never that message
  // again; if reactions cannot be placed, go silent. A bot announcing that
  // it cannot react reads as a broken bot, which is worse than a missing
  // tick. The failure is still counted and still shouted in the log
  // (bot-health reports on both); the group hears nothing.
  it("posts NOTHING when every reaction in the batch fails, and still counts and logs each one", async () => {
    const c = client(libLookupThrows);
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

    // Asserted on the client itself, not just on group-addressed posts:
    // no message of any kind, to anyone, because a reaction failed.
    expect(c.sendMessage).not.toHaveBeenCalled();
    expect(posts(c)).toEqual([]);

    // …but the failure is fully observable off-Pi.
    expect(_test_getInboundStats().reactFailures).toBe(3);
    const joined = errs.join("\n");
    expect(joined).toContain("CRITICAL: 3 of 3 reaction(s) could not be delivered");
    expect(joined).toContain("lookup-threw×3");
    expect(joined.toLowerCase()).toContain("attendance");
  });

  it("stays silent across repeated failing flushes too — no cooldown, no post, ever", async () => {
    const c = client(libLookupThrows);
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
    expect(c.sendMessage).not.toHaveBeenCalled();
    expect(_test_getInboundStats().reactFailures).toBe(2);
    expect(errs.filter((l) => l.includes("CRITICAL"))).toHaveLength(2);
  });

  it("tells the operator to upgrade whatsapp-web.js, and no longer suggests pinning WA_WEB_VERSION", async () => {
    // 2026-09-16 proved a pin cannot fix a library break: the injection in
    // 1.34.6 was wrong for EVERY build the archive offered. See
    // MDs/whatsapp-outage-2026-09-16-runbook.md.
    const c = client(libLookupThrows);
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal")));
    postAnalyzeFull.mockResolvedValue({
      results: [{ waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null }],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    const critical = errs.find((l) => l.includes("CRITICAL")) ?? "";
    expect(critical).toContain("upgrade whatsapp-web.js");
    expect(critical).toContain("whatsapp-outage-2026-09-16-runbook.md");
    expect(critical).not.toContain("WA_WEB_VERSION");
  });
});
