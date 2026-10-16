/**
 * WEEKLY DEADLINES, PURE (2026-09-30).
 *
 * Slices 1 and 3 of MDs/friday-group-features-plan-2026-09-30.md.
 *
 * Two club settings on `Organisation` (club level, D8: one group per club,
 * and a format switch must not move the deadline):
 *
 *   dropOutDeadlineDay + dropOutDeadlineTime   e.g. Monday 21:00
 *   listPublishDay     + listPublishTime       e.g. Tuesday 20:00
 *
 * Each resolves, per match, to the LAST occurrence of that weekday and
 * London wall-clock time strictly before kickoff (`weeklyDeadlinesFor`),
 * so nothing is stored on `Match`. With neither set a club behaves exactly
 * as before; the drop-out deadline is then the match's own sign-up
 * deadline (kickoff minus `Activity.deadlineHours`), which is what slice 1
 * shipped with.
 *
 * What the scheduler does with them (plan 3.2, 3.3):
 *   D1  the drop-out reminder in the group, 3 hours before the deadline,
 *       not before 09:00, skipped when that leaves under an hour;
 *   D2  the summary to the organisers when the deadline has passed,
 *       outside the club's quiet hours (by default 09:00 to 22:59 London);
 *   D3  the final list in the group at publish time;
 *   D4  with BOTH set, the daily 17:00 post stops except on match day.
 *
 * Pure: no database, no clock.
 */
import { formatLondon, londonDateTimeToUtc } from "./london-time";
import { MESSAGE_HOURS_FROM_TIME, MESSAGE_HOURS_TO_HOUR, inMessageHours, type QuietHours } from "./message-hours";

export interface DeadlineMatch {
  date: Date;
  attendanceDeadline: Date;
}

/** The four club columns, as Prisma returns them. */
export interface WeeklyDeadlineSettings {
  dropOutDeadlineDay: number | null;
  dropOutDeadlineTime: string | null;
  listPublishDay: number | null;
  listPublishTime: string | null;
}

/** Callers may hand over a partial row (unit-test fixtures build the
 *  org by hand); a missing field reads as unset. */
export type WeeklyDeadlineInput = Partial<WeeklyDeadlineSettings> | null | undefined;

export const NO_WEEKLY_DEADLINES: WeeklyDeadlineSettings = {
  dropOutDeadlineDay: null,
  dropOutDeadlineTime: null,
  listPublishDay: null,
  listPublishTime: null,
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function isDay(d: unknown): d is number {
  return typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6;
}
function isTime(t: unknown): t is string {
  return typeof t === "string" && TIME_RE.test(t);
}

/** One pair (day + time), or null when either half is missing or bad. */
function pair(day: unknown, time: unknown): { day: number; time: string } | null {
  return isDay(day) && isTime(time) ? { day, time } : null;
}

/** The London weekday (0 = Sunday) of a calendar date "yyyy-MM-dd". */
function weekdayOfDateKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "yyyy-MM-dd" minus `k` calendar days. */
function minusDays(key: string, k: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - k)).toISOString().slice(0, 10);
}

/**
 * The last instant strictly before `kickoff` that is `day` (0 = Sunday)
 * at `time` ("HH:mm") London wall clock. DST-safe: each candidate is
 * resolved on its own calendar date.
 */
export function lastWeekdayTimeBefore(kickoff: Date, day: number, time: string): Date {
  const kickoffDay = formatLondon(kickoff, "yyyy-MM-dd");
  for (let k = 0; k <= 7; k++) {
    const key = minusDays(kickoffDay, k);
    if (weekdayOfDateKey(key) !== day) continue;
    const at = londonDateTimeToUtc(key, time);
    if (at.getTime() < kickoff.getTime()) return at;
  }
  // Unreachable: within 8 calendar days every weekday occurs once
  // strictly before kickoff. Kept total for the type checker.
  return new Date(kickoff.getTime() - 7 * DAY_MS);
}

/** Both of a match's weekly instants; null where the club has not set one. */
export function weeklyDeadlinesFor(
  matchDate: Date,
  settings: WeeklyDeadlineInput,
): { dropOut: Date | null; listPublish: Date | null } {
  const d = pair(settings?.dropOutDeadlineDay, settings?.dropOutDeadlineTime);
  const p = pair(settings?.listPublishDay, settings?.listPublishTime);
  return {
    dropOut: d ? lastWeekdayTimeBefore(matchDate, d.day, d.time) : null,
    listPublish: p ? lastWeekdayTimeBefore(matchDate, p.day, p.time) : null,
  };
}

