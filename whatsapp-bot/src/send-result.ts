/**
 * Pure helpers for reading whatsapp-web.js `Client.sendMessage()` results.
 *
 * ── Why this exists (2026-08-28 prod breakage) ───────────────────────
 * `Client.sendMessage()` does NOT always resolve to a Message. Its own
 * source (whatsapp-web.js 1.34.6, `src/Client.js`) ends with:
 *
 *     const sentMsg = await this.pupPage.evaluate(async (...) => {
 *       const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
 *       if (!chat) return null;
 *       const msg = await window.WWebJS.sendMessage(chat, content, options);
 *       return msg ? window.WWebJS.getMessageModel(msg) : undefined;
 *     }, ...);
 *     return sentMsg ? new Message(this, sentMsg) : undefined;
 *
 * So `undefined` comes back whenever the injected page code can't build a
 * Message model — which is exactly what started happening when WhatsApp Web
 * shipped a frontend change during the summer break (`window.WWebJS.getChat`
 * began throwing the minified `r: r` error seen all over the Pi's logs).
 *
 * The scheduler then did `msg.id?._serialized`. Optional chaining guards
 * `id` being null but NOT `msg` being undefined, so it threw a TypeError
 * BEFORE the ACK ran. The WhatsApp message had already been delivered to the
 * customer group; the ACK never happened, `SentNotification.waMessageId`
 * stayed NULL, and under claim-on-dispatch (PR #9) the instruction is
 * already claimed so it never retries. Net effect: silent half-failure.
 *
 * These helpers make that path total: they never throw, whatever shape the
 * library hands back.
 */

/**
 * Serialized WhatsApp message id from a `sendMessage()` result, or
 * `undefined` when the library gave us nothing usable.
 *
 * Total: accepts `undefined`, `null`, primitives, objects with throwing
 * getters — anything. Never throws.
 */
export function waMessageIdFrom(sent: unknown): string | undefined {
  try {
    if (sent === null || typeof sent !== "object") return undefined;
    const id = (sent as { id?: unknown }).id;
    if (id === null || typeof id !== "object") return undefined;
    const serialized = (id as { _serialized?: unknown })._serialized;
    if (typeof serialized !== "string" || serialized.length === 0) return undefined;
    return serialized;
  } catch {
    // A throwing getter on a proxy/Message-like object must not take the
    // ACK down with it — that's the whole point of this module.
    return undefined;
  }
}

/**
 * True when `sendMessage()` handed back nothing at all (`undefined` from the
 * "couldn't build a Message model" path, or `null` from the channel/status
 * early return). A Message object with an unusable id is NOT this case — a
 * model was built, so the send demonstrably went through the normal path.
 */
export function isMissingSendResult(sent: unknown): boolean {
  return sent === undefined || sent === null;
}

/**
 * The loud log line for a missing send result.
 *
 * Deliberately CRITICAL-prefixed: this is a silent-data-loss class of event
 * (the message probably landed in the customer's group but we have no
 * WhatsApp id for it, so reactions on it can never be mapped back).
 */
export function missingSendResultMessage(kind: string, key: string): string {
  return (
    `CRITICAL: sendMessage returned undefined for ${kind} (${key}) — ` +
    "the WhatsApp message may have been delivered without an ack. " +
    "ACKing anyway (claim-on-dispatch means this instruction will never be " +
    "re-emitted, and a duplicate send is far worse than a missing id). " +
    "waMessageId will be NULL, so reaction tracking for this message is lost. " +
    "This usually means whatsapp-web.js's injected page code is out of step " +
    "with the live WhatsApp Web build — consider pinning WA_WEB_VERSION."
  );
}
