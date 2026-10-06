/**
 * Helpers for dealing with Europe/London wall-clock times.
 *
 * Why this exists: Vercel servers run in UTC. `new Date().setHours(21, 30)`
 * therefore stores 21:30 UTC (= 22:30 BST), but our Activity.time field
 * ("21:30") is intended to mean the local London wall clock. Every path
 * that turns an Activity.time into a Match.date, or formats a Match.date
 * for display, must do the tz conversion explicitly.
 *
 * Built on date-fns-tz so DST (BST ↔ GMT) is handled automatically.
 */
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import type { Locale } from "date-fns";

const LONDON = "Europe/London";

/**
 * Take a Date at midnight in any timezone and an "HH:mm" string and
 * produce the UTC Date that represents that local-London wall clock on
 * that calendar day.
 *
 * Example:
 *   anchor = new Date(Date.UTC(2026, 3, 21))  // 2026-04-21 anywhere-midnight
 *   time   = "21:30"
 *   → returns Date with .toISOString() === "2026-04-21T20:30:00.000Z"
 *     (because 21:30 BST = 20:30 UTC in April)
 */
export function londonWallClockToUtc(anchor: Date, time: string): Date {
  const [hStr, mStr] = time.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) {
    throw new Error(`Bad time "${time}", expected HH:mm`);
  }
  // Pull the calendar day in London (handles pre/post DST transitions).
  const y = Number(formatInTimeZone(anchor, LONDON, "yyyy"));
  const mo = Number(formatInTimeZone(anchor, LONDON, "MM"));
  const d = Number(formatInTimeZone(anchor, LONDON, "dd"));
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
  return fromZonedTime(iso, LONDON);
}

/**
 * The next kickoff of a weekly game: the UTC instant of London wall
 * clock `time` on the next `dayOfWeek` (0=Sun..6=Sat) strictly after
 * today's London date. On the game's own weekday that is a week away.
 *
 * The one place an `Activity` (weekday + "HH:mm") becomes a `Match.date`
 * for the coming week: the nightly generate-matches cron and the admin
 * "Generate match" button both call it. The weekday is read in London,
 * not from `Date#getDay()` (server time, UTC on Vercel), so a call just
 * after London midnight cannot land on the wrong day.
 */
export function nextLondonKickoff(now: Date, dayOfWeek: number, time: string): Date {
  const londonWeekday = Number(formatLondon(now, "i")) % 7; // Mon=1..Sun=7 → JS Sun=0..Sat=6
  let daysUntil = dayOfWeek - londonWeekday;
  if (daysUntil <= 0) daysUntil += 7;

  // Anchor inside the target London day; the helper turns the wall clock
  // into a UTC instant. Counted from NOON, not midnight: across the
  // autumn clock change a London day is 25 hours, so whole 24-hour days
  // from midnight stop at 23:00 the evening before and the match landed
  // a day early. From noon the count is at most an hour out either way.
  const todayLondonNoon = londonWallClockToUtc(now, "12:00");
  const anchor = new Date(todayLondonNoon.getTime() + daysUntil * 24 * 60 * 60 * 1000);
  return londonWallClockToUtc(anchor, time);
}

/**
 * Format a Date for display in London time.
 *
 * `locale` (optional, 2026-09-17) picks the day and month NAMES for a
 * non-English group; the zone is London either way. Without it the
 * output is byte for byte what it always was. Callers should reach for
 * the named labels in `src/lib/i18n/dates.ts` rather than pass a
 * locale here directly.
 */
export function formatLondon(d: Date, pattern: string, locale?: Locale): string {
  return locale ? formatInTimeZone(d, LONDON, pattern, { locale }) : formatInTimeZone(d, LONDON, pattern);
}

/**
 * Convert an explicit "YYYY-MM-DD" + "HH:mm" pair, both interpreted as
 * Europe/London wall-clock, into the UTC Date instant. DST-safe.
 *
 * Example:
 *   londonDateTimeToUtc("2026-05-18", "09:00")
 *   → 2026-05-18T08:00:00.000Z  (BST = UTC+1 in May)
 *
 * Throws on malformed input — callers must validate/catch.
 */
export function londonDateTimeToUtc(date: string, time: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Bad date "${date}", expected YYYY-MM-DD`);
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`Bad time "${time}", expected HH:mm`);
  }
  const utc = fromZonedTime(`${date}T${time}:00`, LONDON);
  if (Number.isNaN(utc.getTime())) {
    throw new Error(`Could not resolve ${date} ${time} London → UTC`);
  }
  return utc;
}
