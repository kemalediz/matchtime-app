/**
 * "Is this the match the bot should post about?" — the gate shared by the
 * scheduler's announce-match and 17:00 evening-update paths.
 *
 * Two responsibilities:
 *
 *   1. Same-FIXTURE rollover guard: when next week's match in the same
 *      recurring fixture has just been auto-created, only the current
 *      week's match fires its posts. A live match strictly EARLIER in the
 *      same fixture suppresses this one — so the group always sees
 *      "next match", never "next-but-one".
 *
 *      This was originally keyed on `activityId` — which broke under a
 *      format switch (2026-07-14, Sutton FC): `switchMatchFormat` re-points
 *      this week's Match to the other-format Activity, so this week's match
 *      (tuesday-5aside) and next week's auto-generated match
 *      (tuesday-7aside) no longer shared an activityId, the guard never
 *      fired, and next week's match was announced while this week's was
 *      still live. Fixture identity is therefore (orgId, venue, dayOfWeek)
 *      — see {@link isSameRecurringFixture}. The configured kickoff `time`
 *      is deliberately NOT part of the identity (the two formats of one
 *      fixture have different times: 21:30 vs 21:15), and unlike the
 *      generator's slot dedupe there is NO instant-proximity requirement —
 *      this guard compares matches a week apart. A defensive fallback to
 *      activityId comparison covers callers that can't supply slot fields.
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
 * scoped to the SAME fixture (so a separate Thursday game, or a different
 * venue on the same weekday, never suppresses this one in a multi-activity
 * org), while the co-timed tie-break is org-wide (so a cross-activity ghost
 * sharing the timestamp is caught).
 *
 * Pure function — no DB. The scheduler loads the org's matches once and
 * delegates here so the same logic is shared and unit-testable.
 */

import { isSameRecurringFixture } from "./match-slot";

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
  /**
   * The activity's recurring-fixture identity, used by the rollover guard.
   * Optional: when absent on either side of a comparison, the guard falls
   * back to plain activityId equality (the pre-2026-07-14 behaviour).
   * The scheduler's Prisma rows satisfy this structurally via their
   * `activity` include.
   */
  activity?: {
    orgId: string;
    venue: string;
    dayOfWeek: number; // 0=Sun..6=Sat
  };
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

    // (1) Strictly earlier match in the SAME recurring fixture (rollover
    //     guard). Same activityId always means same fixture; when both
    //     sides carry slot fields we ALSO match across activities on
    //     (orgId, venue, dayOfWeek), so a format-switched match still
    //     suppresses next week's match under the other-format Activity.
    const sameFixture =
      other.activityId === target.activityId ||
      (other.activity !== undefined &&
        target.activity !== undefined &&
        isSameRecurringFixture(other.activity, target.activity));
    if (sameFixture && other.date.getTime() < targetTime) {
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
