/**
 * "Have I already seen this message id?", bounded.
 *
 * Baileys can hand the same message over twice: a reconnect that lands
 * mid-delivery, or a decrypt that was retried. whatsapp-web.js did not do
 * this, so nothing downstream expects it.
 *
 * The server also dedupes on `waMessageId` (`AnalyzedMessage.waMessageId`
 * is unique), so this is not the correctness boundary. It saves a round
 * trip, and it keeps the bot's own counters honest.
 *
 * Bounded, because a bot that has been up for a fortnight would otherwise
 * be holding every id it had ever seen. A `Set`'s iteration order is
 * insertion order, so the first key is the oldest.
 */

export const DEFAULT_SEEN_MAX = 2000;

/**
 * Returns a predicate that answers "is this the first time?" and records
 * the answer. An empty id is always treated as first, because collapsing
 * every id-less message into one would be worse than paying for a repeat.
 */
export function createSeenIds(max = DEFAULT_SEEN_MAX): (id: string) => boolean {
  const seen = new Set<string>();
  return (id: string): boolean => {
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > max) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  };
}
