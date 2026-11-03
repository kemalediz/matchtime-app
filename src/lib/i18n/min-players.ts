/**
 * The fewest players a game is played with (2026-11-03, `min-players.ts`):
 * the organiser's day-before nudges that use it. Setting it (WhatsApp and
 * the web form) is in `flex-format.ts`, with the most players.
 *
 * One object per language, typed by `MinPlayersCopy`, so a line missing in
 * either language is a `tsc` error. House rules (unit tested in
 * `__tests__/min-players-copy.test.ts`): no em or en dashes, no slash as a
 * separator, never "waiting list", Turkish never equal to English.
 */
import { normaliseLang, type Lang } from "./lang";
import { MIN_PLAYERS_EN } from "./min-players.en";
import { MIN_PLAYERS_TR } from "./min-players.tr";

/** Who reads a nudge: an organiser's DM (a sign-in link and the plain
 *  page), or the organisers' group (the link only). */
export type NudgeAudience = "dm" | "group";

export interface MinPlayersCopy {
  /** 10:00 the day before: below the minimum, a smaller format exists. */
  lowNumbers: (p: {
    confirmed: number;
    maxPlayers: number;
    activityName: string;
    switchTo: string;
    switchPlayers: number;
    signInUrl: string;
    pageUrl: string;
    audience: NudgeAudience;
  }) => string;
  /** 18:00 the day before: below the fewest the club can play with. */
  matchInTrouble: (p: {
    confirmed: number;
    minimum: number;
    activityName: string;
    signInUrl: string;
    pageUrl: string;
    audience: NudgeAudience;
  }) => string;

  // The setting itself (WhatsApp and the activities page) moved to
  // `flex-format.ts` with the maximum (2026-11-03).
}

const BY_LANG: Record<Lang, MinPlayersCopy> = { en: MIN_PLAYERS_EN, tr: MIN_PLAYERS_TR };

export function minPlayersCopy(lang: Lang | string | null | undefined): MinPlayersCopy {
  return BY_LANG[normaliseLang(lang)];
}
