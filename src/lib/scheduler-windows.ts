/**
 * THE SCHEDULER'S WINDOWS, ONE DEFINITION (club summary, slice A1,
 * MDs/club-summary-design-2026-11-04.md section 3.7 item 10).
 *
 * How far back the scheduler keeps a match or a month in hand. Read by the
 * scheduler (`bot-scheduler.ts`, `monthly-week.ts`) and by the club
 * summary's loader (`club-summary/load.ts`), which loads the same matches
 * and months, so the two can never drift. Pure: no Prisma, so the loader
 * does not pull the scheduler's module graph in.
 *
 * The post-match deadlines these windows must outlive, and why, are in
 * bot-scheduler.ts ("Post-match deadlines, and the lookback they need").
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Hard stop for a MoM announcement, in days after kickoff.
 *
 * Why 9. It has to be comfortably more than `MOM_BACKSTOP_DAYS` or the
 * backstop gets no second chance at all, which is the bug this constant
 * exists to close; 9 leaves four clear days of retry after the first
 * backstop afternoon, against a real outage of 46 hours. It cannot be
 * open ended either: a fortnight-old result is not news, and the club
 * plays weekly so the group would read it as this week's match. The
 * common weekly case is handled more precisely by the next-fixture stop
 * in section 6e (we go quiet as soon as the following fixture has been
 * played, usually day 7); this cap is the outer bound for a club whose
 * next fixture is further off or not scheduled at all.
 */
export const MOM_ANNOUNCE_MAX_AGE_DAYS = 9;

/**
 * How far back `getMatchesForScheduler` loads COMPLETED matches. One day
 * of slack past the longest post-match deadline, so a match is still in
 * hand for the whole life of its last piece of work.
 */
export const POST_MATCH_LOOKBACK_DAYS = MOM_ANNOUNCE_MAX_AGE_DAYS + 1;

/**
 * How far back a CANCELLED match is loaded. Its only use is the
 * cancelled-day hold, which ends at London midnight after its kickoff
 * day, always less than 24 hours after kickoff. The pure gate decides the
 * exact moment; this only has to be wide enough.
 */
export const CANCELLED_HOLD_LOOKBACK_MS = DAY_MS;

/** How long after a month is closed the scheduler still needs to know its
 *  played games were a month's (no payment poll, no "how much each?" to
 *  the collector). Longer than the scheduler looks back at a played match. */
export const CLOSED_MONTH_GATE_DAYS = 14;

/**
 * The scheduler's matches of one club at `now`: every live match of any
 * date, the COMPLETED ones of the last `POST_MATCH_LOOKBACK_DAYS`, and the
 * CANCELLED ones of the last 24 hours (for the cancelled-day hold only).
 * Never a historical match. `getMatchesForScheduler` and the club
 * summary's match read both use this `where`.
 */
export function schedulerMatchWhere(orgId: string, now: Date) {
  return {
    activity: { orgId },
    isHistorical: false,
    OR: [
      { status: { in: ["UPCOMING" as const, "TEAMS_GENERATED" as const, "TEAMS_PUBLISHED" as const] } },
      { status: "COMPLETED" as const, date: { gte: new Date(now.getTime() - POST_MATCH_LOOKBACK_DAYS * DAY_MS) } },
      // For the cancelled-day hold ONLY. The scheduler splits these rows
      // off before anything else reads the list.
      { status: "CANCELLED" as const, date: { gte: new Date(now.getTime() - CANCELLED_HOLD_LOOKBACK_MS) } },
    ],
  };
}

/**
 * The matches the POSTING RULE reads (`isNextUpcomingForPosting`,
 * next-upcoming-match.ts) for a post made outside the scheduler's poll (the
 * organiser pick, the admin deadline summary, the partner-club ask): every
 * live match of any date, and the CANCELLED ones of the last 24 hours, whose
 * London day may still hold the fixture's next match (club summary, slice
 * B4, decision K5). Never a historical match. `schedulerMatchWhere` less the
 * completed matches, which the rule never reads. A caller iterates the live
 * ones only; the cancelled ones are there to hold.
 */
export function postingMatchWhere(orgId: string, now: Date) {
  return {
    activity: { orgId },
    isHistorical: false,
    OR: [
      { status: { in: ["UPCOMING" as const, "TEAMS_GENERATED" as const, "TEAMS_PUBLISHED" as const] } },
      { status: "CANCELLED" as const, date: { gte: new Date(now.getTime() - CANCELLED_HOLD_LOOKBACK_MS) } },
    ],
  };
}

/** A month closed in the last `CLOSED_MONTH_GATE_DAYS` (the `where` part). */
export function closedLatelyWhere(now: Date) {
  return { status: "closed", closedAt: { gte: new Date(now.getTime() - CLOSED_MONTH_GATE_DAYS * DAY_MS) } };
}
