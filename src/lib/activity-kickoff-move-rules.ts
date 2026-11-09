/**
 * A WEEKLY GAME'S KICKOFF CHANGED: WHERE EACH GAME STILL TO BE PLAYED GOES
 * (Kemal, 2026-11-09). Pure: no database, no clock.
 *
 * An organiser changed Monday night vets from 20:30 to 20:15 on
 * /admin/activities. Only the Activity row was written, so tonight's and
 * next week's games, already made, still said 20:30 everywhere. Now every
 * game of the activity still to be played follows the new kickoff, quietly
 * (`activity-kickoff-move.ts` writes it; nothing is posted or sent).
 *
 * THE RULE, for one game:
 *
 *   - A new TIME: the same London date at the new London time. The
 *     calendar day is read in London and the wall clock turned into an
 *     instant there, so British Summer Time and the clock-change days come
 *     out right (london-time.ts).
 *   - A new DAY of the week: the new weekday in the SAME week, Monday to
 *     Sunday, at the (new) time. Nothing in the code had a notion of this
 *     before; it is the smallest move that keeps one game a week.
 *   - The sign-up deadline moves by exactly as much as the kickoff, so the
 *     gap the game already had is kept (a changed deadline applies to games
 *     made afterwards only, as the edit form says).
 *
 * WHEN A GAME STAYS WHERE IT IS:
 *
 *   started        it has kicked off: what was played is not rewritten.
 *   set-by-hand    it does not sit on the activity's old time (and, for a
 *                  new day, its old weekday), so somebody put it there on
 *                  purpose (a block booking for 20:00). The same rule as a
 *                  format switch (format-switch-time.ts, decision 2).
 *   into-the-past  the new kickoff has already gone (tonight at 20:20,
 *                  moved to 20:15; Wednesday's game moved to a Monday that
 *                  has passed). It is played where it was; the next one
 *                  follows the new day.
 *   other-month    a new day that falls in another calendar month: a
 *                  monthly club's list and price count each month's own
 *                  games (squad-month-rules.ts), so a game never leaves its
 *                  month by itself.
 *   unreadable-time  a stored time that is not "HH:mm": change nothing,
 *                  never throw on a live admin save.
 *   unchanged      neither the day nor the time changed.
 */
import { formatLondon, londonDateTimeToUtc } from "./london-time";

export interface ActivityKickoff {
  /** 0 = Sunday .. 6 = Saturday, as on `Activity.dayOfWeek`. */
  dayOfWeek: number;
  /** London wall clock, "HH:mm", as on `Activity.time`. */
  time: string;
}

export type KickoffStayReason = "unchanged" | "started" | "set-by-hand" | "into-the-past" | "other-month" | "unreadable-time";

export type ActivityKickoffMovePlan =
  | { move: false; reason: KickoffStayReason }
  | { move: true; kickoff: Date; attendanceDeadline: Date };

/** Monday 0 .. Sunday 6: the position of a weekday in a Monday-to-Sunday week. */
const weekPosition = (dayOfWeek: number) => (dayOfWeek + 6) % 7;

/** "yyyy-MM-dd" plus whole calendar days (no zone: calendar arithmetic). */
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function at(ymd: string, time: string): Date | null {
  try {
    const d = londonDateTimeToUtc(ymd, time);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

export function planActivityKickoffMove(input: {
  match: { date: Date; attendanceDeadline: Date };
  before: ActivityKickoff;
  after: ActivityKickoff;
  now: Date;
}): ActivityKickoffMovePlan {
  const { match, before, after, now } = input;
  if (before.dayOfWeek === after.dayOfWeek && before.time === after.time) return { move: false, reason: "unchanged" };
  if (match.date.getTime() <= now.getTime()) return { move: false, reason: "started" };

  const day = formatLondon(match.date, "yyyy-MM-dd");
  const oldDefault = at(day, before.time);
  if (!oldDefault) return { move: false, reason: "unreadable-time" };
  if (oldDefault.getTime() !== match.date.getTime()) return { move: false, reason: "set-by-hand" };
  // A new day counts from the old one, so the game must be on it. A new
  // time alone does not ask: the game keeps its own date either way.
  const dayChanged = before.dayOfWeek !== after.dayOfWeek;
  const weekday = Number(formatLondon(match.date, "i")) % 7; // ISO Mon=1..Sun=7 -> Sun=0..Sat=6
  if (dayChanged && weekday !== before.dayOfWeek) return { move: false, reason: "set-by-hand" };

  const newDay = addDays(day, weekPosition(after.dayOfWeek) - weekPosition(before.dayOfWeek));
  if (newDay.slice(0, 7) !== day.slice(0, 7)) return { move: false, reason: "other-month" };
  const kickoff = at(newDay, after.time);
  if (!kickoff) return { move: false, reason: "unreadable-time" };
  if (kickoff.getTime() === match.date.getTime()) return { move: false, reason: "unchanged" };
  if (kickoff.getTime() <= now.getTime()) return { move: false, reason: "into-the-past" };

  const shift = kickoff.getTime() - match.date.getTime();
  return { move: true, kickoff, attendanceDeadline: new Date(match.attendanceDeadline.getTime() + shift) };
}

/** Did a save change what decides a game's kickoff? */
export function kickoffChanged(before: ActivityKickoff, after: Partial<ActivityKickoff>): boolean {
  return (after.dayOfWeek !== undefined && after.dayOfWeek !== before.dayOfWeek) || (after.time !== undefined && after.time !== before.time);
}
