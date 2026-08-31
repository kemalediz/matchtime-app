/**
 * Place a WhatsApp reaction using an id WE resolved.
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
 * Since WhatsApp Web's frontend changed, `id._serialized` is UNREADABLE on
 * inbound Message objects (the same breakage that produced the minified
 * `r: r` errors and forced `message-id.ts` into existence). So `react()`
 * passed `undefined`, took branch A, and **resolved**. No emoji, no throw.
 *
 * That is why nothing caught it: `smart-analysis.ts` wrapped `target.react()`
 * in a try/catch, so a THROW would have been reported as CRITICAL and the
 * players would have got the text catch-up. A silent resolve looks exactly
 * like success. Every log line said the bot was healthy while every player
 * in a paying customer's group typed "in" and saw nothing happen.
 *
 * ── The fix ──────────────────────────────────────────────────────────
 * We already have the right id. `resolveWaMessageId()` (message-id.ts)
 * RECONSTRUCTS the canonical `${fromMe}_${remote}_${id}` string from the raw
 * `_data.id` parts, which survive the breakage — production counters showed
 * `reconstructed=9, synthetic=0`, i.e. every recent inbound message yielded a
 * real, correctly-formatted id, and the database confirms the shape
 * (`false_447525334985-1607872139@g.us_3B0B7E9`). We simply never passed it
 * to the reaction call.
 *
 * So: run the same page code the library runs, but hand it OUR id, and
 * return a STRUCTURED RESULT so every way it can fail is named. The library's
 * two `return null` branches are the reason this went unnoticed for days;
 * this module has no unnamed outcome at all — even an unrecognised return
 * value maps to a loud `unknown-result`.
 *
 * ── Shape of the module ──────────────────────────────────────────────
 * The `pupPage.evaluate` boundary cannot be unit-tested, so the DECISION
 * logic (`planReaction`, `interpretReactionResult`) is pure and fully
 * tested, the page function is exported and tested against a stubbed
 * `window`, and `reactWithId` is the thinnest possible adapter over
 * `evaluate` around them.
 */
import type { Client } from "whatsapp-web.js";
import { isSyntheticWaMessageId } from "./message-id.js";

// ─── Vocabulary ─────────────────────────────────────────────────────

/** Why we did not even attempt a reaction. Not failures — decisions. */
export type ReactionSkipReason = "no-id" | "synthetic-id" | "no-emoji";

/**
 * Why an attempted reaction did not land. Every one of these is
 * DISTINGUISHABLE in the logs, deliberately: "reactions are broken" was the
 * only signal available during the outage and it was not enough to tell a
 * stale page from a renamed Store method from a message that had fallen out
 * of the cache.
 */
export const REACTION_FAILURE_REASONS = [
  "no-page",
  "store-unavailable",
  "send-reaction-unavailable",
  "lookup-threw",
  "message-not-found",
  "send-threw",
  "evaluate-threw",
  "unknown-result",
] as const;

export type ReactionFailureReason = (typeof REACTION_FAILURE_REASONS)[number];

export type ReactionPlan =
  | { action: "react"; messageId: string; emoji: string }
  | { action: "skip"; reason: ReactionSkipReason };

export type ReactionOutcome =
  | { ok: true }
  | { ok: false; reason: ReactionFailureReason; detail?: string };

const FAILURE_REASON_SET = new Set<string>(REACTION_FAILURE_REASONS);

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
  // not be read (message-id.ts). WhatsApp never issued it, so `Store.Msg.get`
  // and `getMessagesById` cannot possibly resolve it. Attempting it would
  // spend a page round-trip to learn what we already know and would report a
  // misleading `message-not-found`. This is a genuine, documented
  // degradation — not a bug — and it is named as such.
  if (isSyntheticWaMessageId(id)) return { action: "skip", reason: "synthetic-id" };

  if (e.length === 0) return { action: "skip", reason: "no-emoji" };

  return { action: "react", messageId: id, emoji: e };
}

