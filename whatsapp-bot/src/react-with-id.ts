/**
 * Place a WhatsApp reaction using an id WE resolved, THROUGH the library.
 *
 * ── Why this exists (2026-08-31: reactions silently dead for days) ────
 * whatsapp-web.js 1.34.6, `src/structures/Message.js`:
 *
 *     async react(reaction){
 *         await this.client.pupPage.evaluate(async (messageId, reaction) => {
 *             if (!messageId) return null;                        // ← A
 *             const msg = window.Store.Msg.get(messageId)
 *               || (await window.Store.Msg.getMessagesById([messageId]))?.messages?.[0];
 *             if(!msg) return null;                               // ← B
 *             await window.Store.sendReactionToMsg(msg, reaction);
 *         }, this.id._serialized, reaction);
 *     }
 *
 * When WhatsApp Web's frontend changed, `id._serialized` became UNREADABLE
 * on inbound Message objects (the same breakage that produced the minified
 * `r: r` errors and forced `message-id.ts` into existence). So `react()`
 * passed `undefined`, took branch A, and **resolved**. No emoji, no throw,
 * so the try/catch around it never fired and every log line said healthy
 * while every player in a paying customer's group typed "in" and saw
 * nothing happen.
 *
 * `resolveWaMessageId()` (message-id.ts) reconstructs the canonical
 * `${fromMe}_${remote}_${id}` from the raw `_data.id` parts, which survive
 * the breakage. The fix was to react with THAT id instead of whatever the
 * Message object thinks its id is. The first version did so by running the
 * library's page code by hand, with our id, and naming every branch.
 *
 * ── Why it changed again (2026-09-16: 1.34.7 has no `window.Store`) ─
 * whatsapp-web.js 1.34.7, the only release whose injection matches the
 * live WhatsApp Web build, dropped `src/util/Injected/Store.js` entirely.
 * It injects `ExposeAuthStore` and `LoadUtils` only, and its own code uses
 * `window.require('<module>')` lookups instead of a `window.Store` facade.
 * Our hand-rolled page function read `window.Store.Msg` and every reaction
 * failed `store-unavailable`, five for five on the restart catch-up.
 *
 * The library's own path on 1.34.7 (`src/structures/Message.js:479`,
 * `src/Client.js:1567`):
 *
 *     async react(reaction) {
 *         return this.client.sendReaction(this.id._serialized, reaction);
 *     }
 *
 *     async sendReaction(messageId, reaction) {
 *         await this.pupPage.evaluate(async (messageId, reaction) => {
 *             if (!messageId) return null;
 *             const msg = window.require('WAWebCollections').Msg.get(messageId)
 *               || (await window.require('WAWebCollections').Msg.getMessagesById([messageId]))?.messages?.[0];
 *             if (!msg) return null;
 *             await window.require('WAWebSendReactionMsgAction').sendReactionToMsg(msg, reaction);
 *         }, messageId, reaction);
 *     }
 *
 * So the library now takes a SERIALISED ID directly, which is exactly what
 * we have. This module therefore runs NO page code of its own any more:
 *
 *   1. `client.getMessageById(ourId)` — the library's lookup. It returns
 *      `null` for an id the page does not know, which turns the library's
 *      silent branch B into a NAMED `message-not-found` before we ever
 *      reach it. (`getMessageById` goes through `getMessageModel`, the same
 *      conversion `Chat.fetchMessages` applies to every recovered message;
 *      it is healthy on this build — 400 messages through it today. The
 *      known-broken conversion is `getChatModel`, which this never calls.)
 *   2. `client.sendReaction(ourId, emoji)` — the library's own send, with
 *      OUR id, so the `this.id._serialized` read that went unreadable in
 *      August is never made. Branch A is closed by `planReaction`.
 *
 * The injected module names (`WAWebCollections`, `WAWebSendReactionMsgAction`)
 * are now the library's to keep in step with the frontend, which is where
 * that knowledge belongs: the last two outages were both us being pinned
 * to internals the library had moved on from.
 *
 * ── Shape of the module ──────────────────────────────────────────────
 * The DECISION logic (`planReaction`) is pure, and every way a reaction
 * can fail is a named reason. The thin, total adapter over the two
 * library calls now lives in `src/drivers/wwebjs.ts` as the driver's
 * `sendReaction`; see the note where it used to be. Nothing here ever
 * throws.
 */
