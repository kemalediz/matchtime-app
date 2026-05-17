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
    throw new Error(`Bad time "${time}" — expected HH:mm`);
  }
  // Pull the calendar day in London (handles pre/post DST transitions).
  const y = Number(formatInTimeZone(anchor, LONDON, "yyyy"));
  const mo = Number(formatInTimeZone(anchor, LONDON, "MM"));
  const d = Number(formatInTimeZone(anchor, LONDON, "dd"));
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
  return fromZonedTime(iso, LONDON);
}

/** Format a Date for display in London time. */
export function formatLondon(d: Date, pattern: string): string {
  return formatInTimeZone(d, LONDON, pattern);
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
    throw new Error(`Bad date "${date}" — expected YYYY-MM-DD`);
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`Bad time "${time}" — expected HH:mm`);
  }
  const utc = fromZonedTime(`${date}T${time}:00`, LONDON);
  if (Number.isNaN(utc.getTime())) {
    throw new Error(`Could not resolve ${date} ${time} London → UTC`);
  }
  return utc;
}