/**
 * Map whatever came back out of the page onto a definite outcome.
 *
 * The critical case is `null`/`undefined`: that is EXACTLY what the library's
 * `react()` resolved to for days while doing nothing. It must never again be
 * mistaken for success, so it becomes a named failure.
 */
export function interpretReactionResult(raw: unknown): ReactionOutcome {
  if (raw !== null && typeof raw === "object") {
    const r = raw as { ok?: unknown; reason?: unknown; detail?: unknown };
    if (r.ok === true) return { ok: true };
    if (r.ok === false) {
      const reason = typeof r.reason === "string" ? r.reason : "";
      if (FAILURE_REASON_SET.has(reason)) {
        const out: ReactionOutcome = { ok: false, reason: reason as ReactionFailureReason };
        if (typeof r.detail === "string" && r.detail.length > 0) out.detail = r.detail;
        return out;
      }
      // A reason this build does not know about: still a failure, and the
      // unrecognised string is preserved so the log can show it.
      return {
        ok: false,
        reason: "unknown-result",
        detail: `unrecognised reason ${JSON.stringify(r.reason)}`,
      };
    }
  }
  return {
    ok: false,
    reason: "unknown-result",
    detail:
      raw === null || raw === undefined
        ? "the page returned null/undefined — the signature of whatsapp-web.js's silent " +
          "`return null` no-op branches"
        : `unexpected return value ${JSON.stringify(raw)}`,
  };
}

/** One line an operator can act on, per failure reason. */
export function describeReactionFailure(reason: ReactionFailureReason): string {
  switch (reason) {
    case "no-page":
      return (
        "the puppeteer page is not available on the client (client.pupPage missing or not " +
        "usable) — the browser session is down or still starting"
      );
    case "store-unavailable":
      return (
        "window.Store / window.Store.Msg is absent inside the page — whatsapp-web.js's " +
        "injected layer did not attach, or WhatsApp Web changed its module layout"
      );
    case "send-reaction-unavailable":
      return (
        "window.Store.sendReactionToMsg is absent inside the page — WhatsApp Web renamed or " +
        "moved the reaction API, so whatsapp-web.js needs upgrading"
      );
    case "lookup-threw":
      return (
        "looking the message up in the page (Store.Msg.get / getMessagesById) threw — the " +
        "injected layer is out of step with the live WhatsApp Web build"
      );
    case "message-not-found":
      return (
        "the message id is not in the page's message store — it is genuinely unknown to this " +
        "session (very old, or from before the last re-pair)"
      );
    case "send-threw":
      return "Store.sendReactionToMsg itself threw — WhatsApp rejected the reaction";
    case "evaluate-threw":
      return (
        "pupPage.evaluate threw before/while running — the page is gone, navigating, or the " +
        "injected code is broken"
      );
    case "unknown-result":
      return (
        "the page returned something this build does not understand (including the bare " +
        "`null` that whatsapp-web.js's own react() silently resolves to when the id is " +
        "unreadable) — treated as a failure ON PURPOSE so it can never look like success"
      );
  }
}

// ─── The page function ──────────────────────────────────────────────

/**
 * Runs INSIDE the WhatsApp Web page (serialised by puppeteer), so it must be
 * self-contained: no imports, no closure variables, only globals.
 *
 * Same lookup the library performs, with three deliberate differences:
 *  - it is given OUR id rather than reading `this.id._serialized`;
 *  - every branch returns a NAMED result instead of `null`;
 *  - `window.Store`, `window.Store.Msg` and `window.Store.sendReactionToMsg`
 *    are checked before use, so a half-attached injected layer reports
 *    itself rather than producing an unhandled error inside the page.
 *
 * Exported so the branch logic is unit-testable against a stubbed `window`.
 */