import { isSyntheticWaMessageId } from "./message-id.js";

// ─── Vocabulary ─────────────────────────────────────────────────────

/** Why we did not even attempt a reaction. Not failures — decisions. */
export type ReactionSkipReason = "no-id" | "synthetic-id" | "no-emoji";

/**
 * Why an attempted reaction did not land. Every one of these is
 * DISTINGUISHABLE in the logs, deliberately: "reactions are broken" was the
 * only signal available during the August outage and it was not enough to
 * tell a dead page from a moved API from a message that had fallen out of
 * the cache.
 */
export const REACTION_FAILURE_REASONS = [
  "no-page",
  "library-api-unavailable",
  "lookup-threw",
  "message-not-found",
  "send-threw",
  // The Baileys driver's two (drivers/baileys.ts). It has no page, so
  // "no-page" would send an operator looking for a browser that is not
  // there, and it needs the whole message key, so an id it cannot turn
  // back into one is a failure of its own.
  "not-connected",
  "unparseable-id",
  // Not a failure at all: the Phase 5 shadow bot refusing to send
  // (`shadow.ts`). It is a reason rather than a throw because
  // `sendReaction` must never throw, and it is named rather than folded
  // into "send-threw" so a shadow run's log cannot be mistaken for a
  // broken reaction path.
  "shadow-mode",
] as const;

export type ReactionFailureReason = (typeof REACTION_FAILURE_REASONS)[number];

export type ReactionPlan =
  | { action: "react"; messageId: string; emoji: string }
  | { action: "skip"; reason: ReactionSkipReason };

export type ReactionOutcome =
  | { ok: true }
  | { ok: false; reason: ReactionFailureReason; detail?: string };

// ─── Pure decision ──────────────────────────────────────────────────

/**
 * Decide what to do with a resolved id and an emoji.
 *
 * Total: whatever it is handed — a throwing proxy included — it returns a
 * plan rather than exploding. A reaction is a confirmation; the attendance
 * write already happened server-side and must never be endangered by the
 * cosmetics.
 */
export function planReaction(waMessageId: unknown, emoji: unknown): ReactionPlan {
  let id: string;
  let e: string;
  try {
    id = typeof waMessageId === "string" ? waMessageId : "";
    e = typeof emoji === "string" ? emoji : "";
  } catch {
    return { action: "skip", reason: "no-id" };
  }

  if (id.length === 0) return { action: "skip", reason: "no-id" };

  // A `synthetic:` id is one WE invented for a message whose real id could
  // not be read (message-id.ts). WhatsApp never issued it, so no lookup in
  // the page can possibly resolve it. Attempting it would spend a page
  // round-trip to learn what we already know and would report a
  // misleading `message-not-found`. This is a genuine, documented
  // degradation — not a bug — and it is named as such.
  if (isSyntheticWaMessageId(id)) return { action: "skip", reason: "synthetic-id" };

  if (e.length === 0) return { action: "skip", reason: "no-emoji" };

  return { action: "react", messageId: id, emoji: e };
}

