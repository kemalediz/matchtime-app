/**
 * "Is this the match the bot should post about?" — the gate shared by the
 * scheduler's announce-match and 17:00 evening-update paths.
 *
 * Three responsibilities:
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
 *   3. Cancelled-day hold (2026-10-13, Sutton FC), only when the caller
 *      passes `now`: a CANCELLED match strictly earlier in the same
 *      fixture keeps suppressing this one until the cancelled match's own
 *      London calendar day is over. From London midnight after that day
 *      it suppresses nothing. So the weekly rhythm is the same whether
 *      the game was played or cancelled: next week's announcement lands
 *      the morning after the day the game was (or would have been) on.
 *      Before this rule a cancelled match suppressed nothing at all: the
 *      Tue 13 Oct match was cancelled on the Monday evening, and at 09:00
 *      on the Tuesday the bot announced Tue 20 Oct, with its 0/14 squad
 *      post at 17:00 the same day.
 *
 *      The hold starts when the match is cancelled, not on its day (a
 *      game cancelled on Monday holds Monday evening too), and it chains
 *      by itself: with 13 and 20 Oct cancelled, 27 Oct waits for 21 Oct.
 *      It is opt-in because it belongs to the posts that open a new week
 *      for the group, the announcement and the 17:00 squad post. Callers
 *      tied to the match's own clock (weekly deadlines, the month's list,
 *      the organiser pick, the deadline summary) pass no `now` and are
 *      never held by a cancelled match.
 *
 * Note the deliberate asymmetry: the "strictly earlier" suppression (1 and
 * 3) is scoped to the SAME fixture (so a separate Thursday game, or a
 * different venue on the same weekday, never suppresses this one in a
 * multi-activity org), while the co-timed tie-break is org-wide (so a
 * cross-activity ghost sharing the timestamp is caught).
 *
 * Pure function — no DB. The scheduler loads the org's matches once and
 * delegates here so the same logic is shared and unit-testable.
 */

import { formatLondon } from "./london-time";
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

/** The London calendar day of an instant, "yyyy-MM-dd". DST-safe. */
const londonDay = (d: Date): string => formatLondon(d, "yyyy-MM-dd");

/**
 * A cancelled match still holding its fixture's later posts at `now`: its
 * London calendar day has not ended yet. Comparing day keys rather than
 * adding 24 hours keeps this right on the 25- and 23-hour days of a clock
 * change.
 */
const isCancelledDayHold = (m: SchedulerMatch, now: Date): boolean =>
  !m.isHistorical && m.status === "CANCELLED" && londonDay(now) <= londonDay(m.date);

/**
 * @param matches  All of the org's candidate matches (the same set the
 *                 scheduler iterates). May include completed/historical/
 *                 cancelled rows: completed and historical ones never
 *                 block, and a cancelled one blocks only under rule 3.
 * @param target   The match currently being evaluated.
 * @param now      Pass the clock to apply the cancelled-day hold (rule 3).
 *                 Omit it and cancelled matches block nothing.
 */
export function isNextUpcomingForPosting(
  matches: SchedulerMatch[],
  target: SchedulerMatch,
  now?: Date,
): boolean {
  if (!isLive(target)) return false;

  const targetTime = target.date.getTime();

  const blocked = matches.some((other) => {
    if (other.id === target.id) return false;
    // (3) A cancelled match blocks only as a strictly earlier match of the
    //     same fixture, through the `sameFixture` test below, and only
    //     until its London day is over. It never takes part in the
    //     co-timed tie-break.
    const cancelledHold = now !== undefined && isCancelledDayHold(other, now);
    if (!isLive(other) && !cancelledHold) return false;

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

    // (2) Co-timed LIVE match anywhere in the org with a lower id
    //     (tie-break).
    if (!cancelledHold && other.date.getTime() === targetTime && other.id < target.id) {
      return true;
    }

    return false;
  });

  return !blocked;
}
