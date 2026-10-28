/**
 * MESSAGE HOURS: the daytime window for messages MatchTime holds back
 * rather than send at night. PURE: no database, no clock of its own.
 *
 * QUIET HOURS ARE A CLUB SETTING (Kemal, 2026-10-16). Each club chooses on
 * /admin/settings whether MatchTime keeps quiet hours for it, and from when
 * to when (London): the Organisation columns `quietHoursEnabled`,
 * `quietHoursFrom`, `quietHoursTo`, read through `quietHoursOf`. The
 * default for every club is ON, 23:00 to 09:00, which is exactly the
 * window below, so a club that never touches it sees no change. Off:
 * nothing the club sends is held.
 *
 * The default window: 09:00 (inclusive) to 23:00 (exclusive), London wall
 * clock. A message that becomes due outside it waits for the next 09:00
 * London. Owner decisions: 2026-10-12 for the messages that waited for
 * 10:00 to 20:00, 2026-10-13 for the ones that waited for 08:00 to 22:00.
 *
 * The ONE definition of the daytime window. Every gate on it takes its
 * hours from here (`inMessageHours`, `messageHoursSendAfter`,
 * `messageHoursDayStart`, or the constants where a caller has conditions
 * of its own).
 *
 * CLUB gates, which pass the club's `QuietHours`:
 *   - admin notices and admin group posts (rolling-squad-rules.ts,
 *     admin-channel-rules.ts, admin-channel.ts), and the AI cap notice's
 *     cutoff (ai-cap-notice.ts);
 *   - the monthly squad's posts and DMs (month-signup-rules.ts,
 *     month-signup.ts, month-payment-rules.ts, month-payment.ts,
 *     month-close-rules.ts, month-close.ts, monthly-week-rules.ts,
 *     monthly-week.ts, monthly-paste.ts);
 *   - the weekly deadline posts (weekly-deadlines.ts);
 *   - organiser picks, bench offers and recruit chases
 *     (organiser-pick-rules.ts, bot-scheduler.ts, recruit-chase.ts);
 *   - the seed nudge (seed-nudge-rules.ts);
 *   - a club's one player pool share post, sent from club settings
 *     (pool/club-share.ts), and the one message telling its admin team the
 *     player pool is on for it (pool/club-switch.ts);
 *   - the weekly per-match payment DMs (2026-10-21): the pay links
 *     (payment-flow.ts, whose ack to the collector goes at once and says
 *     when they go out), the collector's fee question and the daily pay
 *     chase with its collector nudge (bot-scheduler.ts), the free place DM
 *     (fee-waiver.ts) and the collector's notice that a player is paying
 *     directly (direct-payment.ts).
 *
 * PLATFORM gates, MatchTime's own messages, not the club's: the default
 * window, whatever a club chose:
 *   - billing DMs, the month's close and charge, the day 21 and day 28
 *     reminders (club-billing-schedule-rules.ts);
 *   - the setup DMs to a new club's organiser (setup-learning/run.ts,
 *     club-setup-dm.ts, club-setup-reminder.ts, club-setup-removal.ts,
 *     club-setup-owner-live.ts);
 *   - the owner's approval and setup DMs (owner-dm.ts);
 *   - the times an organiser may choose for the weekly deadlines
 *     (weekly-deadlines.ts `SETTING_EARLIEST`, `SETTING_LATEST`).
 *
 * NOT this window: a post tied to one hour of the day (the 17:00 update,
 * the 18:00 chases, the unpaid list, badges, Man of the Match). Those are
 * schedules and keep their own hours in their own files.
 * `__tests__/message-hours-source-guard.test.ts` fails when a second
 * definition of the window appears, and when a file named in the CLUB gates
 * above stops reading the club's quiet hours.
 */
import { formatLondon, londonDateTimeToUtc } from "./london-time";

/** Held messages go out from 09:00 London ... */
export const MESSAGE_HOURS_FROM_HOUR = 9;
/** ... until 23:00 London (exclusive: 22:59 is the last minute). */
export const MESSAGE_HOURS_TO_HOUR = 23;
/** The window's opening as a London wall clock time, "09:00". */
export const MESSAGE_HOURS_FROM_TIME = `${String(MESSAGE_HOURS_FROM_HOUR).padStart(2, "0")}:00`;
/** The default quiet hours start, "23:00": the window's close. */
export const QUIET_HOURS_DEFAULT_FROM = `${String(MESSAGE_HOURS_TO_HOUR).padStart(2, "0")}:00`;

