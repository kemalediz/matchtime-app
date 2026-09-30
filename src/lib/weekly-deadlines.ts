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
 *       08:00 to 21:59 London;
 *   D3  the final list in the group at publish time;
 *   D4  with BOTH set, the daily 17:00 post stops except on match day.
 *
 * Pure: no database, no clock.
 */
import { formatLondon, londonDateTimeToUtc } from "./london-time";

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
const REMINDER_EARLIEST = "09:00";
const REMINDER_MIN_NOTICE_MS = HOUR_MS;
/** Organiser notices and the list speak London 08:00 to 21:59. */
const WAKING_FROM_HOUR = 8;
const QUIET_FROM_HOUR = 22;

function inWakingHours(now: Date): boolean {
  const h = Number(formatLondon(now, "H"));
  return h >= WAKING_FROM_HOUR && h < QUIET_FROM_HOUR;
}

/** D1: 3 hours before the deadline, not before 09:00 London that day;
 *  null (no reminder) when that leaves under an hour. */
export function dropOutReminderAt(deadline: Date): Date | null {
  const earliest = londonDateTimeToUtc(formatLondon(deadline, "yyyy-MM-dd"), REMINDER_EARLIEST);
  const at = new Date(Math.max(deadline.getTime() - REMINDER_LEAD_MS, earliest.getTime()));
  return deadline.getTime() - at.getTime() >= REMINDER_MIN_NOTICE_MS ? at : null;
}

export function dropOutReminderDue(now: Date, deadline: Date): boolean {
  const at = dropOutReminderAt(deadline);
  return at !== null && now.getTime() >= at.getTime() && now.getTime() < deadline.getTime();
}

/** D2: the first tick after the deadline, inside waking hours, before kickoff. */
export function deadlineSummaryDue(now: Date, deadline: Date, kickoff: Date): boolean {
  return now.getTime() >= deadline.getTime() && now.getTime() < kickoff.getTime() && inWakingHours(now);
}

/** D3: the first tick after publish time, inside waking hours, before kickoff. */
export function listPublishDue(now: Date, publishAt: Date, kickoff: Date): boolean {
  return now.getTime() >= publishAt.getTime() && now.getTime() < kickoff.getTime() && inWakingHours(now);
}

// ── Settings validation (plan 3.1) ───────────────────────────────────

/** Settings times stay inside 08:00 to 21:30, so every post they trigger
 *  lands in waking hours and needs no quiet-hours special case. */
const SETTING_EARLIEST = "08:00";
const SETTING_LATEST = "21:30";

export type WeeklyDeadlineError =
  /** Day without time, or time without day. */
  | "incomplete"
  /** A day outside 0 to 6, or a time that is not HH:mm. */
  | "bad-value"
  /** A time before 08:00 or after 21:30. */
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
 */
export function validateWeeklyDeadlines(
  s: WeeklyDeadlineSettings,
  activities: ActivitySlot[],
): WeeklyDeadlineError | null {
  const halves: [unknown, unknown][] = [
    [s.dropOutDeadlineDay, s.dropOutDeadlineTime],
    [s.listPublishDay, s.listPublishTime],
  ];
  for (const [day, time] of halves) {
    if ((day == null) !== (time == null)) return "incomplete";
    if (day == null) continue;
    if (!isDay(day) || !isTime(time)) return "bad-value";
    if (time < SETTING_EARLIEST || time > SETTING_LATEST) return "outside-hours";
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
