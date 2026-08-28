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
  /** Was the bot itself @-mentioned? */
  botMentioned: boolean;
}

/**
 * Run `enrich`, and on ANY failure fall back to the raw message body.
 *
 * Total: never throws, whatever `enrich` or `onDegrade` do (including a
 * synchronous throw, which is what kills `msg.getContact().catch(...)` when
 * `getContact` itself blows up rather than returning a rejected promise).
 */
export async function enrichOrDegrade(
  rawBody: string,
  enrich: () => Promise<InboundEnrichment> | InboundEnrichment,
  onDegrade: (err: unknown) => void,
): Promise<InboundEnrichment> {
  try {
    const e = await enrich();
    return {
      body: typeof e?.body === "string" && e.body.length > 0 ? e.body : rawBody,
      authorName: typeof e?.authorName === "string" && e.authorName ? e.authorName : null,
      botMentioned: e?.botMentioned === true,
    };
  } catch (err) {
    try {
      onDegrade(err);
    } catch {
      /* a broken logger must not break the pipeline either */
    }
    return { body: rawBody, authorName: null, botMentioned: false };
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
