/**
 * RED-first spec for reacting with an id WE resolved.
 *
 * ── The bug this module exists to kill ───────────────────────────────
 * whatsapp-web.js 1.34.6, `src/structures/Message.js`:
 *
 *     async react(reaction){
 *         await this.client.pupPage.evaluate(async (messageId, reaction) => {
 *             if (!messageId) return null;                       // ← silent
 *             const msg = window.Store.Msg.get(messageId)
 *               || (await window.Store.Msg.getMessagesById([messageId]))?.messages?.[0];
 *             if(!msg) return null;                              // ← silent
 *             await window.Store.sendReactionToMsg(msg, reaction);
 *         }, this.id._serialized, reaction);
 *     }
 *
 * Since WhatsApp Web's frontend changed, `id._serialized` is unreadable on
 * inbound Message objects, so `react()` passed `undefined`, took the first
 * `return null`, and RESOLVED. No emoji, no throw, so our try/catch never
 * fired and the text catch-up never fired either. Reactions were dead for
 * days and every log line said the system was healthy.
 *
 * ── What these tests pin ─────────────────────────────────────────────
 * 1. The id used is OUR resolved id, passed explicitly — never
 *    `this.id._serialized`.
 * 2. A `synthetic:` id is NEVER attempted: `Store.Msg.get` cannot resolve
 *    an id WhatsApp never issued. That is a documented degradation, not a
 *    bug, and it must be reported as such.
 * 3. EVERY failure mode is named and distinguishable. Nothing may resolve
 *    to "we don't know what happened" silently — the library's `null` is
 *    itself mapped to a loud, specific reason.
 * 4. Nothing in here ever throws. A reaction is a confirmation; the
 *    attendance write already happened server-side and must never be put
 *    at risk by a failure to draw an emoji.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Client } from "whatsapp-web.js";
import {
  planReaction,
  interpretReactionResult,
  reactWithId,
  reactAndReport,
  describeReactionFailure,
  reactionPageFunction,
  REACTION_FAILURE_REASONS,
  type ReactionFailureReason,
} from "./react-with-id.js";

const REAL_ID = "false_447525334985-1607872139@g.us_3B0B7E9";
const SYNTH_ID = "synthetic:9f2c1ab34d5e6f70";

const asClient = (c: unknown) => c as unknown as Client;

// ─────────────────────────────────────────────────────────────────────
describe("planReaction — the pure decision", () => {
  it("reacts with EXACTLY the id it was given", () => {
    expect(planReaction(REAL_ID, "✅")).toEqual({
      action: "react",
      messageId: REAL_ID,
      emoji: "✅",
    });
  });

  it("NEVER attempts a synthetic id", () => {
    // `synthetic:` ids are ours, not WhatsApp's. `Store.Msg.get` would miss,
    // `getMessagesById` would miss, and we'd burn a page round-trip to learn
    // what we already know. Skipping is the honest answer.
    const plan = planReaction(SYNTH_ID, "✅");
    expect(plan.action).toBe("skip");
    expect(plan).toMatchObject({ reason: "synthetic-id" });
  });

  it.each([["", "empty"], [undefined, "undefined"], [null, "null"], [42, "a number"]])(
    "skips with no-id when the id is %s (%s)",
    (id) => {
      const plan = planReaction(id as unknown as string, "✅");
      expect(plan.action).toBe("skip");
      expect(plan).toMatchObject({ reason: "no-id" });
    },
  );

  it("skips with no-emoji when there is nothing to place", () => {
    expect(planReaction(REAL_ID, "")).toMatchObject({ action: "skip", reason: "no-emoji" });
    expect(planReaction(REAL_ID, null as unknown as string)).toMatchObject({
      action: "skip",
      reason: "no-emoji",
    });
  });

  it("is total — a booby-trapped value cannot make it throw", () => {
    const nasty = new Proxy(
      {},
      {
        get() {
          throw new Error("r");
        },
      },
    );
    expect(() => planReaction(nasty as unknown as string, "✅")).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("interpretReactionResult — mapping what the page handed back", () => {
  it("treats {ok:true} as success", () => {
    expect(interpretReactionResult({ ok: true })).toEqual({ ok: true });
  });

  it.each(REACTION_FAILURE_REASONS.filter((r) => r !== "unknown-result" && r !== "no-page"))(
    "passes through the specific failure reason %s",
    (reason) => {
      expect(interpretReactionResult({ ok: false, reason })).toMatchObject({
        ok: false,
        reason,
      });
    },
  );

  it("maps the library's silent null to a LOUD unknown-result", () => {
    // This is the exact value `Message.react()` resolved to for days while
    // pretending everything was fine. It must never again read as success.
    expect(interpretReactionResult(null)).toMatchObject({ ok: false, reason: "unknown-result" });
    expect(interpretReactionResult(undefined)).toMatchObject({
      ok: false,
      reason: "unknown-result",
    });
  });

  it("maps a reason string it does not recognise to unknown-result, keeping the detail", () => {
    const out = interpretReactionResult({ ok: false, reason: "something-new" });
    expect(out).toMatchObject({ ok: false, reason: "unknown-result" });
    expect(JSON.stringify(out)).toContain("something-new");
  });

  it("never reports success for a shape it does not understand", () => {
    for (const raw of [0, "", "ok", [], { ok: "yes" }, { okay: true }]) {
      expect(interpretReactionResult(raw)).toMatchObject({ ok: false });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("describeReactionFailure — every reason is explained", () => {
  it("has a distinct, non-empty explanation for every reason", () => {
    const seen = new Set<string>();
    for (const reason of REACTION_FAILURE_REASONS) {
      const text = describeReactionFailure(reason as ReactionFailureReason);
      expect(text.length).toBeGreaterThan(10);
      expect(seen.has(text)).toBe(false);
      seen.add(text);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("reactionPageFunction — what actually runs inside the page", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
  });

  function withStore(store: unknown) {
    (globalThis as { window?: unknown }).window = store === undefined ? {} : { Store: store };
  }

  it("places the reaction on the message Store.Msg.get resolves", async () => {
    const sendReactionToMsg = vi.fn(async () => undefined);
    const theMsg = { id: REAL_ID };
    withStore({ Msg: { get: () => theMsg, getMessagesById: async () => null }, sendReactionToMsg });

    await expect(reactionPageFunction(REAL_ID, "✅")).resolves.toEqual({ ok: true });
    expect(sendReactionToMsg).toHaveBeenCalledWith(theMsg, "✅");
  });

  it("falls back to getMessagesById when the cache misses", async () => {
    const sendReactionToMsg = vi.fn(async () => undefined);
    const theMsg = { id: REAL_ID };
    withStore({
      Msg: { get: () => null, getMessagesById: async () => ({ messages: [theMsg] }) },
      sendReactionToMsg,
    });

    await expect(reactionPageFunction(REAL_ID, "✅")).resolves.toEqual({ ok: true });
    expect(sendReactionToMsg).toHaveBeenCalledWith(theMsg, "✅");
  });

  it("reports store-unavailable rather than throwing when the injected layer is gone", async () => {
    (globalThis as { window?: unknown }).window = {};
    await expect(reactionPageFunction(REAL_ID, "✅")).resolves.toMatchObject({
      ok: false,
      reason: "store-unavailable",
    });

    withStore({ sendReactionToMsg: () => undefined }); // Store present, Msg missing
    await expect(reactionPageFunction(REAL_ID, "✅")).resolves.toMatchObject({
      ok: false,
      reason: "store-unavailable",
    });
  });

  it("reports send-reaction-unavailable when Store.sendReactionToMsg has been renamed away", async () => {
    withStore({ Msg: { get: () => ({ id: REAL_ID }), getMessagesById: async () => null } });
    await expect(reactionPageFunction(REAL_ID, "✅")).resolves.toMatchObject({
      ok: false,
      reason: "send-reaction-unavailable",
    });
  });

  it("reports message-not-found when neither lookup finds the message", async () => {
    withStore({
      Msg: { get: () => null, getMessagesById: async () => ({ messages: [] }) },
      sendReactionToMsg: vi.fn(),
    });
    await expect(reactionPageFunction(REAL_ID, "✅")).resolves.toMatchObject({
      ok: false,
      reason: "message-not-found",
    });
  });

  it("reports lookup-threw separately from message-not-found", async () => {
    withStore({
      Msg: {
        get: () => {
          throw new Error("r");
        },
        getMessagesById: async () => null,
      },
      sendReactionToMsg: vi.fn(),
    });
    await expect(reactionPageFunction(REAL_ID, "✅")).resolves.toMatchObject({
      ok: false,
      reason: "lookup-threw",
    });
  });

  it("reports send-threw when the reaction call itself blows up", async () => {
    withStore({
      Msg: { get: () => ({ id: REAL_ID }), getMessagesById: async () => null },
      sendReactionToMsg: async () => {
        throw new Error("r");
      },
    });
    await expect(reactionPageFunction(REAL_ID, "✅")).resolves.toMatchObject({
      ok: false,
      reason: "send-threw",
    });
  });

  it("refuses an empty id instead of silently returning null like the library did", async () => {
    withStore({
      Msg: { get: () => ({ id: REAL_ID }), getMessagesById: async () => null },
      sendReactionToMsg: vi.fn(),
    });
    await expect(reactionPageFunction("", "✅")).resolves.toMatchObject({
      ok: false,
      reason: "no-id",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("reactWithId — the thin adapter around pupPage.evaluate", () => {
  function clientWith(evaluate: (...a: unknown[]) => unknown) {
    const spy = vi.fn(evaluate);
    return { client: { pupPage: { evaluate: spy } }, spy };
  }

  it("hands OUR id to the page, not whatever the Message object thinks its id is", async () => {
    const { client, spy } = clientWith(async () => ({ ok: true }));
    await reactWithId(asClient(client), REAL_ID, "✅");

    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0];
    expect(typeof args[0]).toBe("function"); // the page function
    expect(args[1]).toBe(REAL_ID); // ← the whole point of this module
    expect(args[2]).toBe("✅");
  });

  it("reports success when the page says ok", async () => {
    const { client } = clientWith(async () => ({ ok: true }));
    await expect(reactWithId(asClient(client), REAL_ID, "✅")).resolves.toEqual({ ok: true });
  });

  it("maps a null from the page to unknown-result, never to success", async () => {
    const { client } = clientWith(async () => null);
    await expect(reactWithId(asClient(client), REAL_ID, "✅")).resolves.toMatchObject({
      ok: false,
      reason: "unknown-result",
    });
  });

  it("reports evaluate-threw, with the cause, when the injected layer blows up", async () => {
    const { client } = clientWith(async () => {
      throw new Error("Evaluation failed: r");
    });
    const out = await reactWithId(asClient(client), REAL_ID, "✅");
    expect(out).toMatchObject({ ok: false, reason: "evaluate-threw" });
    expect(JSON.stringify(out)).toContain("r");
  });

  it("reports no-page instead of throwing when pupPage is not there", async () => {
    for (const c of [{}, { pupPage: null }, { pupPage: {} }, { pupPage: { evaluate: 3 } }]) {
      await expect(reactWithId(asClient(c), REAL_ID, "✅")).resolves.toMatchObject({
        ok: false,
        reason: "no-page",
      });
    }
  });

  it("never falls back to Message.react() — that is the silent no-op we are replacing", async () => {
    // A fallback that resolves without doing anything would reintroduce the
    // exact failure this module exists to make visible.
    const { client } = clientWith(async () => null);
    const out = await reactWithId(asClient(client), REAL_ID, "✅");
    expect(out.ok).toBe(false);
  });

  it("is total — it resolves rather than rejects for every input", async () => {
    const nasty = new Proxy(
      {},
      {
        get() {
          throw new Error("r");
        },
      },
    );
    await expect(reactWithId(asClient(nasty), REAL_ID, "✅")).resolves.toMatchObject({ ok: false });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("reactAndReport — the one-call form used by the scheduler", () => {
  function clientWith(evaluate: (...a: unknown[]) => unknown) {
    return { pupPage: { evaluate: vi.fn(evaluate) } };
  }

  let errs: string[];
  beforeEach(() => {
    errs = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("is completely silent when the reaction lands", async () => {
    const c = clientWith(async () => ({ ok: true }));
    await expect(reactAndReport(asClient(c), REAL_ID, "🪑", "update-reaction")).resolves.toEqual({
      delivered: true,
      reason: null,
    });
    expect(errs).toEqual([]);
  });

  it("reports the reason, the context and the id when it does not", async () => {
    // The scheduler's `update-reaction` used to log a bare
    // `update-reaction: message not found` warning — indistinguishable from
    // a broken page, and it ACKed anyway so the instruction never retried.
    const c = clientWith(async () => null);
    const out = await reactAndReport(asClient(c), REAL_ID, "🪑", "update-reaction");
    expect(out).toMatchObject({ delivered: false, reason: "unknown-result" });
    const joined = errs.join("\n");
    expect(joined).toContain("update-reaction");
    expect(joined).toContain(REAL_ID);
    expect(joined).toContain("unknown-result");
  });

  it("refuses a synthetic id without spending a page round-trip", async () => {
    const c = clientWith(async () => ({ ok: true }));
    const out = await reactAndReport(asClient(c), SYNTH_ID, "🪑", "update-reaction");
    expect(out).toMatchObject({ delivered: false, reason: "synthetic-id" });
    expect(c.pupPage.evaluate).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("synthetic-id");
  });

  it("never throws, whatever the client does", async () => {
    const c = clientWith(async () => {
      throw new Error("r");
    });
    await expect(reactAndReport(asClient(c), REAL_ID, "🪑", "x")).resolves.toMatchObject({
      delivered: false,
    });
    await expect(reactAndReport(asClient({}), REAL_ID, "🪑", "x")).resolves.toMatchObject({
      delivered: false,
      reason: "no-page",
    });
  });
});
