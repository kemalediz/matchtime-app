/**
 * MESSAGE HOURS: the daytime window for messages MatchTime holds back
 * rather than send at night. PURE: no database, no clock of its own.
 *
 * 09:00 (inclusive) to 23:00 (exclusive), London wall clock. A message
 * that becomes due outside it waits for the next 09:00 London. Owner
 * decision, 2026-10-12; the window was 10:00 to 20:00 before.
 *
 * The ONE pair of hours for every gate on this window. Today that is:
 *   - the billing DMs, the month's close and charge, and the day 21 and
 *     day 28 reminders (club-billing-schedule-rules.ts takes its hours
 *     from here);
 *   - the "what MatchTime learned from your chat" setup DM
 *     (setup-learning/run.ts).
 *
 * NOT this window, on purpose: the 08:00 to 22:00 family (admin notices,
 * the owner's approval DM, bench offers, lists, recruit chases) and the
 * posts tied to one hour of the day. They keep their own constants in
 * their own files.
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
