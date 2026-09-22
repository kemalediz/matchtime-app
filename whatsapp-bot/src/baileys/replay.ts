/**
 * The last few messages per chat, in memory, bounded.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 * whatsapp-web.js served the restart catch-up (`recoverGroupMessages`)
 * out of the page's own message store: `chat.fetchMessages({limit})` asked
 * a browser that had already synced the chat. Baileys keeps no store at
 * all. It is a real linked device, so the THEORY is that WhatsApp buffers
 * what arrives while the process is down and delivers it on reconnect,
 * which would mean the catch-up can simply read what the socket has
 * already handed us. Whether that happens, and as `notify` or as
 * `append`, is the plan's open measurement (§2.15) and the first thing
 * the Phase 5 shadow run does.
 *
 * So this is the version that works IF the replay happens: remember every
 * message the socket delivers, hand it back when the catch-up asks. If it
 * turns out the replay does not happen, this serves nothing, the driver's
 * `[baileys][history]` line says so, and the answer is to rebuild the
 * catch-up on `fetchMessageHistory` (see the driver, and Phase 5 in the
 * plan).
 *
 * ── Why it is bounded twice ─────────────────────────────────────────
 * The Pi runs for weeks without a restart. A per-chat cap alone would
 * still grow forever in the number of chats, and the bot sees every group
 * it is in plus every DM. So the number of chats is capped too, least
 * recently written out first. Both caps drop the OLDEST, because the
 * catch-up only ever asks for the newest few.
 *
 * Pure, and no Baileys import: it stores whatever the driver hands it.
 */

export interface ReplayBuffer<T> {
  /** Remember a message in a chat. A blank chat id is ignored. */
  remember(chatId: string, msg: T): void;
  /** The newest `limit` messages in the chat, NEWEST FIRST. */
  recent(chatId: string, limit: number): T[];
  /** How many are held for this chat. */
  count(chatId: string): number;
  /** How many chats are held. */
  chats(): number;
  /** How many messages have been offered since the process started. */
  remembered(): number;
}

/**
 * Enough for the catch-up's default of 50 and its widest documented
 * override, without holding a week of a busy group.
 */
export const DEFAULT_REPLAY_PER_CHAT = 120;
/** Sutton is one group; a bot in two dozen chats is already unusual. */
export const DEFAULT_REPLAY_CHATS = 24;

export function createReplayBuffer<T>(
  opts: { perChat?: number; chats?: number } = {},
): ReplayBuffer<T> {
  const perChat = Math.max(1, opts.perChat ?? DEFAULT_REPLAY_PER_CHAT);
  const maxChats = Math.max(1, opts.chats ?? DEFAULT_REPLAY_CHATS);
  // Insertion-ordered, and re-inserted on every write, so the first key is
  // always the chat written to longest ago.
  const byChat = new Map<string, T[]>();
  let offered = 0;

  return {
    remember(chatId, msg) {
      if (typeof chatId !== "string" || chatId.length === 0) return;
      offered++;
      const held = byChat.get(chatId) ?? [];
      byChat.delete(chatId);
      held.push(msg);
      while (held.length > perChat) held.shift();
      byChat.set(chatId, held);
      while (byChat.size > maxChats) {
        const oldest = byChat.keys().next().value;
        if (oldest === undefined) break;
        byChat.delete(oldest);
      }
    },

    recent(chatId, limit) {
      if (!Number.isFinite(limit) || limit <= 0) return [];
      const held = byChat.get(chatId);
      if (!held || held.length === 0) return [];
      return held.slice(Math.max(0, held.length - Math.floor(limit))).reverse();
    },

    count(chatId) {
      return byChat.get(chatId)?.length ?? 0;
    },

    chats() {
      return byChat.size;
    },

    remembered() {
      return offered;
    },
  };
}