/** A club's quiet hours: London "HH:MM" times, `from` inclusive, `to` exclusive. */
export interface QuietHours {
  enabled: boolean;
  from: string;
  to: string;
}

/** Every club's default: ON, 23:00 to 09:00 (the window before the setting existed). */
export const DEFAULT_QUIET_HOURS: Readonly<QuietHours> = Object.freeze({
  enabled: true,
  from: QUIET_HOURS_DEFAULT_FROM,
  to: MESSAGE_HOURS_FROM_TIME,
});

/** "HH:MM" (24 hours, a one digit hour padded), or null. */
export function normaliseQuietTime(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** The Organisation columns that hold a club's quiet hours. */
export interface QuietHoursRow {
  quietHoursEnabled?: boolean | null;
  quietHoursFrom?: string | null;
  quietHoursTo?: string | null;
}

/** The select for `quietHoursOf`. */
export const QUIET_HOURS_SELECT = { quietHoursEnabled: true, quietHoursFrom: true, quietHoursTo: true } as const;

/**
 * The club's quiet hours from its Organisation row. A missing row, absent
 * columns (an older select) or unusable times mean the default times; so
 * does the same time twice, which would be no window at all.
 */
export function quietHoursOf(row: QuietHoursRow | null | undefined): QuietHours {
  const enabled = row?.quietHoursEnabled ?? true;
  const from = normaliseQuietTime(row?.quietHoursFrom);
  const to = normaliseQuietTime(row?.quietHoursTo);
  if (!from || !to || from === to) return { ...DEFAULT_QUIET_HOURS, enabled };
  return { enabled, from, to };
}

/** What an organiser may save: off, or two different valid times. */
export function validateQuietHours(input: {
  enabled: boolean;
  from?: unknown;
  to?: unknown;
}): { ok: true; value: { enabled: false } | QuietHours } | { ok: false; error: "bad-time" | "same-time" } {
  if (typeof input?.enabled !== "boolean") return { ok: false, error: "bad-time" };
  if (!input.enabled) return { ok: true, value: { enabled: false } };
  const from = normaliseQuietTime(input.from);
  const to = normaliseQuietTime(input.to);
  if (!from || !to) return { ok: false, error: "bad-time" };
  if (from === to) return { ok: false, error: "same-time" };
  return { ok: true, value: { enabled: true, from, to } };
}

const DAY_MS = 24 * 60 * 60 * 1000;

const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function londonMinutes(now: Date): number {
  return Number(formatLondon(now, "H")) * 60 + Number(formatLondon(now, "m"));
}

/** Is `now` inside the club's quiet hours? Never, with them off. */
export function inQuietHours(now: Date, quiet: QuietHours = DEFAULT_QUIET_HOURS): boolean {
  if (!quiet.enabled) return false;
  const m = londonMinutes(now);
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  return from < to ? m >= from && m < to : m >= from || m < to;
}

/** Outside the club's quiet hours (by default: is it 09:00 to 22:59 in London?). */
export function inMessageHours(now: Date, quiet: QuietHours = DEFAULT_QUIET_HOURS): boolean {
  return !inQuietHours(now, quiet);
}

/**
 * The `sendAfter` for a message queued at `now`: null outside the club's
 * quiet hours (send at once), else when they end (by default the next
 * 09:00 London).
 */
export function messageHoursSendAfter(now: Date, quiet: QuietHours = DEFAULT_QUIET_HOURS): Date | null {
  if (!inQuietHours(now, quiet)) return null;
  // Still before today's end time: today. Otherwise (the quiet hours began
  // this evening and cross midnight): tomorrow, as a London calendar date,
  // so a 23 or 25 hour day cannot land on the wrong one.
  const today = formatLondon(now, "yyyy-MM-dd");
  if (londonMinutes(now) < minutesOf(quiet.to)) return londonDateTimeToUtc(today, quiet.to);
  const [y, mo, d] = today.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(y, mo - 1, d, 12) + DAY_MS).toISOString().slice(0, 10);
  return londonDateTimeToUtc(tomorrow, quiet.to);
}

/**
 * When the club's day starts, for the posts anchored to the morning (the
 * match day list): when its quiet hours end, or 09:00 with them off, so a
 * club with nothing held still gets its morning post in the morning.
 */
export function messageHoursDayStart(quiet: QuietHours = DEFAULT_QUIET_HOURS): string {
  return quiet.enabled ? quiet.to : MESSAGE_HOURS_FROM_TIME;
}
