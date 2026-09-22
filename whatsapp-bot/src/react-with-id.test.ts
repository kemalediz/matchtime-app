/**
 * RED-first spec for reacting with an id WE resolved, THROUGH the library.
 *
 * ── The bug this module was born to kill (2026-08-31) ────────────────
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
 * `id._serialized` became unreadable on inbound Message objects, so
 * `react()` passed `undefined`, took the first `return null`, and RESOLVED.
 * No emoji, no throw. Reactions were dead for days while every log line
 * said healthy. The first fix ran that same page code by hand with OUR id.
 *
 * ── The bug this REVISION kills (2026-09-16) ─────────────────────────
 * whatsapp-web.js 1.34.7 (the only build whose injection matches the live
 * WhatsApp Web frontend) has NO `window.Store`. Our hand-rolled page code
 * read `window.Store.Msg` and every single reaction failed with
 * `store-unavailable`; the text catch-up covered the players, but a text
 * post per flush is not the product. The library itself now does
 *
 *     Message.react(reaction)  →  client.sendReaction(this.id._serialized, reaction)
 *
 * where `Client.sendReaction` uses `window.require('WAWebCollections')` and
 * `window.require('WAWebSendReactionMsgAction')`, i.e. module lookups the
 * library owns and keeps in step with the frontend.
 *
 * ── What these tests pin ─────────────────────────────────────────────
 * 1. The reaction goes through the LIBRARY's `client.getMessageById` and
 *    `client.sendReaction`. No hand-rolled `pupPage.evaluate` — a fake page
 *    whose `evaluate` throws (the 1.34.7 page, with no `window.Store`) must
 *    not be touched at all.
 * 2. The id used is OUR resolved id, passed explicitly to BOTH calls —
 *    never `msg.id._serialized` (that is what `Message.react()` reads, and
 *    it is the read that went unreadable in August).
 * 3. `client.sendReaction` still has the library's silent `return null` for
 *    an unknown id, so it is NEVER fired blind: the message is looked up
 *    first and a miss is a named `message-not-found`.
 * 4. A `synthetic:` id is never attempted.
 * 5. EVERY failure is named and distinguishable. Nothing in here throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  planReaction,
  reactAndReport,
  describeReactionFailure,
  REACTION_FAILURE_REASONS,
  type ReactionCapableDriver,
  type ReactionFailureReason,
} from "./react-with-id.js";
import { makeWwebjsDriver, type WwebjsClientLike } from "./drivers/wwebjs.js";

const REAL_ID = "false_447525334985-1607872139@g.us_3B0B7E9";
/** The 4-part form `Chat.fetchMessages` hands back for a group message (the recovery walk). */
const RECOVERED_ID =
  "false_447525334985-1607872139@g.us_AC7E5E8D85C46B15C947935009390D7D_76643825668299@lid";
const SYNTH_ID = "synthetic:9f2c1ab34d5e6f70";

/**
 * Phase 2 (MDs/baileys-migration-plan-2026-09-21.md) moved the adapter
 * (the `pupPage` check, `getMessageById`, `sendReaction` and the `.call(c)`
 * both of those need) into the whatsapp-web.js driver, where it is
 * `sendReaction`. It moved without being rewritten, so this spec is
 * UNCHANGED below: same fake clients, same assertions, now reached through
 * the seam. `reactWithId` is a two-line shim so that stays visibly true.
 */
const asClient = (c: unknown) => makeWwebjsDriver(c as unknown as WwebjsClientLike);
const reactWithId = (driver: ReactionCapableDriver, messageId: string, emoji: string) =>
  driver.sendReaction(messageId, emoji);

/**
 * The 1.34.7 page: any hand-rolled evaluate that reaches for `window.Store`
 * blows up, exactly as it did in production on 2026-09-16.
 */
function storelessPage() {
  return {
    evaluate: vi.fn(async () => {
      throw new Error(
        "Evaluation failed: TypeError: Cannot read properties of undefined (reading 'Msg')",
      );
    }),
  };
}

