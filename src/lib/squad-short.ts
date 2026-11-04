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
 * K1 (Kemal, 2026-11-04, club summary B1): at or above the minimum the
 * game is ON. The players' chases still ask for the open places
 * (`placesOpen`) while any is open, but say "places left", never "short";
 * "at risk" (chase-risk.ts) and the format-switch line need `short`. Every
 * "short" and "places open" in the code reads this file (`squadNumbers`,
 * which the club summary's `matchNumbers` returns).
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
  return squadNumbersAt({ places: g.maxPlayers, confirmed, shortBelow: shortBelow(g) }).short;
}

/**
 * THE PLACES STILL OPEN (club summary B1, 2026-11-04): the match's places
 * less its confirmed players, never negative. A bad capacity is no places,
 * so a broken row can never make MatchTime ask for players. The one
 * definition of "places open": every post, answer, DM and page that counts
 * them calls this (the one-derive guard keeps it so).
 */
export function placesOpen(places: number, confirmed: number): number {
  const p = Number.isFinite(places) ? places : 0;
  const c = Number.isFinite(confirmed) ? confirmed : 0;
  return Math.max(0, p - c);
}

export interface SquadNumbers {
  /** `placesOpen`: what the players' chases ask to fill. */
  placesOpen: number;
  /** `shortBelow`. */
  shortBelow: number;
  /** `isSquadShort`: below the game's minimum. The only meaning of
   *  "short", and of "at risk" being possible (K1, Kemal 2026-11-04: at
   *  or above the minimum the game is on). */
  short: boolean;
}

/** A match's numbers: places open and short, from one rule. The club
 *  summary's `matchNumbers` is this. */
export function squadNumbers(p: {
  places: number;
  confirmed: number;
  minPlayers: number | null;
  playersPerTeam: number;
}): SquadNumbers {
  const g = { minPlayers: p.minPlayers, maxPlayers: p.places, playersPerTeam: p.playersPerTeam };
  return squadNumbersAt({ places: p.places, confirmed: p.confirmed, shortBelow: shortBelow(g) });
}

/** The same numbers when the game's threshold is already known (a
 *  caller handed `shortBelow` by the scheduler, which read the game). */
export function squadNumbersAt(p: { places: number; confirmed: number; shortBelow: number }): SquadNumbers {
  return { placesOpen: placesOpen(p.places, p.confirmed), shortBelow: p.shortBelow, short: p.confirmed < p.shortBelow };
}

/** A match row as the web pages read it (the match, its game and the
 *  game's sport): its numbers by the one rule, so a page never works out
 *  the game's minimum itself. */
export function matchSquadNumbers(
  m: { maxPlayers: number; activity: { minPlayers: number | null; sport: { playersPerTeam: number } } },
  confirmed: number,
): SquadNumbers {
  return squadNumbers({ places: m.maxPlayers, confirmed, minPlayers: m.activity.minPlayers, playersPerTeam: m.activity.sport.playersPerTeam });
}
