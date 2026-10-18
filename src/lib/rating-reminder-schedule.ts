/**
 * WHEN A PLAYER WHO HAS NOT RATED IS REMINDED (Kemal, 2026-10-18). PURE:
 * no database, no clock of its own. Read by section 6d of bot-scheduler.ts.
 *
 * The first rating DM goes the morning after the match (6b). After it, at
 * most TWO reminders, then MatchTime stops asking:
 *
 *   reminder 1   18:00 London on a day AFTER the first DM's day (never
 *                the same day as the first DM);
 *   reminder 2   18:00 London at least two days after reminder 1, and
 *                the LAST one: its copy says so. Skipped if the rating
 *                window has closed by then.
 *
 * Before this the reminder went every day of the five-day window, up to
 * five nudges per player per match.
 *
 * COUNTED FROM WHAT WAS SENT. The reminders already sent are the
 * `<matchId>:rate-reminder:<userId>:<YYYY-MM-DD>` keys in SentNotification
 * (the key format the daily reminder always used, so history from before
 * this change counts too). The schedule is measured from the day each one
 * actually went, so a missed 18:00 run (bot down) shifts it by a day
 * instead of firing two at once, and a third is never due. A reminder that
 * was claimed but held back still has its key, so it counts once.
 *
 * The other stops (the player rated, opted out, has no phone) stay with
 * the caller, which has the data.
 */
import { formatLondon } from "./london-time";

/** No more than this many reminders after the first DM. */
export const RATING_REMINDER_MAX = 2;
/** The reminder hour, London: 18:00 to 18:59. */
export const RATING_REMINDER_HOUR = 18;
/** Days between reminder 1 and reminder 2. */
export const RATING_REMINDER_GAP_DAYS = 2;
/** The rating window when the activity does not say (schema default). */
export const DEFAULT_RATING_WINDOW_HOURS = 120;

export type DueRatingReminder = 1 | 2 | null;

const londonDay = (d: Date): string => formatLondon(d, "yyyy-MM-dd");

/** Whole days from one "YYYY-MM-DD" to another. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function ratingReminderKey(matchId: string, userId: string, now: Date): string {
  return `${matchId}:rate-reminder:${userId}:${londonDay(now)}`;
}

/** The London days (sorted) of the reminders this player has had for this match. */
export function sentRatingReminderDays(keys: Iterable<string>, matchId: string, userId: string): string[] {
  const prefix = `${matchId}:rate-reminder:${userId}:`;
  const days: string[] = [];
  for (const k of keys) if (k.startsWith(prefix)) days.push(k.slice(prefix.length));
  return days.sort();
}

export function dueRatingReminder(p: {
  matchAt: Date;
  /** The activity's `ratingWindowHours`: ratings close this long after kickoff. */
  windowHours: number;
  /** When the first rating DM was sent (its SentNotification), or null. */
  firstDmAt: Date | null;
  /** London days of the reminders already sent (`sentRatingReminderDays`). */
  sentReminderDays: readonly string[];
  now: Date;
}): DueRatingReminder {
  if (!p.firstDmAt) return null;
  if (p.now.getTime() > p.matchAt.getTime() + p.windowHours * 3_600_000) return null;
  if (Number(formatLondon(p.now, "H")) !== RATING_REMINDER_HOUR) return null;

  const sent = [...p.sentReminderDays].sort();
  if (sent.length >= RATING_REMINDER_MAX) return null;
  const today = londonDay(p.now);
  if (sent.includes(today)) return null;

  if (sent.length === 0) return daysBetween(londonDay(p.firstDmAt), today) >= 1 ? 1 : null;
  return daysBetween(sent[sent.length - 1], today) >= RATING_REMINDER_GAP_DAYS ? 2 : null;
}
