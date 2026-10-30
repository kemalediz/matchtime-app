/**
 * §3.2 S22, "reminder_request incl. calendar arithmetic": WHEN A REMINDER
 * IS SENT.
 *
 * 2026-10-30, "no string parsing". Until today the admin extractor
 * returned the time PHRASE as written ("tomorrow at 6", "yarın 6'da") and
 * this file read it with a vocabulary of weekday names, parts of the day,
 * durations and Turkish rewrites. That is code working out what a person
 * meant from their words, so it is gone. The extractor now states the
 * reminder's time itself, as a London wall-clock date and time
 * ("YYYY-MM-DD HH:MM", `remindAt`), worked out from the NOW line it is
 * shown, the same way it already states season-break months as "YYYY-MM".
 *
 * WHAT CODE STILL DOES, AND WHY. Turning a London wall-clock reading into
 * an instant is where DST bites, and that stays here (`date-fns-tz`), so
 * the model never does time-zone arithmetic. The format check is a check
 * on the MODEL'S OUTPUT against its own contract, not a reading of the
 * person's words: anything that is not a real date and time is refused,
 * and a refusal means no reminder (the engine degrades it, never guesses).
 * The engine's 60-day window still applies on top.
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { dayTimeLabel } from "./i18n/dates";
import { normaliseLang, type Lang } from "./i18n/lang";

const LONDON = "Europe/London";

export type ReminderResolution =
  | {
      ok: true;
      /** The instant to queue, in UTC. */
      at: Date;
      /** "Mon 7 Sep at 18:00", London, in the group's language. */
      whenLabel: string;
      /** The time asked for does not exist in London (the clocks go
       *  forward that night) and was moved to the next valid time. */
      shiftedForClocks: boolean;
    }
  | { ok: false; reason: string };

/** The extractor's contract for `remindAt`: "YYYY-MM-DD HH:MM", London. */
const REMIND_AT = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;

/**
 * The instant a London wall-clock "YYYY-MM-DD HH:MM" (the admin
 * extractor's `remindAt`) stands for, with its label. Refuses anything
 * that is not a real calendar date and time.
 */
export function reminderInstant(remindAt: string, lang?: Lang | string | null): ReminderResolution {
  const raw = (remindAt ?? "").trim();
  const m = REMIND_AT.exec(raw);
  if (!m) return { ok: false, reason: `the reminder time "${raw}" is not YYYY-MM-DD HH:MM` };
  const [, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) {
    return { ok: false, reason: `the reminder time "${raw}" is not a real date and time` };
  }
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  // A day that does not exist ("2026-02-30") rolls over in Date: refuse it.
  const probe = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== day) {
    return { ok: false, reason: `the reminder time "${raw}" is not a real date` };
  }
  // THE CLOCKS-GO-FORWARD GAP: a wall-clock time that never happens in
  // London (01:30 on the last Sunday of March). Moved to the next valid
  // time, a minute at a time, and the caller says so.
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, mi);
  let at: Date | null = null;
  let shiftedForClocks = false;
  for (let step = 0; step <= 120; step++) {
    const w = new Date(wall + step * 60_000).toISOString().slice(0, 16);
    const candidate = fromZonedTime(`${w}:00`, LONDON);
    if (formatInTimeZone(candidate, LONDON, "yyyy-MM-dd'T'HH:mm") === w) {
      at = candidate;
      shiftedForClocks = step > 0;
      break;
    }
  }
  if (!at) return { ok: false, reason: `the reminder time "${raw}" does not exist in London` };
  const l = normaliseLang(lang);
  const whenLabel = l === "en" ? formatInTimeZone(at, LONDON, "EEE d MMM 'at' HH:mm") : dayTimeLabel(l, at);
  return { ok: true, at, whenLabel, shiftedForClocks };
}
