/**
 * What MatchTime says when an organiser sets the club's quiet hours by
 * tagging it in WhatsApp ("@Match Time turn off quiet hours now",
 * "@Match Time sessiz saatleri kapat"; 2026-10-31, `quiet-hours-words.ts`).
 *
 * One object per language, typed by `QuietHoursWordsCopy`, so a line
 * missing in either language is a `tsc` error. House rules (unit tested in
 * `__tests__/quiet-hours-words-copy.test.ts`): no em or en dashes, no slash
 * as a separator, never "waiting list", Turkish never equal to English.
 */
import { normaliseLang, type Lang } from "./lang";
import { QUIET_HOURS_WORDS_EN } from "./quiet-hours-words.en";
import { QUIET_HOURS_WORDS_TR } from "./quiet-hours-words.tr";

export interface QuietHoursWordsCopy {
  /** Switched off. `released`: held messages that now go out at once. */
  off: (p: { released: number }) => string;
  /** Switched on, or new times. "HH:MM" London. */
  on: (p: { from: string; to: string; released: number }) => string;
  alreadyOff: string;
  alreadyOn: (p: { from: string; to: string }) => string;
  /** A time that is not a time of day. `url` is the settings card. */
  badTime: (p: { url: string }) => string;
  /** The same time twice: no window. */
  sameTime: (p: { url: string }) => string;
}

const BY_LANG: Record<Lang, QuietHoursWordsCopy> = { en: QUIET_HOURS_WORDS_EN, tr: QUIET_HOURS_WORDS_TR };

export function quietHoursWordsCopy(lang: Lang | string | null | undefined): QuietHoursWordsCopy {
  return BY_LANG[normaliseLang(lang)];
}
