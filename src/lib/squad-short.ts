/**
 * WHEN THE SCHEDULER CALLS A SQUAD "SHORT" (2026-11-04). PURE.
 *
 * One definition for every "short" the scheduler says to the organisers:
 * the 10:00 "Low numbers" switch offer and the match-day chase notices to
 * the admin channel ("Kickoff is getting close and the squad is still
 * short"). Until now the nudge counted against the game's minimum and the
 * chase against the places, so FNF (12 to 18, 12 confirmed) heard "still
 * short" three times on a match day the game was on (club replay,
 * 2026-11-04).
 *
 * Short is below the game's own minimum (`Activity.minPlayers`), or below
 * two full sides of the game's own format when none is set. A match
 * switched up a size (format-resize.ts) is not short at two full sides of
 * its format (review of #517). With no minimum set and the format's own
 * places this is `confirmed < maxPlayers`, exactly as before.
 *
 * NOT this definition:
 *  - the players' chase for open places, which still asks while any place
 *    is open (the places stay the format's, min-players.ts);
 *  - the 18:00 "Match in trouble" cancel offer, which asks whether the
 *    game can be played at all, in any of the club's formats of the sport
 *    (`minimumToPlay`). Under the range rules (a minimum is never above
 *    the format's places, flex-format-rules.ts) it is at or below this.
 */
import { lowNumbersBelow } from "./min-players";

export interface SquadShortGame {
  /** The organiser's own minimum (`Activity.minPlayers`), or null. */
  minPlayers: number | null;
  /** The match's places (`Match.maxPlayers`). */
  maxPlayers: number;
  /** The game's format (`Sport.playersPerTeam`). */
  playersPerTeam: number;
}

/** The squad is short below this many confirmed. */
export function shortBelow(g: SquadShortGame): number {
  return lowNumbersBelow({
    minPlayers: g.minPlayers,
    maxPlayers: Math.min(g.maxPlayers, g.playersPerTeam * 2),
  });
}

export function isSquadShort(confirmed: number, g: SquadShortGame): boolean {
  return confirmed < shortBelow(g);
}