/** What the library hands back from `getMessageById` on a hit. */
function libraryMessage() {
  return {
    // A DIFFERENT serialised id on purpose: if anything reads it back off
    // the Message instead of using the id we resolved, the assertion that
    // sendReaction received OUR id turns red.
    id: { _serialized: "NOT-THE-ID-WE-RESOLVED" },
    react: vi.fn(async () => undefined),
  };
}

type Lib = {
  getMessageById?: (id: string) => unknown;
  sendReaction?: (id: string, emoji: string) => unknown;
};

/** A client whose ONLY working route to a reaction is the library's own API. */
function clientWith(lib: Lib = {}) {
  const found = libraryMessage();
  const getMessageById = vi.fn(async (id: string) =>
    lib.getMessageById ? lib.getMessageById(id) : found,
  );
  const sendReaction = vi.fn(async (id: string, emoji: string) =>
    lib.sendReaction ? lib.sendReaction(id, emoji) : undefined,
  );
  const pupPage = storelessPage();
  return {
    client: { pupPage, getMessageById, sendReaction },
    getMessageById,
    sendReaction,
    pupPage,
    found,
  };
}

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
    // `synthetic:` ids are ours, not WhatsApp's. No lookup can resolve one,
    // and we'd burn a page round-trip to learn what we already know.
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

  it("no longer knows a `store-unavailable` — there is no window.Store to be unavailable", () => {
    // The reason vocabulary is the operator's map. A reason that can no
    // longer occur would send them looking for a Store that 1.34.7 never
    // defines.
    expect(REACTION_FAILURE_REASONS).not.toContain("store-unavailable");
    expect(REACTION_FAILURE_REASONS).not.toContain("send-reaction-unavailable");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("reactWithId — through the library, on a page with no window.Store", () => {
  it("lands the reaction WITHOUT evaluating any page code of its own", async () => {
    // THE regression test for 2026-09-16. The page's evaluate throws on
    // anything that touches window.Store; the reaction must still land.
    const c = clientWith();
    await expect(reactWithId(asClient(c.client), REAL_ID, "✅")).resolves.toEqual({ ok: true });

    expect(c.pupPage.evaluate).not.toHaveBeenCalled();
    expect(c.getMessageById).toHaveBeenCalledWith(REAL_ID);
    expect(c.sendReaction).toHaveBeenCalledWith(REAL_ID, "✅");
  });

  it("hands OUR id to sendReaction — never msg.id._serialized", async () => {
    // `Message.react()` is `client.sendReaction(this.id._serialized, …)`.
    // That read is the one that went unreadable in August; we already hold
    // the right id, so nothing may re-derive it from the Message.
    const c = clientWith();
    await reactWithId(asClient(c.client), REAL_ID, "✅");

    expect(c.sendReaction.mock.calls[0]?.[0]).toBe(REAL_ID);
    expect(c.sendReaction.mock.calls[0]?.[0]).not.toBe("NOT-THE-ID-WE-RESOLVED");
    expect(c.found.react).not.toHaveBeenCalled();
  });

  it("passes a recovered 4-part id (participant suffix) through verbatim", async () => {
    // The restart catch-up reads the group with `Chat.fetchMessages`, whose
    // Message ids carry the `_<participant>@lid` suffix. Those are the ids
    // that failed five-for-five today; they must work as-is.
    const c = clientWith();
    await expect(reactWithId(asClient(c.client), RECOVERED_ID, "✅")).resolves.toEqual({
      ok: true,
    });
    expect(c.getMessageById).toHaveBeenCalledWith(RECOVERED_ID);
    expect(c.sendReaction).toHaveBeenCalledWith(RECOVERED_ID, "✅");
  });

  it("reports message-not-found when the lookup misses, and does NOT fire sendReaction blind", async () => {
    // `Client.sendReaction` keeps the library's `if (!msg) return null;`.
    // Firing it for an id the page does not know would resolve as if it had
    // worked — the exact silent no-op this module exists to make visible.
    const c = clientWith({ getMessageById: () => null });
    await expect(reactWithId(asClient(c.client), REAL_ID, "✅")).resolves.toMatchObject({
      ok: false,
      reason: "message-not-found",
    });
    expect(c.sendReaction).not.toHaveBeenCalled();
  });

  it("reports lookup-threw, with the cause, when getMessageById blows up in the page", async () => {
    const c = clientWith({
      getMessageById: () => {
        throw new Error("Evaluation failed: r");
      },
    });
    const out = await reactWithId(asClient(c.client), REAL_ID, "✅");
    expect(out).toMatchObject({ ok: false, reason: "lookup-threw" });
    expect(JSON.stringify(out)).toContain("Evaluation failed: r");
    expect(c.sendReaction).not.toHaveBeenCalled();
  });

  it("reports send-threw, with the cause, when sendReaction rejects", async () => {
    const c = clientWith({
      sendReaction: () => {
        throw new Error("Evaluation failed: r");
      },
    });
    const out = await reactWithId(asClient(c.client), REAL_ID, "✅");
    expect(out).toMatchObject({ ok: false, reason: "send-threw" });
    expect(JSON.stringify(out)).toContain("Evaluation failed: r");
  });

  it("reports no-page instead of throwing when the browser session is not there", async () => {
    for (const c of [{}, { pupPage: null }, { pupPage: undefined }]) {
      await expect(
        reactWithId(
          asClient({ ...c, getMessageById: vi.fn(), sendReaction: vi.fn() }),
          REAL_ID,
          "✅",
        ),
      ).resolves.toMatchObject({ ok: false, reason: "no-page" });
    }
  });

  it("reports library-api-unavailable when the client has no getMessageById / sendReaction", async () => {
    // A future whatsapp-web.js that renames either method must show up as
    // its own reason, not as a TypeError dressed up as something else.
    for (const c of [
      { pupPage: storelessPage() },
      { pupPage: storelessPage(), getMessageById: vi.fn() },
      { pupPage: storelessPage(), sendReaction: vi.fn() },
    ]) {
      await expect(reactWithId(asClient(c), REAL_ID, "✅")).resolves.toMatchObject({
        ok: false,
        reason: "library-api-unavailable",
      });
    }
  });

  it("never falls back to Message.react() — that is the silent no-op we replaced", async () => {
    const c = clientWith({
      sendReaction: () => {
        throw new Error("r");
      },
    });
    const out = await reactWithId(asClient(c.client), REAL_ID, "✅");
    expect(out.ok).toBe(false);
    expect(c.found.react).not.toHaveBeenCalled();
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
  let errs: string[];
  beforeEach(() => {
    errs = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("is completely silent when the reaction lands", async () => {
    const c = clientWith();
    await expect(
      reactAndReport(asClient(c.client), REAL_ID, "🪑", "update-reaction"),
    ).resolves.toEqual({ delivered: true, reason: null });
    expect(errs).toEqual([]);
  });

  it("reports the reason, the context and the id when it does not", async () => {
    // The scheduler's `update-reaction` used to log a bare
    // `update-reaction: message not found` warning — indistinguishable from
    // a broken page, and it ACKed anyway so the instruction never retried.
    const c = clientWith({ getMessageById: () => null });
    const out = await reactAndReport(asClient(c.client), REAL_ID, "🪑", "update-reaction");
    expect(out).toMatchObject({ delivered: false, reason: "message-not-found" });
    const joined = errs.join("\n");
    expect(joined).toContain("update-reaction");
    expect(joined).toContain(REAL_ID);
    expect(joined).toContain("message-not-found");
  });

  it("refuses a synthetic id without touching the library at all", async () => {
    const c = clientWith();
    const out = await reactAndReport(asClient(c.client), SYNTH_ID, "🪑", "update-reaction");
    expect(out).toMatchObject({ delivered: false, reason: "synthetic-id" });
    expect(c.getMessageById).not.toHaveBeenCalled();
    expect(c.sendReaction).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("synthetic-id");
  });

  it("never throws, whatever the client does", async () => {
    const c = clientWith({
      getMessageById: () => {
        throw new Error("r");
      },
    });
    await expect(reactAndReport(asClient(c.client), REAL_ID, "🪑", "x")).resolves.toMatchObject({
      delivered: false,
    });
    await expect(reactAndReport(asClient({}), REAL_ID, "🪑", "x")).resolves.toMatchObject({
      delivered: false,
      reason: "no-page",
    });
  });
});
