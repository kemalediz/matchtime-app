/**
 * What MatchTime says when an organiser moves a game by tagging it in
 * WhatsApp (2026-11-10, `game-move-words.ts`): "@Match Time move Monday's
 * game to 20:15", "@Match Time from now on we kick off at 20:15". The move
 * is quiet: these lines go to the organiser who asked, and nothing is posted
 * in the players' group, which the reply says.
 *
 * Every date and time arrives already written in the club's language
 * (`i18n/dates.ts`). One object per language, typed by `GameMoveCopy`, so a
 * line missing in either language is a `tsc` error. House rules (unit
 * tested in `__tests__/game-move-copy.test.ts`): no em or en dashes, no
 * slash as a separator, never "waiting list", Turkish never equal to
 * English.
 */
import { normaliseLang, type Lang } from "./lang";
import { GAME_MOVE_EN } from "./game-move.en";
import { GAME_MOVE_TR } from "./game-move.tr";

/** Why a game stayed where it was (`KickoffStayReason`, plus "gone"). */
export type GameStayReason = "started" | "set-by-hand" | "into-the-past" | "other-month" | "unreadable-time" | "unchanged" | "gone";

export interface GameMoveCopy {
  /** One game moved. `day`: its old day ("Mon 16 Nov"); `toDay`: the new
   *  day when it changed, else null; `time` and `was`: the new and old kickoff. */
  movedOne: (p: { day: string; toDay: string | null; time: string; was: string }) => string;
  /** One game left as it was, and why. `to`: the new kickoff asked for. */
  stayedOne: (p: { reason: GameStayReason; day: string; time: string; to: string }) => string;
  /** The weekly game's new day or time. `weekday`: "Monday"; `moved`: the
   *  days of the games that moved; `stayed`: those left, with their reasons. */
  movedWeekly: (p: { name: string; weekday: string; time: string; moved: string[]; stayed: Array<{ day: string; reason: GameStayReason }> }) => string;
  /** The weekly game already has that day and time. */
  weeklyUnchanged: (p: { name: string; weekday: string; time: string }) => string;
  /** Which game? `options`: each game, "Mon 16 Nov 20:30 (Monday Vets)";
   *  `change`: what it moves to ("20:15", "Wednesday 20:15"). */
  which: (p: { options: string[]; change: string }) => string;
  /** Which weekly game? `options`: the activity names. */
  whichWeekly: (p: { options: string[]; change: string }) => string;
  /** No new day and no time that can be read. */
  sayWhat: string;
  /** No game coming up to move. */
  noGames: string;
  /** The weekly save refused what was read (not a time of day). */
  invalid: string;
}

const BY_LANG: Record<Lang, GameMoveCopy> = { en: GAME_MOVE_EN, tr: GAME_MOVE_TR };

export function gameMoveCopy(lang: Lang | string | null | undefined): GameMoveCopy {
  return BY_LANG[normaliseLang(lang)];
}
