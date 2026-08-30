/**
 * Pure core for the inbound-message pipeline's failure modes.
 *
 * ── Why (2026-08-28 prod breakage) ───────────────────────────────────
 * Every inbound group message is "enriched" on the Pi before it is sent to
 * the server-side analyzer: the author's pushname is fetched, @-mention JIDs
 * are resolved to names, and the bot works out whether it was tagged. All of
 * that goes through whatsapp-web.js contact/chat lookups — i.e. through the
 * injected page code that broke against the current WhatsApp Web build.
 *
 * Enrichment is a NICE-TO-HAVE. Delivery to `/api/whatsapp/analyze` is the
 * whole product: if a message doesn't reach the analyzer, attendance is not
 * recorded and a customer turns up to a match with no roster. So enrichment
 * must be allowed to fail loudly and degrade, never to abort the pipeline.
 */

export interface InboundEnrichment {
  /** Mention-resolved message body. Falls back to the raw body. */
  body: string;
  /** WhatsApp pushname / contact name, or null when it couldn't be resolved. */
  authorName: string | null;
  /**
   * Sender's phone as bare digits, or "" when there isn't one.
   *
   * Starts as whatever the sender's JID gave us (empty for an `@lid`
   * privacy sender) and can be UPGRADED by enrichment via `Contact.number`,
   * which resolves an `@lid` to a real phone when the injected layer is
   * healthy. A phone is the server's strongest identity signal, so it is
   * worth the extra read.
   */
  authorPhone: string;
  /** Was the bot itself @-mentioned? */
  botMentioned: boolean;
}

/**
 * Run `enrich`, and fall back — PER FIELD — to `fallback` for anything it
 * could not produce.
 *
 * `fallback` is a whole enrichment, not just the raw body. That is the
 * 2026-08-30 change and the point of this function: the old version could
 * only preserve the message TEXT, and threw the sender's identity away,
 * because the only source of a name was `msg.getContact()` — an injected
 * page call that dies exactly when the fallback is needed. The caller now
 * builds an identity from the raw payload (`_data.notifyName`, the author
 * JID) BEFORE enrichment, so a degraded message still says who spoke and
 * the server can still register their attendance.
 *
 * Per-field rather than all-or-nothing because the common failure is
 * PARTIAL: `getContact()` throws while mention resolution completes fine.
 * Discarding the good half of a half-good enrichment loses information for
 * no reason.
 *
 * Total: never throws, whatever `enrich`, `onDegrade` or `fallback` do
 * (including a synchronous throw, which is what kills
 * `msg.getContact().catch(...)` when `getContact` itself blows up rather
 * than returning a rejected promise).
 */
export async function enrichOrDegrade(
  fallback: InboundEnrichment,
  enrich: () => Promise<InboundEnrichment> | InboundEnrichment,
  onDegrade: (err: unknown) => void,
): Promise<InboundEnrichment> {
  const base: InboundEnrichment = {
    body: typeof fallback?.body === "string" ? fallback.body : "",
    authorName:
      typeof fallback?.authorName === "string" && fallback.authorName.trim()
        ? fallback.authorName.trim()
        : null,
    authorPhone: typeof fallback?.authorPhone === "string" ? fallback.authorPhone : "",
    botMentioned: fallback?.botMentioned === true,
  };
  try {
    const e = await enrich();
    return {
      body: typeof e?.body === "string" && e.body.length > 0 ? e.body : base.body,
      authorName:
        typeof e?.authorName === "string" && e.authorName.trim()
          ? e.authorName.trim()
          : base.authorName,
      authorPhone:
        typeof e?.authorPhone === "string" && e.authorPhone.length > 0
          ? e.authorPhone
          : base.authorPhone,
      botMentioned: e?.botMentioned === true || base.botMentioned,
    };
  } catch (err) {
    try {
      onDegrade(err);
    } catch {
      /* a broken logger must not break the pipeline either */
    }
    // botMentioned cannot be recovered from the raw payload (only the Pi
    // knows its own JID and that read goes through the broken layer), so it
    // degrades to the fallback's value — normally false.
    return base;
  }
}

export interface RetryablePending {
  attempts: number;
}

/**
 * Decide what to do with a batch whose analyze POST just failed.
 *
 * Before this, `flushGroup` cleared the buffer optimistically and returned
 * on a POST failure — a transient network blip silently binned a batch of
 * IN/OUT messages. Requeueing forever risks a poison batch looping, so the
 * attempt count is carried per message and the batch is dropped once it hits
 * the ceiling. (Losing them is still survivable: `recoverGroupMessages`
 * re-feeds the last 2h on restart and the server dedupes on waMessageId.)
 *
 * Pure — returns new objects, never mutates the input.
 */
export function planFlushRetry<T extends RetryablePending>(
  pending: T[],
  maxAttempts: number,
): { requeue: T[]; dropped: T[] } {
  const requeue: T[] = [];
  const dropped: T[] = [];
  for (const p of pending) {
    const next = { ...p, attempts: (p.attempts ?? 0) + 1 };
    if (next.attempts >= maxAttempts) dropped.push(next);
    else requeue.push(next);
  }
  return { requeue, dropped };
}
