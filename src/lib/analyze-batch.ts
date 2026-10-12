/**
 * ONE MESSAGE, ONCE PER BATCH (PR #250 review, fix 7).
 *
 * POST /api/whatsapp/analyze drops a message it has already analysed by
 * looking its WhatsApp id up among the stored rows. That says nothing
 * about two copies of a NEW message inside one batch: both pass the
 * lookup. The Pi can build such a batch when a catch-up re-reads a message
 * the live handler has just buffered.
 *
 * Pure, and applied before the lookup. A batch with no repeated id comes
 * back as the very same array, so for every batch there has ever been
 * nothing changes.
 *
 * NOT covered, and not attempted here: two SEPARATE batches that carry the
 * same new message at the same instant. The stored-rows check is
 * check-then-act, not atomic.
 */
export function uniqueByWaMessageId<T extends { waMessageId: string }>(messages: T[]): T[] {
  const seen = new Set<string>();
  let repeated = false;
  for (const m of messages) {
    if (seen.has(m.waMessageId)) {
      repeated = true;
      break;
    }
    seen.add(m.waMessageId);
  }
  if (!repeated) return messages;
  seen.clear();
  return messages.filter((m) => (seen.has(m.waMessageId) ? false : (seen.add(m.waMessageId), true)));
}
