/**
 * One forced re-read of a group's roster per group per window, for an
 * @-mention of a LID the Pi cannot tie to a phone (2026-09-30).
 *
 * The case: somebody joined the group after the bot's last roster read,
 * or while it was offline, so their LID is in no store. A fresh
 * `groupMetadata` is the only place WhatsApp tells us their phone, and it
 * is one request we already make every fifteen minutes. The directory
 * lookups that could answer it per number (`onWhatsApp`, `getLIDForPN`,
 * USync) are banned: about a hundred of them unlinked every device on
 * HomeTenant's number on 2026-09-17.
 *
 * The limit is per group so a chatty admin tagging five new players in a
 * row costs one read, not five, and a LID that WhatsApp simply will not
 * pair (privacy) cannot turn every message into a metadata request.
 *
 * Pure: an injected clock, no I/O.
 */
export const MENTION_ROSTER_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export interface RosterRefreshLimiter {
  /** True, and the window starts, when a re-read of this group is allowed now. */
  tryAcquire(groupId: string): boolean;
}

export function createRosterRefreshLimiter(
  opts: { now?: () => number; intervalMs?: number } = {},
): RosterRefreshLimiter {
  const now = opts.now ?? (() => Date.now());
  const interval = opts.intervalMs ?? MENTION_ROSTER_REFRESH_INTERVAL_MS;
  const last = new Map<string, number>();
  return {
    tryAcquire(groupId) {
      const t = now();
      const prev = last.get(groupId);
      if (prev !== undefined && t - prev < interval) return false;
      last.set(groupId, t);
      return true;
    },
  };
}
