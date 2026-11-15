/**
 * THE MoM ANNOUNCEMENT'S NEXT-FIXTURE STOP, as one pure rule (review
 * 2026-11-15). Read by the scheduler (bot-scheduler.ts, section 6e), which
 * stops carrying a match's Man of the Match announcement for good once it
 * is true, and by the last-MoM answer (pipeline/last-mom.ts), for which a
 * match the scheduler gave up on is decided: no result will ever be posted.
 *
 * The club plays weekly, so once the next fixture has kicked off "here is
 * your Man of the Match" reads as tonight's result. A later match only
 * counts when it starts at least a day later: a format switch can leave a
 * co-timed ghost match under the other format's activity (the 2026-06-27
 * ghost bug), and a ghost must never silence a real announcement. Fixture
 * identity is the same one the announce and evening rollover guard uses
 * (`isSameRecurringFixture`), so a format-switched successor still counts.
 * A cancelled match never counts.
 *
 * PURE. No Prisma, no clock.
 */
import { isSameRecurringFixture, type RecurringFixtureKey } from "./match-slot";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A club match as the stop reads it. */
export interface MomFixtureMatch {
  id: string;
  date: Date;
  status: string;
  activityId: string;
  /** Its activity's recurring fixture (org, venue, weekday). */
  activity: RecurringFixtureKey;
}

/** PURE. Has a later fixture of this match kicked off by `now`? */
export function momAnnouncementSuperseded(
  m: Pick<MomFixtureMatch, "id" | "date" | "activityId" | "activity">,
  others: readonly MomFixtureMatch[],
  now: Date,
): boolean {
  return others.some(
    (s) =>
      s.id !== m.id &&
      s.status !== "CANCELLED" &&
      (s.activityId === m.activityId || isSameRecurringFixture(s.activity, m.activity)) &&
      s.date.getTime() >= m.date.getTime() + DAY_MS &&
      s.date.getTime() <= now.getTime(),
  );
}
