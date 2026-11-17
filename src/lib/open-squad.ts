/**
 * OPEN SQUAD (2026-11-17, `Organisation.openSquad`). PURE: no database, no
 * clock.
 *
 * The Vets' owner: "the main squad will always expand or shrink without
 * any limits and a bench, as the pitch is quite big to allow anyone", and
 * then "no 7, 8, 9 or 10-a-side, just a simple main squad list" with a
 * minimum of 12 (below it there is no game) and no maximum.
 *
 * With the setting on:
 *   - every IN is in, whatever the count: never the bench, never "full"
 *     (`canTakeFreePlace`, squad-capacity.ts, the one rule the engine's
 *     react and `registerAttendance` share);
 *   - there is no format: a game's name loses its size
 *     (`matchFormatTitle`, match-format-title.ts), nothing suggests or
 *     switches a size, and the teams are whoever is in, split into two
 *     even sides (`openSquadPerTeam`);
 *   - the only number is the game's minimum (`openSquadMinimum`), and
 *     everything that asks for players (the 17:00 post, the chases, the
 *     partner and pool asks, the recruit blast) asks only for the players
 *     short of it (`placesToFill`).
 *
 * The places (`Match.maxPlayers`, `Activity.maxPlayers`) are never written
 * by this setting. They are simply not read as a cap while it is on, so
 * switching it off falls back to the activity's own format, and every
 * player already in stays in (nothing bumps anyone).
 */

/** Anything but `true` is off: a missing column reads as today's rule. */
export function normaliseOpenSquad(raw: unknown): boolean {
  return raw === true;
}

/**
 * The fewest players the game is played with: the organiser's minimum
 * (`Activity.minPlayers`), else two full sides of the sport's format, and
 * never fewer than two.
 */
export function openSquadMinimum(g: { minPlayers: number | null | undefined; playersPerTeam: number }): number {
  const min = typeof g.minPlayers === "number" && Number.isInteger(g.minPlayers) ? g.minPlayers : g.playersPerTeam * 2;
  return Math.max(2, min);
}

/** How many more are needed to reach the minimum; 0 at or above it. */
export function shortOfMinimum(confirmed: number, minimum: number): number {
  return Math.max(0, minimum - confirmed);
}

/**
 * What an ask or a chase may ask for. An open squad: the players short of
 * the minimum (nothing at or above it, so nothing is chased). Otherwise
 * the places still open, as always.
 */
export function placesToFill(p: { openSquad: boolean; confirmed: number; maxPlayers: number; minimum: number }): number {
  return p.openSquad ? shortOfMinimum(p.confirmed, p.minimum) : Math.max(0, p.maxPlayers - p.confirmed);
}

/**
 * The players a side for an open squad: whoever is in, split into two
 * even sides, the odd one on the first (15 is 8 v 7, 19 is 10 v 9).
 * Handed to the balancer as its `perTeam`, so it never leaves anyone out.
 */
export function openSquadPerTeam(count: number): number {
  return Math.max(1, Math.ceil(Math.max(0, count) / 2));
}
