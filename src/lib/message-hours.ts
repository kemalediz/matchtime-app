/**
 * MESSAGE HOURS: the daytime window for messages MatchTime holds back
 * rather than send at night. PURE: no database, no clock of its own.
 *
 * 09:00 (inclusive) to 23:00 (exclusive), London wall clock. A message
 * that becomes due outside it waits for the next 09:00 London. Owner
 * decisions: 2026-10-12 for the messages that waited for 10:00 to 20:00,
 * 2026-10-13 for the ones that waited for 08:00 to 22:00.
 *
 * The ONE definition of the daytime window. Every gate on it takes its
 * hours from here (`inMessageHours`, `messageHoursSendAfter`, or the
 * constants where a caller has conditions of its own):
 *   - billing DMs, the month's close and charge, the day 21 and day 28
 *     reminders (club-billing-schedule-rules.ts);
 *   - the setup DMs to a new club's organiser (setup-learning/run.ts,
 *     club-setup-dm.ts, club-setup-reminder.ts, club-setup-removal.ts);
 *   - the owner's approval and setup DMs (owner-dm.ts);
 *   - admin notices and admin group posts (rolling-squad-rules.ts,
 *     admin-channel-rules.ts), and the AI cap notice's cutoff
 *     (ai-cap-notice.ts);
 *   - the monthly squad's posts and DMs (month-signup-rules.ts,
 *     monthly-week-rules.ts);
 *   - the weekly deadline posts and the times an organiser may choose
 *     for them (weekly-deadlines.ts);
 *   - organiser picks, bench offers and recruit chases
 *     (organiser-pick-rules.ts, bot-scheduler.ts, recruit-chase.ts).
 *
 * NOT this window: a post tied to one hour of the day (the 17:00 update,
 * the 18:00 chases, the unpaid list, badges, Man of the Match). Those are
 * schedules and keep their own hours in their own files.
 * `__tests__/message-hours-source-guard.test.ts` fails when a second
 * definition of the window appears.
 */
import { formatLondon, londonWallClockToUtc } from "./london-time";

/** Held messages go out from 09:00 London ... */
export const MESSAGE_HOURS_FROM_HOUR = 9;
/** ... until 23:00 London (exclusive: 22:59 is the last minute). */
export const MESSAGE_HOURS_TO_HOUR = 23;
/** The window's opening as a London wall clock time, "09:00". */
export const MESSAGE_HOURS_FROM_TIME = `${String(MESSAGE_HOURS_FROM_HOUR).padStart(2, "0")}:00`;

const HOUR_MS = 60 * 60 * 1000;

function londonHour(now: Date): number {
  return Number(formatLondon(now, "H"));
}

/** Is it 09:00 to 22:59 in London? */
export function inMessageHours(now: Date): boolean {
  const h = londonHour(now);
  return h >= MESSAGE_HOURS_FROM_HOUR && h < MESSAGE_HOURS_TO_HOUR;
}

/**
 * The `sendAfter` for a message queued at `now`: null inside the window
 * (send at once), else the next 09:00 London.
 */
export function messageHoursSendAfter(now: Date): Date | null {
  const h = londonHour(now);
  if (h >= MESSAGE_HOURS_FROM_HOUR && h < MESSAGE_HOURS_TO_HOUR) return null;
  // Before 09:00: today's 09:00. From 23:00: tomorrow's. Twelve hours on
  // from the 23:00 hour is always inside tomorrow's London date (11:00 to
  // 11:59, or an hour either side on a clock change night), whatever the
  // month or year, so only the date is read from it.
  const day = h < MESSAGE_HOURS_FROM_HOUR ? now : new Date(now.getTime() + 12 * HOUR_MS);
  return londonWallClockToUtc(day, MESSAGE_HOURS_FROM_TIME);
}