/**
 * The instant after which an OUT counts as a late drop-out: the club's
 * weekly drop-out deadline when set, otherwise the match's own sign-up
 * deadline.
 */
export function dropOutDeadlineFor(match: DeadlineMatch, club?: WeeklyDeadlineInput): Date {
  return weeklyDeadlinesFor(match.date, club).dropOut ?? match.attendanceDeadline;
}

/** D4: with both a drop-out deadline and a publish time, the week's
 *  rhythm is announce, reminder, summary, list, and the daily 17:00 post
 *  stops except on match day. */
export function hasWeeklyRhythm(settings: WeeklyDeadlineInput): boolean {
  return (
    pair(settings?.dropOutDeadlineDay, settings?.dropOutDeadlineTime) !== null &&
    pair(settings?.listPublishDay, settings?.listPublishTime) !== null
  );
}

// ── When each post is due ────────────────────────────────────────────

const REMINDER_LEAD_MS = 3 * HOUR_MS;
/** The group reminder is never before the message hours open (09:00). */
const REMINDER_EARLIEST = MESSAGE_HOURS_FROM_TIME;
const REMINDER_MIN_NOTICE_MS = HOUR_MS;

/** Organiser notices and the list speak outside the club's quiet hours
 *  (by default London 09:00 to 22:59). */
function inWakingHours(now: Date, quiet?: QuietHours | null): boolean {
  return inMessageHours(now, quiet ?? undefined);
}

/** D1: 3 hours before the deadline, not before 09:00 London that day;
 *  null (no reminder) when that leaves under an hour. */
export function dropOutReminderAt(deadline: Date): Date | null {
  const earliest = londonDateTimeToUtc(formatLondon(deadline, "yyyy-MM-dd"), REMINDER_EARLIEST);
  const at = new Date(Math.max(deadline.getTime() - REMINDER_LEAD_MS, earliest.getTime()));
  return deadline.getTime() - at.getTime() >= REMINDER_MIN_NOTICE_MS ? at : null;
}

/** Due from `dropOutReminderAt` until the deadline, and never inside the
 *  club's quiet hours (with the default hours it is always due between
 *  09:00 and 22:30, so this only bites a club's own window). */
export function dropOutReminderDue(now: Date, deadline: Date, quiet?: QuietHours | null): boolean {
  const at = dropOutReminderAt(deadline);
  return at !== null && now.getTime() >= at.getTime() && now.getTime() < deadline.getTime() && inWakingHours(now, quiet);
}

/** D2: the first tick after the deadline, inside waking hours, before kickoff. */
export function deadlineSummaryDue(now: Date, deadline: Date, kickoff: Date, quiet?: QuietHours | null): boolean {
  return now.getTime() >= deadline.getTime() && now.getTime() < kickoff.getTime() && inWakingHours(now, quiet);
}

/**
 * Was this match made AFTER its own drop-out deadline (2026-10-15)? Then
 * nobody can have dropped out of it before the deadline, and the posts
 * about that deadline (D1 the reminder, D2 the summary, and the pick
 * round that stands in for D2) would be noise. FNF went live at 22:12 on
 * a Thursday, after its Thursday 20:30 deadline; the game was made at
 * 22:17 and the organisers got "Drop-out deadline passed ... Squad 0/18".
 * `Match.createdAt` absent (an old fixture or a hand-built test row):
 * not after, so nothing changes for them.
 */
export function madeAfterDropOutDeadline(createdAt: Date | null | undefined, deadline: Date): boolean {
  return createdAt instanceof Date && createdAt.getTime() >= deadline.getTime();
}

/** D3: the first tick after publish time, inside waking hours, before kickoff. */
export function listPublishDue(now: Date, publishAt: Date, kickoff: Date, quiet?: QuietHours | null): boolean {
  return now.getTime() >= publishAt.getTime() && now.getTime() < kickoff.getTime() && inWakingHours(now, quiet);
}

// ── Settings validation (plan 3.1) ───────────────────────────────────