export async function reactionPageFunction(
  messageId: string,
  reaction: string,
): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }> {
  if (!messageId) return { ok: false, reason: "no-id" };

  const store = (globalThis as { window?: { Store?: Record<string, unknown> } }).window?.Store;
  const msgStore = store?.Msg as
    | { get?: (id: string) => unknown; getMessagesById?: (ids: string[]) => Promise<unknown> }
    | undefined;
  if (!store || !msgStore) return { ok: false, reason: "store-unavailable" };

  const send = store.sendReactionToMsg as
    | ((msg: unknown, reaction: string) => Promise<unknown>)
    | undefined;
  if (typeof send !== "function") return { ok: false, reason: "send-reaction-unavailable" };

  let msg: unknown;
  try {
    msg = typeof msgStore.get === "function" ? msgStore.get(messageId) : null;
    if (!msg && typeof msgStore.getMessagesById === "function") {
      const fetched = (await msgStore.getMessagesById([messageId])) as
        | { messages?: unknown[] }
        | null
        | undefined;
      msg = fetched?.messages?.[0];
    }
  } catch (err) {
    return { ok: false, reason: "lookup-threw", detail: String(err) };
  }
  if (!msg) return { ok: false, reason: "message-not-found" };

  try {
    // Called as a METHOD ON Store, exactly as whatsapp-web.js does
    // (`window.Store.sendReactionToMsg(...)`). Calling a detached reference
    // would silently change `this` inside WhatsApp's own implementation.
    await (store as { sendReactionToMsg: (m: unknown, r: string) => Promise<unknown> })
      .sendReactionToMsg(msg, reaction);
  } catch (err) {
    return { ok: false, reason: "send-threw", detail: String(err) };
  }
  return { ok: true };
}

// ─── The adapter ────────────────────────────────────────────────────

/**
 * Place `emoji` on the message with `messageId`, using the puppeteer page
 * directly.
 *
 * Deliberately does NOT fall back to `Message.react()`: that call resolves
 * without doing anything when it cannot read an id, which is precisely the
 * silent success this module exists to eliminate. A named failure that
 * triggers the text catch-up beats a fake success every time.
 *
 * Never throws.
 */
export async function reactWithId(
  client: Client,
  messageId: string,
  emoji: string,
): Promise<ReactionOutcome> {
  let evaluate: ((...args: unknown[]) => Promise<unknown>) | undefined;
  try {
    const page = (client as unknown as { pupPage?: { evaluate?: unknown } } | null | undefined)
      ?.pupPage;
    const fn = page?.evaluate;
    if (typeof fn === "function") {
      evaluate = (...args: unknown[]) =>
        (fn as (...a: unknown[]) => Promise<unknown>).apply(page, args);
    }
  } catch {
    // A throwing getter on the client must not take the flush down.
    evaluate = undefined;
  }
  if (!evaluate) {
    return { ok: false, reason: "no-page", detail: describeReactionFailure("no-page") };
  }

  try {
    const raw = await evaluate(reactionPageFunction, messageId, emoji);
    return interpretReactionResult(raw);
  } catch (err) {
    return {
      ok: false,
      reason: "evaluate-threw",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * React, and make any failure OBSERVABLE — the one-call form.
 *
 * Silent on success. On anything else it logs a single line naming the
 * caller's `context`, the id, the reason and what that reason means, and
 * hands the reason back so the caller can decide what else to do (the
 * batch path in smart-analysis.ts collects them for the text catch-up).
 *
 * `context` is a short label for the call site, e.g. "update-reaction".
 *
 * Never throws: a missing emoji must never endanger the surrounding work.
 */
export async function reactAndReport(
  client: Client,
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

  const outcome = await reactWithId(client, plan.messageId, plan.emoji);
  if (outcome.ok) return { delivered: true, reason: null };

  console.error(
    `[react] ${context}: ${plan.emoji} NOT delivered for ${plan.messageId} — ` +
      `${outcome.reason}: ${describeReactionFailure(outcome.reason)}` +
      (outcome.detail ? ` (${outcome.detail})` : ""),
  );
  return { delivered: false, reason: outcome.reason };
}
