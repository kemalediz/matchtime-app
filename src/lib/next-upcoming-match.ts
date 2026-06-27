/**
 * "Is this the match the bot should post about?" — the gate shared by the
 * scheduler's announce-match and 17:00 evening-update paths.
 *
 * Two responsibilities:
 *
 *   1. Same-activity rollover guard (original behaviour): when next week's
 *      match in the SAME activity has just been auto-created, only the
 *      current week's match fires its posts. A live match strictly EARLIER
 *      in the same activity suppresses this one — so the group always sees
 *      "next match", never "next-but-one".
 *
 *   2. Co-timed tie-break (defense-in-depth, 2026-06-27 ghost bug): a
 *      format switch can leave two matches sharing the EXACT same kickoff
 *      timestamp (the real match with players + an empty ghost under the
 *      old format's still-active Activity). The strict `<` comparison meant
 *      neither was "strictly earlier", so both fired. Among co-timed live
 *      matches ANYWHERE in the org, only the one with the lowest `id` is
 *      treated as next-upcoming; the rest are suppressed.
 *
 * Note the deliberate asymmetry: the "strictly earlier" suppression is
 * scoped to the SAME activity (so a separate Thursday game never suppresses
 * a Tuesday one in a multi-activity org), while the co-timed tie-break is
 * org-wide (so a cross-activity ghost sharing the timestamp is caught).
 *
 * Pure function — no DB. The scheduler loads the org's matches once and
 * delegates here so the same logic is shared and unit-testable.
 */

export type SchedulerMatchStatus =
  | "UPCOMING"
  | "TEAMS_GENERATED"
  | "TEAMS_PUBLISHED"
  | "COMPLETED"
  | "CANCELLED"
  | string;

export interface SchedulerMatch {
  id: string;
  activityId: string;
  date: Date;
  status: SchedulerMatchStatus;
  isHistorical?: boolean;
}

const LIVE_STATUSES = new Set([
  "UPCOMING",
  "TEAMS_GENERATED",
  "TEAMS_PUBLISHED",
]);

const isLive = (m: SchedulerMatch): boolean =>
  !m.isHistorical && LIVE_STATUSES.has(m.status);

/**
 * @param matches  All of the org's candidate matches (the same set the
 *                 scheduler iterates). May include completed/historical/
 *                 cancelled rows — they're filtered out as blockers.
 * @param target   The match currently being evaluated.
 */
export function isNextUpcomingForPosting(
  matches: SchedulerMatch[],
  target: SchedulerMatch,
): boolean {
  if (!isLive(target)) return false;

  const targetTime = target.date.getTime();

  const blocked = matches.some((other) => {
    if (other.id === target.id) return false;
    if (!isLive(other)) return false;

    // (1) Strictly earlier match in the SAME activity (rollover guard).
    if (
      other.activityId === target.activityId &&
      other.date.getTime() < targetTime
    ) {
      return true;
    }

    // (2) Co-timed match anywhere in the org with a lower id (tie-break).
    if (other.date.getTime() === targetTime && other.id < target.id) {
      return true;
    }

    return false;
  });

  return !blocked;
}
