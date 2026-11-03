/**
 * THE FEWEST PLAYERS A GAME IS PLAYED WITH (2026-11-03). PURE.
 *
 * The Vets play 7-a-side with 14 places and happily play one down (6 v 7).
 * With 13 confirmed the day before, MatchTime told their organiser the
 * match was "in trouble" and offered to cancel it, because the only
 * minimum it knew was two full sides.
 *
 * The setting lives on the weekly game (`Activity.minPlayers`), not the
 * club: the places come from the game's format (`playersPerTeam * 2`), so
 * a club with a 5-a-side and a 7-a-side game needs a minimum for each.
 * Null keeps today's behaviour exactly, so no other club changes.
 *
 * It decides only when MatchTime calls the numbers short. The places stay
 * the format's: a place open for a pay-as-you-go player still counts
 * against `maxPlayers`, and the week post still says "1 place open".
 */

export interface GameFormat {
  /** The organiser's own minimum, or null for two full sides. */
  minPlayers: number | null;
  playersPerTeam: number;
}

/** The fewest players one format is played with. */
export function formatMinimum(f: GameFormat): number {
  return f.minPlayers ?? f.playersPerTeam * 2;
}

/**
 * The 18:00 "Match in trouble" line: the fewest players the club can play
 * this game with, in any of its formats of the same sport (a 7-a-side
 * that is short can still switch to the club's 5-a-side). With no minimum
 * set anywhere this is two full sides of the smallest format, as before.
 */
export function minimumToPlay(own: GameFormat, sameSport: GameFormat[]): number {
  return Math.min(formatMinimum(own), ...sameSport.map(formatMinimum));
}

/**
 * The 10:00 "Low numbers" switch offer fires below this: the places when
 * no minimum is set (as before), the organiser's minimum when it is.
 */
export function lowNumbersBelow(g: { minPlayers: number | null; maxPlayers: number }): number {
  return Math.min(g.maxPlayers, g.minPlayers ?? g.maxPlayers);
}

/** What one of the activities page's player boxes sent (2026-11-03: the
 *  fewest and the most): "" is none (the game's own places), a whole
 *  number is that number, anything else is refused before saving. The
 *  range itself is checked by `checkPlayerRange` (flex-format-rules.ts). */
export function parsePlayersInput(text: string): { ok: true; value: number | null } | { ok: false } {
  const v = text.trim();
  if (v === "") return { ok: true, value: null };
  if (!/^\d{1,3}$/.test(v)) return { ok: false };
  return { ok: true, value: Number(v) };
}
