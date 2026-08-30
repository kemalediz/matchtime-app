/**
 * Text confirmation for players whose ✅ / 🪑 reaction could not be delivered.
 *
 * ── The rule this protects ───────────────────────────────────────────
 * A player types "in"; the bot reacts ✅ on their message (🪑 if they land
 * on the bench). That reaction is the ENTIRE feedback loop: it is how the
 * player knows they are on the roster, and it is why the bot does not reply
 * in words to every "in" (twenty text confirmations in an evening would be
 * intolerable in a customer's group).
 *
 * `Message.react()` reads `this.id._serialized` and then calls into the
 * injected page code, so on a build mismatch it throws for EVERY message.
 * The attendance write itself is unaffected (the server does it and returns
 * the react as an instruction), so the failure is invisible in the data and
 * total from the player's point of view: they see the bot say nothing at
 * all, assume it is broken, and either re-post or stop trusting it.
 *
 * ── Why a text fallback, and why THIS shape ──────────────────────────
 * The obvious objection to replying in text is spam, and it is a fair one.
 * So the fallback is deliberately constrained:
 *
 *   - ONE message per flush for the WHOLE batch, never one per player. A
 *     10-minute batch with six INs produces one line, not six messages.
 *   - Only for reactions that ACTUALLY failed. On a healthy layer this
 *     module never produces anything, so nothing changes in normal running.
 *   - Only for players we can NAME. A confirmation addressed to a bare
 *     @lid number is worse than silence (and printing raw digits as a
 *     player name is a rule this codebase already learned the hard way).
 *   - Behind a cooldown, so a persistently broken layer cannot turn every
 *     flush into a post.
 *   - Killable from the Pi's .env (`BOT_REACT_TEXT_FALLBACK=0`) without a
 *     code change, because it is the one change here that a customer's
 *     group actually SEES.
 *
 * On balance: a player told "yes, you're in" in words once per batch is
 * plainly better than a player told nothing at all before a fixture they
 * have paid for. Everything here is pure so the wording and the limits are
 * pinned by tests.
 */

export interface ReactFallbackEntry {
  /** Display name of the player whose reaction failed. Null when unknown. */
  authorName: string | null;
  /** The emoji the server told us to place (✅ confirmed, 🪑 bench, …). */
  emoji: string;
}

/** Names beyond this many are collapsed into "+N more". */
const MAX_NAMES_PER_EMOJI = 20;

/**
 * What each emoji MEANS, in words.
 *
 * The whole purpose of this message is that it is readable without the
 * reaction, so "🪑 Baki" would defeat it: a player who has never been
 * benched has no idea a chair means "you are first reserve". The server
 * owns the emoji vocabulary and can add to it, so an unknown emoji falls
 * back to the bare symbol rather than being dropped.
 */
const EMOJI_LABELS: Record<string, string> = {
  "✅": "In",
  "🪑": "On the bench",
  "❌": "Out",
  "❓": "Noted as a maybe",
};

/**
 * Compose the single catch-up message, or null when there is nothing
 * worth saying (no failures, or no failure we can put a name to).
 */
export function composeReactFallback(entries: ReactFallbackEntry[]): string | null {
  // Group by emoji, first-seen order, de-duplicating names within a group.
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    const name = typeof e?.authorName === "string" ? e.authorName.trim() : "";
    const emoji = typeof e?.emoji === "string" ? e.emoji.trim() : "";
    if (!name || !emoji) continue;
    const list = groups.get(emoji) ?? [];
    if (!list.includes(name)) list.push(name);
    groups.set(emoji, list);
  }
  if (groups.size === 0) return null;

  const lines: string[] = [];
  for (const [emoji, names] of groups) {
    const shown = names.slice(0, MAX_NAMES_PER_EMOJI);
    const extra = names.length - shown.length;
    const label = EMOJI_LABELS[emoji];
    lines.push(
      `${emoji} ${label ? `${label}: ` : ""}${shown.join(", ")}${extra > 0 ? `, +${extra} more` : ""}`,
    );
  }

  return (
    "⚠️ WhatsApp won't let me add my usual reactions right now, so here it is in words:\n" +
    lines.join("\n") +
    "\n\nYou're all recorded, nothing to redo."
  );
}

/**
 * Is the text fallback switched on? On by default: the failure it covers
 * (a player getting no confirmation at all) is worse than the one message
 * it costs. Set `BOT_REACT_TEXT_FALLBACK=0` on the Pi to silence it.
 */
export function reactFallbackEnabled(env: Record<string, string | undefined>): boolean {
  const raw = (env.BOT_REACT_TEXT_FALLBACK ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/** Cooldown gate, so a persistently broken injected layer posts at most one
 *  catch-up per window per group rather than one per flush. */
export function shouldSendReactFallback(
  lastSentMs: number | null,
  nowMs: number,
  cooldownMs: number,
): boolean {
  if (lastSentMs === null) return true;
  return nowMs - lastSentMs > cooldownMs;
}