/** One line an operator can act on, per failure reason. */
export function describeReactionFailure(reason: ReactionFailureReason): string {
  switch (reason) {
    case "no-page":
      return (
        "the puppeteer page is not available on the client (client.pupPage missing) — the " +
        "browser session is down or still starting"
      );
    case "library-api-unavailable":
      return (
        "whatsapp-web.js exposes no client.getMessageById / client.sendReaction — this " +
        "build of the library renamed or removed the reaction API, so the bot needs updating"
      );
    case "lookup-threw":
      return (
        "client.getMessageById threw inside the page — whatsapp-web.js's injected code is " +
        "out of step with the live WhatsApp Web build (upgrade whatsapp-web.js)"
      );
    case "message-not-found":
      return (
        "the message id is not in the page's message store — it is genuinely unknown to this " +
        "session (very old, or from before the last re-pair)"
      );
    case "send-threw":
      return (
        "client.sendReaction threw — WhatsApp rejected the reaction, or the injected send " +
        "path is out of step with the live build (upgrade whatsapp-web.js)"
      );
    case "not-connected":
      return (
        "the Baileys socket is not connected, so nothing was sent; the line is down or " +
        "reconnecting"
      );
    case "unparseable-id":
      return (
        "the stored waMessageId is not one parseKey can turn back into a message key " +
        "(baileys/key.ts), so there is no message to react to"
      );
    case "shadow-mode":
      return (
        "this process is running in shadow mode (WA_SHADOW), so it sends nothing at all; " +
        "the reaction was logged and counted rather than placed, which is expected"
      );
  }
}

// ─── The adapter, and where it went ─────────────────────────────────

/**
 * `reactWithId` MOVED to `src/drivers/wwebjs.ts` in Phase 2 of the
 * Baileys migration (`MDs/baileys-migration-plan-2026-09-21.md`).
 *
 * It was the one function in this module that touched the library: the
 * `client.pupPage` presence check, `client.getMessageById`,
 * `client.sendReaction` and the `.call(c)` that both of them need because
 * they read `this.pupPage`. All of that is whatsapp-web.js, none of it is
 * a MatchTime decision, and it is exactly what Baileys replaces with a
 * single `sock.sendMessage(jid, { react })`. It is now the driver's
 * `sendReaction`, unchanged line for line, and the failure reasons below
 * are still the vocabulary it answers in.
 *
 * What stayed here is the part that is ours: WHEN to react
 * (`planReaction`), what each failure MEANS to an operator
 * (`describeReactionFailure`), and the one-call form the scheduler and
 * the flush use (`reactAndReport`).
 */

/** The one thing `reactAndReport` needs from a driver. */
export interface ReactionCapableDriver {
  sendReaction(waMessageId: string, emoji: string): Promise<ReactionOutcome>;
}

/**
 * React, and make any failure OBSERVABLE — the one-call form.
 *
 * Silent on success. On anything else it logs a single line naming the
 * caller's `context`, the id, the reason and what that reason means, and
 * hands the reason back so the caller can decide what else to do (the
 * batch path in smart-analysis.ts counts them for the CRITICAL line).
 *
 * `context` is a short label for the call site, e.g. "update-reaction".
 *
 * Never throws: a missing emoji must never endanger the surrounding work.
 */
export async function reactAndReport(
  driver: ReactionCapableDriver,
  waMessageId: string,
  emoji: string,
  context: string,
): Promise<{ delivered: boolean; reason: ReactionSkipReason | ReactionFailureReason | null }> {
  const plan = planReaction(waMessageId, emoji);
  if (plan.action === "skip") {
    console.error(
      `[react] ${context}: skipped ${emoji} for ${String(waMessageId)} — ${plan.reason}` +
        (plan.reason === "synthetic-id"
          ? " (this id was synthesised locally because the message's real WhatsApp id could " +
            "not be read, so there is no message in the page to react to)"
          : ""),
    );
    return { delivered: false, reason: plan.reason };
  }

  const outcome = await driver.sendReaction(plan.messageId, plan.emoji);
  if (outcome.ok) return { delivered: true, reason: null };

  console.error(
    `[react] ${context}: ${plan.emoji} NOT delivered for ${plan.messageId} — ` +
      `${outcome.reason}: ${describeReactionFailure(outcome.reason)}` +
      (outcome.detail ? ` (${outcome.detail})` : ""),
  );
  return { delivered: false, reason: outcome.reason };
}
