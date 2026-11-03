/**
 * The fewest players a game is played with (2026-11-03, `min-players.ts`):
 * the organiser's day-before nudges that use it, what MatchTime says when
 * an organiser sets it by tagging it in WhatsApp ("@Match Time we can play
 * with 12", "@Match Time 12 kişiyle de oynarız"), and the web form's words.
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

  // ── WhatsApp, an organiser setting it ──
  /** Set. `places` is the game's places, which do not change. */
  set: (p: { activityName: string; minimum: number; places: number }) => string;
  /** Back to two full sides. */
  cleared: (p: { activityName: string; full: number }) => string;
  alreadySet: (p: { activityName: string; minimum: number }) => string;
  alreadyFull: (p: { activityName: string; full: number }) => string;
  tooHigh: (p: { activityName: string; places: number }) => string;
  tooLow: string;
  noNumber: (p: { url: string }) => string;
  /** Several weekly games and no day said. */
  whichGame: (p: { names: string[]; url: string }) => string;
  noGame: (p: { url: string }) => string;

  // ── The web form ──
  label: string;
  /** Under the box. `full` is two full sides of this game. */
  hint: (p: { full: number }) => string;
  /** The list row, only when a minimum is set. */
  row: (p: { minimum: number }) => string;
  invalid: (p: { places: number }) => string;
}

const BY_LANG: Record<Lang, MinPlayersCopy> = { en: MIN_PLAYERS_EN, tr: MIN_PLAYERS_TR };

export function minPlayersCopy(lang: Lang | string | null | undefined): MinPlayersCopy {
  return BY_LANG[normaliseLang(lang)];
}
