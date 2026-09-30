/**
 * WEEKLY DEADLINES, PURE (2026-09-30).
 *
 * Slice 1 of MDs/friday-group-features-plan-2026-09-30.md needs one
 * thing from here: the drop-out deadline a rolling squad is told about
 * and judged against (plan 1.5). Slice 3 adds a club-level weekly
 * deadline (e.g. Monday 21:00) and extends this function to prefer it;
 * until one is set, the deadline is the match's own sign-up deadline
 * (kickoff minus `Activity.deadlineHours`), so slice 1 ships on its own.
 *
 * Pure: no database, no clock.
 */
export interface DeadlineMatch {
  date: Date;
  attendanceDeadline: Date;
}

/** The instant after which an OUT counts as a late drop-out. */
export function dropOutDeadlineFor(match: DeadlineMatch): Date {
  return match.attendanceDeadline;
}
