/**
 * What MatchTime says when an organiser sets the club's pitch by WhatsApp
 * ("@Match Time our pitch is Goals Sutton"), and when one asks it to try
 * again with nothing waiting (2026-10-28, `venue-from-words.ts`,
 * `refused-ask-retry.ts`).
 *
 * One object per language (`admin-venue.en.ts`, `admin-venue.tr.ts`), typed
 * by `AdminVenueCopy`, so a line missing in either language is a `tsc`
 * error. House rules (unit tested in `__tests__/admin-venue-copy.test.ts`):
 * no em or en dashes, no slash as a separator, never "waiting list",
 * Turkish never equal to English.
 */
import { normaliseLang, type Lang } from "./lang";
import { ADMIN_VENUE_EN } from "./admin-venue.en";
import { ADMIN_VENUE_TR } from "./admin-venue.tr";

export interface AdminVenueCopy {
  /** The pitch is set. `address` may be "". `url` is the settings page. */
  set: (p: { name: string; address: string; url: string }) => string;
  /** Several places came back: which one. `options` are "Name, where". */
  which: (p: { words: string; options: string[] }) => string;
  /** Google found nothing for the words. */
  none: (p: { words: string; url: string }) => string;
  /** Places cannot be looked up right now (no key, the cap, Google down). */
  unavailable: (p: { url: string }) => string;
  /** A pitch was asked to be set without its name. */
  noName: string;
  /** "Try again", and nothing of MatchTime's is waiting to be tried again. */
  nothingToRetry: string;
}

const BY_LANG: Record<Lang, AdminVenueCopy> = { en: ADMIN_VENUE_EN, tr: ADMIN_VENUE_TR };

export function adminVenueCopy(lang: Lang | string | null | undefined): AdminVenueCopy {
  return BY_LANG[normaliseLang(lang)];
}