/**
 * Settings times stay inside the message hours, less the last half hour:
 * 09:00 to 22:30. So every post they trigger lands in waking hours, with
 * half an hour for the poll to send it before 23:00, and needs no
 * quiet-hours special case. (08:00 to 21:30 until 2026-10-13, when the
 * window was 08:00 to 22:00.)
 *
 * A time SAVED under the old rule (08:00 to 08:59) is not refused: see
 * `saved` on `validateWeeklyDeadlines`. It keeps resolving as before; the
 * posts it triggers wait for 09:00.
 */
export const SETTING_EARLIEST = MESSAGE_HOURS_FROM_TIME;
export const SETTING_LATEST = `${String(MESSAGE_HOURS_TO_HOUR - 1).padStart(2, "0")}:30`;

export type WeeklyDeadlineError =
  /** Day without time, or time without day. */
  | "incomplete"
  /** A day outside 0 to 6, or a time that is not HH:mm. */
  | "bad-value"
  /** A time before 09:00 or after 22:30 (`SETTING_EARLIEST`, `SETTING_LATEST`). */
  | "outside-hours"
  /** The drop-out deadline is not before the list publish time. */
  | "order"
  /** A time on match day at or after kickoff (it would fall in the week before). */
  | "after-kickoff";

export const WEEKLY_DEADLINE_ERRORS: readonly WeeklyDeadlineError[] = [
  "incomplete",
  "bad-value",
  "outside-hours",
  "order",
  "after-kickoff",
];

export interface ActivitySlot {
  dayOfWeek: number;
  time: string;
}

/** A sample kickoff for an activity: its weekday and time in a fixed
 *  week with no clock change (2026-01-05 is a Monday). */
function sampleKickoff(a: ActivitySlot): Date | null {
  if (!isDay(a.dayOfWeek) || !isTime(a.time)) return null;
  const offset = (a.dayOfWeek + 6) % 7; // Monday = 0
  return londonDateTimeToUtc(`2026-01-${String(5 + offset).padStart(2, "0")}`, a.time);
}

/**
 * Null when the settings are acceptable for every active activity of the
 * club, else the first problem. Clearing both pairs is always valid.
 *
 * `saved` is what the club has stored now. A pair that is EXACTLY the
 * saved one (same day, same time) skips the allowed-hours check and only
 * that check: the allowed hours moved from 08:00 to 21:30 to 09:00 to
 * 22:30 on 2026-10-13, and a club that saved 08:00 before must still be
 * able to save its other row. Changing that pair's day or time puts it
 * under the current hours.
 */
export function validateWeeklyDeadlines(
  s: WeeklyDeadlineSettings,
  activities: ActivitySlot[],
  saved?: WeeklyDeadlineInput,
): WeeklyDeadlineError | null {
  const halves: [unknown, unknown, unknown, unknown][] = [
    [s.dropOutDeadlineDay, s.dropOutDeadlineTime, saved?.dropOutDeadlineDay, saved?.dropOutDeadlineTime],
    [s.listPublishDay, s.listPublishTime, saved?.listPublishDay, saved?.listPublishTime],
  ];
  for (const [day, time, savedDay, savedTime] of halves) {
    if ((day == null) !== (time == null)) return "incomplete";
    if (day == null) continue;
    if (!isDay(day) || !isTime(time)) return "bad-value";
    const unchanged = day === savedDay && time === savedTime;
    if (!unchanged && (time < SETTING_EARLIEST || time > SETTING_LATEST)) return "outside-hours";
  }
  const d = pair(s.dropOutDeadlineDay, s.dropOutDeadlineTime);
  const p = pair(s.listPublishDay, s.listPublishTime);
  for (const a of activities) {
    for (const x of [d, p]) {
      if (x && x.day === a.dayOfWeek && x.time >= a.time) return "after-kickoff";
    }
  }
  if (d && p) {
    for (const a of activities) {
      const kickoff = sampleKickoff(a);
      if (!kickoff) continue;
      const dropOut = lastWeekdayTimeBefore(kickoff, d.day, d.time);
      const publish = lastWeekdayTimeBefore(kickoff, p.day, p.time);
      if (dropOut.getTime() >= publish.getTime()) return "order";
    }
  }
  return null;
}
