/**
 * The messages we sent, bounded, for Baileys' `getMessage` socket option.
 * Plan §2.12.
 *
 * ── Why `getMessage` is not optional ────────────────────────────────
 * When a recipient's phone cannot decrypt one of our messages it sends a
 * retry receipt, and Baileys re-encrypts the message for it, but only if
 * `getMessage(key)` can hand the message back. Without it the player sees
 * "waiting for this message" forever. HomeTenant supplies it for exactly
 * this reason and keeps the last 500.
 *
 * ── Why polls are pinned ────────────────────────────────────────────
 * A poll vote arrives encrypted, and decrypting it
 * (`getAggregateVotesInPollMessage`, Phase 4) needs the ORIGINAL poll and
 * its `messageSecret`. Man of the Match votes trickle in for a day and a
 * half after kickoff, long enough for ordinary sends (roster posts, DMs,
 * reactions) to push a poll out of a 500-entry window. So a pinned entry
 * lives in its own pen, which is ALSO bounded: pinning must never become
 * the leak that the bound exists to prevent.
 *
 * Keyed by message id alone. Ids are random and effectively unique, and a
 * retry receipt may name the chat in a different addressing form (a LID
 * where we sent to a phone JID), so keying on the chat too would miss.
 *
 * This is not a message store. It holds only what we sent, in this
 * process; a restart forgets it, which costs retries on messages sent
 * before the restart and nothing else.
 */

/** A send result, structurally: Baileys' `WAMessage` satisfies it. */
export interface SentLike<M> {
  key?: { id?: string | null } | null;
  message?: M | null;
}

export interface SentMessageStore<M> {
  /** Record a send result. Junk (no id, no message) is ignored. */
  remember(sent: SentLike<M> | null | undefined, opts?: { pin?: boolean }): void;
  /** The message we sent with this key's id, or undefined. */
  get(key: { id?: string | null; remoteJid?: string | null } | null | undefined): M | undefined;
  /** How many entries are held, pinned ones included. */
  size(): number;
}

/** HomeTenant's figure, which has held up in production. */
export const DEFAULT_SENT_MAX = 500;
/** About two seasons of weekly polls per group, for a handful of groups. */
export const DEFAULT_PINNED_MAX = 200;

export function createSentMessageStore<M = unknown>(
  opts: { max?: number; pinnedMax?: number } = {},
): SentMessageStore<M> {
  const max = opts.max ?? DEFAULT_SENT_MAX;
  const pinnedMax = opts.pinnedMax ?? DEFAULT_PINNED_MAX;
  const recent = new Map<string, M>();
  const pinned = new Map<string, M>();

  /** Insert as newest, evicting the oldest past `cap`. Map order is insertion order. */
  function put(map: Map<string, M>, cap: number, id: string, message: M): void {
    map.delete(id);
    map.set(id, message);
    while (map.size > cap) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  return {
    remember(sent, { pin = false } = {}) {
      const id = sent?.key?.id;
      const message = sent?.message;
      if (!id || !message) return;
      if (pin) put(pinned, pinnedMax, id, message);
      else put(recent, max, id, message);
    },
    get(key) {
      const id = key?.id;
      if (!id) return undefined;
      return pinned.get(id) ?? recent.get(id);
    },
    size() {
      return recent.size + pinned.size;
    },
  };
}
