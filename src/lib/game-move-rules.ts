/**
 * A GAME'S DAY OR TIME BY WHATSAPP: WHAT CODE DOES WITH THE MODEL'S READING
 * (Kemal, 2026-11-10: "@Match Time move Monday's game to 8:15", "@Match
 * Time from now on we kick off at 8:15"; every admin feature also works by
 * tagging MatchTime). Pure: no database, no clock.
 *
 * The admin extractor (the model) is shown the club's games still to be
 * played, numbered (`gamesToComeLines`, the GAMES TO COME block), and reads
 * the message into `move_game` facts: the game's number, the new weekday,
 * the new London time, and whether it is the weekly game from now on.
 * Nothing here reads the message's words. Code checks each value against
 * what it showed and what a kickoff can be:
 *
 *   one game        the game the number names, to the new time (or its own)
 *                   and, for a new day, that weekday in the same week
 *                   (`planGameKickoff`, the rule #577 uses for each game);
 *   every week      the activity of the game named, or the club's only
 *                   weekly game, through the edit form's own save
 *                   (`changeActivityKickoff`);
 *   which?          no game named (or one not on the list) and more than
 *                   one it could be: ONE short question, never a guess;
 *   say what        no new day and no new time, or a time that is not a
 *                   time of day.
 */
import { formatLondon } from "./london-time";
import type { AdminFacts } from "./pipeline/types";

/** A game still to be played, as listed for the model and for code. */
export interface GameToCome {
  id: string;
  date: Date;
  activityId: string;
  activityName: string;
}

/** A club's weekly game (an active Activity). */
export interface WeeklyGame {
  id: string;
  name: string;
}

/** How many games the model is shown: the next few, enough for "next
 *  Monday's" and "the one on the 24th" without a long list. */
export const GAMES_TO_COME_MAX = 6;

/**
 * The GAMES TO COME lines the model reads: "1. Monday 16 November 2026 at
 * 20:30 (Monday Vets)". English and London time, whatever the club's
 * language: it is the model's context, never shown to a player.
 */
export function gamesToComeLines(games: readonly GameToCome[]): string[] {
  return games.map((g, i) => `${i + 1}. ${formatLondon(g.date, "EEEE d MMMM yyyy 'at' HH:mm")} (${g.activityName})`);
}

export interface MoveGameWords {
  /** The game's number in the list shown, or null when none was said. */
  game: number | null;
  /** 0 = Sunday .. 6 = Saturday, or null when the day stays. */
  newDay: number | null;
  /** London "HH:mm", or null when the time stays (or was unreadable). */
  newTime: string | null;
  everyWeek: boolean;
  /** A time was given and was not a time of day. */
  unreadableTime?: true;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The model's time as "HH:mm": its own "8:15" is padded to "08:15";
 *  anything else that is not a time of day is null. */
function timeOf(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const padded = /^\d:\d\d$/.test(raw) ? `0${raw}` : raw;
  return HHMM.test(padded) ? padded : null;
}

/** The `move_game` facts, checked: a weekday 0 to 6, a time of day, a game number from 1. */
export function moveGameWordsOf(f: AdminFacts): MoveGameWords {
  const newTime = timeOf(f.newTime);
  return {
    game: Number.isInteger(f.game) && (f.game as number) > 0 ? (f.game as number) : null,
    newDay: Number.isInteger(f.newDay) && (f.newDay as number) >= 0 && (f.newDay as number) <= 6 ? (f.newDay as number) : null,
    newTime,
    everyWeek: f.everyWeek === true,
    ...(f.newTime !== undefined && newTime === null ? { unreadableTime: true as const } : {}),
  };
}

export type MoveGamePlan =
  | { kind: "say-what" }
  | { kind: "no-games" }
  | { kind: "which"; options: GameToCome[]; toDayOfWeek: number | null; toTime: string | null }
  | { kind: "which-weekly"; options: WeeklyGame[]; toDayOfWeek: number | null; toTime: string | null }
  | { kind: "one"; game: GameToCome; toDayOfWeek: number | null; toTime: string }
  | { kind: "every-week"; activityId: string; activityName: string; dayOfWeek?: number; time?: string };

/**
 * What to do with a reading, given the games the model was shown (in that
 * order) and the club's weekly games.
 */
export function planMoveGame(words: MoveGameWords, games: readonly GameToCome[], weekly: readonly WeeklyGame[]): MoveGamePlan {
  // Nothing to move it to, or a time that could not be read (never dropped
  // for the day alone): ask.
  if ((words.newDay === null && words.newTime === null) || words.unreadableTime) return { kind: "say-what" };
  const named = words.game !== null && words.game <= games.length ? games[words.game - 1] : null;

  if (words.everyWeek) {
    const activity = named
      ? { id: named.activityId, name: named.activityName }
      : weekly.length === 1
        ? weekly[0]
        : null;
    if (!activity) {
      if (weekly.length === 0) return { kind: "no-games" };
      return { kind: "which-weekly", options: [...weekly], toDayOfWeek: words.newDay, toTime: words.newTime };
    }
    return {
      kind: "every-week",
      activityId: activity.id,
      activityName: activity.name,
      ...(words.newDay !== null ? { dayOfWeek: words.newDay } : {}),
      ...(words.newTime !== null ? { time: words.newTime } : {}),
    };
  }

  if (games.length === 0) return { kind: "no-games" };
  const game = named ?? (games.length === 1 && words.game === null ? games[0] : null);
  if (!game) return { kind: "which", options: [...games], toDayOfWeek: words.newDay, toTime: words.newTime };
  return { kind: "one", game, toDayOfWeek: words.newDay, toTime: words.newTime ?? formatLondon(game.date, "HH:mm") };
}
