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
 * ── What broke ───────────────────────────────────────────────────────
 * `Message.react()` reads `this.id._serialized` and then calls into
 * whatsapp-web.js's injected page code. On a build mismatch it throws the
 * minified `r` for EVERY message. The old code caught that and logged
 * `[smart] react failed:` — a bare line among hundreds, with no statement
 * of what it costs. The attendance write itself is server-side and had
 * already happened, so the data looked perfectly healthy while every player
 * in the group saw the bot say nothing at all.
 *
 * ── What these tests pin ─────────────────────────────────────────────
 * 1. A failed reaction NEVER stops the rest of the batch being processed.
 * 2. It is reported as CRITICAL, naming the consequence (players got no
 *    confirmation), not as a bare error line.
 * 3. Exactly ONE catch-up message per flush for the WHOLE batch, listing
 *    the players by name — never one message per player, which is the spam
 *    the reaction design exists to avoid.
 * 4. On the healthy path this machinery is completely silent and posts
 *    nothing. That is the property that matters most: a live customer's
 *    group must not notice this code exists while reactions work.
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

function makeMsg(
  id: string,
  body: string,
  name: string,
  reactImpl: () => Promise<void>,
): Record<string, unknown> {
  return {
    from: GID,
    author: "447700900001@c.us",
    body,
    timestamp: 1_756_100_000,
    id: { _serialized: id },
    mentionedIds: [],
    _data: { body, notifyName: name },
    getContact: async () => ({ pushname: name, isMe: false }),
    react: reactImpl,
  };
}

const okReact = () => Promise.resolve();
const brokenReact = () => Promise.reject(new Error("r"));

function client() {
  return {
    info: { wid: { _serialized: "447700900999@c.us" } },
    getContactById: async () => ({ pushname: "Someone", isMe: false }),
    getChatById: async () => ({ sendMessage: vi.fn(async () => ({})) }),
    sendMessage: vi.fn(async () => ({ id: { _serialized: "sent" } })),
  };
}

/** Every group post the bot made during the flush. */
function posts(c: ReturnType<typeof client>): string[] {
  return c.sendMessage.mock.calls
    .filter((args: unknown[]) => args[0] === GID && typeof args[1] === "string")
    .map((args: unknown[]) => args[1] as string);
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
  delete process.env.BOT_REACT_TEXT_FALLBACK;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
describe("the healthy path stays completely silent", () => {
  it("posts NOTHING extra when every reaction lands", async () => {
    const c = client();
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal", okReact)));
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m2", "in", "Ayoub", okReact)));
    postAnalyzeFull.mockResolvedValue({
      results: [
        { waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null },
        { waMessageId: "m2", handledBy: "llm", intent: "in", react: "✅", reply: null },
      ],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    expect(posts(c)).toEqual([]);
    expect(errs.join("\n")).not.toContain("CRITICAL");
  });
});

describe("a broken react() must not take the batch down with it", () => {
  it("still delivers the replies for the other messages in the batch", async () => {
    const c = client();
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal", brokenReact)));
    await enqueueForAnalysis(
      asClient(c),
      asMessage(makeMsg("m2", "how many are we?", "Ayoub", okReact)),
    );
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

  it("reports the failure as CRITICAL and names what the player lost", async () => {
    const c = client();
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal", brokenReact)));
    postAnalyzeFull.mockResolvedValue({
      results: [{ waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null }],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    const joined = errs.join("\n");
    expect(joined).toContain("CRITICAL");
    // The attendance IS recorded — the log must say so, or whoever reads it
    // at 9pm before a fixture will assume the roster is wrong and go
    // hand-editing production data.
    expect(joined.toLowerCase()).toContain("attendance");
    expect(joined).toContain("1"); // how many players were affected
  });
});

describe("the text catch-up", () => {
  it("posts ONE message for the whole batch, naming every affected player", async () => {
    const c = client();
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal", brokenReact)));
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m2", "in", "Ayoub", brokenReact)));
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m3", "in", "Kieran", brokenReact)));
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
    const c = client();
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal", brokenReact)));
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m2", "in", "Ayoub", brokenReact)));
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
    const c = client();
    const nameless = makeMsg("m1", "in", "", brokenReact);
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
    const c = client();
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal", brokenReact)));
    postAnalyzeFull.mockResolvedValue({
      results: [{ waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null }],
      nextKickoffMs: null,
    });
    await _test_flushNow(GID);

    expect(posts(c)).toEqual([]);
    expect(errs.join("\n")).toContain("CRITICAL");
  });

  it("does not post twice inside the cooldown window", async () => {
    const c = client();
    for (const [id, name] of [
      ["m1", "Kemal"],
      ["m2", "Ayoub"],
    ] as const) {
      await enqueueForAnalysis(asClient(c), asMessage(makeMsg(id, "in", name, brokenReact)));
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
    const c = client();
    c.sendMessage = vi.fn(async () => {
      throw new Error("r");
    }) as unknown as typeof c.sendMessage;
    await enqueueForAnalysis(asClient(c), asMessage(makeMsg("m1", "in", "Kemal", brokenReact)));
    postAnalyzeFull.mockResolvedValue({
      results: [{ waMessageId: "m1", handledBy: "llm", intent: "in", react: "✅", reply: null }],
      nextKickoffMs: null,
    });
    await expect(_test_flushNow(GID)).resolves.toBeUndefined();
  });
});
