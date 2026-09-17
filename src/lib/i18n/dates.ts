/**
 * Per-language DATE LABELS, all Europe/London wall-clock.
 *
 * Locale is what a date LOOKS like; timezone is what it IS. Only the
 * first is per language: every club this product serves plays in
 * London, `src/lib/london-time.ts` is hardcoded to it, and that stays
 * (design section 3).
 *
 * Every English pattern here is EXACTLY the pattern its caller used
 * before this file existed, so the English bytes are unchanged; the
 * golden snapshot (`__tests__/copy-golden.test.ts`) and
 * `__tests__/dates.test.ts` both pin that. The Turkish patterns write
 * the day before the month and the weekday after it ("22 Eylül Salı
 * 21:30"), full weekday names rather than calendar abbreviations, and
 * no "at": that is how a Turkish club announcement is written by hand.
 *
 * Pure: a Date in, a string out. No clock.
 */
import { tr as trLocale } from "date-fns/locale";
import type { Locale } from "date-fns";
import { formatLondon } from "../london-time";
import { normaliseLang, type Lang } from "./lang";

/** The date-fns locale for a language, or undefined for English (date-fns'
 *  default is en-US, whose day and month names are the en-GB ones the
 *  existing patterns produce). */
function localeFor(lang: Lang): Locale | undefined {
  return lang === "tr" ? trLocale : undefined;
}

/** One London-formatted label per language. The English pattern is the
 *  caller's original, byte for byte. */
function label(lang: Lang | string | null | undefined, d: Date, patterns: Record<Lang, string>): string {
  const l = normaliseLang(lang);
  return formatLondon(d, patterns[l], localeFor(l));
}

/**
 * The pipeline's one kickoff label, `state.kickoffLabel`: "Tue 21:30" /
 * "Salı 21:30". Interpolated by about ten answers and by the slot-opened
 * line, and formatted ONCE at load time (`load-state.ts`), which is why
 * it takes the language rather than reading it (design section 7.7).
 */
export function kickoffLabel(lang: Lang | string | null | undefined, d: Date): string {
  return label(lang, d, { en: "EEE HH:mm", tr: "EEEE HH:mm" });
}

/** The match DAY, no time: "Tue 22 Sep" / "22 Eylül Salı". The rating
 *  DM's and promo's label. */
export function dayLabel(lang: Lang | string | null | undefined, d: Date): string {
  return label(lang, d, { en: "EEE d MMM", tr: "d MMMM EEEE" });
}

/** The announcement's long form: "Tuesday 22 September at 21:30" /
 *  "22 Eylül Salı 21:30". */
export function longDayTimeLabel(lang: Lang | string | null | undefined, d: Date): string {
  return label(lang, d, { en: "EEEE d MMMM 'at' HH:mm", tr: "d MMMM EEEE HH:mm" });
}

/** The cancel announcement's label: "Tue 22 Sep at 21:30" /
 *  "22 Eylül Salı 21:30". */
export function dayTimeLabel(lang: Lang | string | null | undefined, d: Date): string {
  return label(lang, d, { en: "EEE d MMM 'at' HH:mm", tr: "d MMMM EEEE HH:mm" });
}

/** The DM label a player reads for a match they are asked about:
 *  "Tue 22 Sep, 21:30" / "22 Eylül Salı 21:30" (the recruit invite and
 *  chase, the self-attendance ack, the admin recruit reply). */
export function dayCommaTimeLabel(lang: Lang | string | null | undefined, d: Date): string {
  return label(lang, d, { en: "EEE d MMM, HH:mm", tr: "d MMMM EEEE HH:mm" });
}

/**
 * The "Squad complete" post's label. The English one is NOT a date-fns
 * pattern: `squad-announce.ts` has always used `Intl.DateTimeFormat
 * ("en-GB")`, which spells September "Sept" where date-fns spells it
 * "Sep", and the English club has read "Sept" on every squad-complete
 * post. Kept byte for byte. Turkish has no such history and uses the
 * same long label as the announcement.
 */
export function squadCompleteLabel(lang: Lang | string | null | undefined, d: Date): string {
  if (normaliseLang(lang) === "tr") return longDayTimeLabel("tr", d);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(d)
    .replace(/,/g, "");
}

/**
 * The pieces of a match date, one at a time, for the scoped DM Q&A
 * (2026-09-17). Its context hands the model the day, the date and the
 * kickoff already written in the org's language, because a live Turkish
 * dry run caught the model calling a Friday match "Cumartesi" (1 of 30
 * answers): it was translating dates, and working weekdays out, from
 * text it had been given in English.
 */
/** The full weekday: "Friday" / "Cuma". */
export function weekdayLabel(lang: Lang | string | null | undefined, d: Date): string {
  return label(lang, d, { en: "EEEE", tr: "EEEE" });
}

/** Day and month, no weekday and no year: "18 September" / "18 Eylül". */
export function dayOfMonthLabel(lang: Lang | string | null | undefined, d: Date): string {
  return label(lang, d, { en: "d MMMM", tr: "d MMMM" });
}

/**
 * A completed match's date in the recent-history block. The English one
 * is NOT a date-fns pattern: `match-history.ts` has always written
 * `Intl.DateTimeFormat("en-GB")`'s "04 Sept 2026", and it is kept byte
 * for byte. Turkish writes the weekday too ("4 Eylül 2026 Cuma"), so a
 * model answering about "last week's match" copies a weekday rather than
 * computing one.
 */
export function historyDateLabel(lang: Lang | string | null | undefined, d: Date): string {
  if (normaliseLang(lang) === "tr") return formatLondon(d, "d MMMM yyyy EEEE", trLocale);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}

/** The wall-clock alone, "21:30". Language-free: every language this
 *  product ships writes 24-hour HH:mm. */
export function timeLabel(d: Date): string {
  return formatLondon(d, "HH:mm");
}
