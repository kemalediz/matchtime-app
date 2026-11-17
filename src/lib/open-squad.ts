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
 * How many regulars a month's list may hold (monthly squad): two full
 * sides of the format, or no cap at all for an open squad, whose main
 * squad "expands or shrinks without any limits". Infinity, never a big
 * number written anywhere: it only bounds a count in memory.
 */
export function monthRegularCap(playersPerTeam: number, openSquad: boolean | null | undefined): number {
  return openSquad === true ? Number.POSITIVE_INFINITY : playersPerTeam * 2;
}

/**
 * A month's sign-up cap (review of #623). No squad limit: none. Switched
 * off part-way through the month (`SquadMonth.regularCapFloor`): the
 * format's places or the regulars already signed, whichever is more, so
 * nobody already on the list is put waiting. Otherwise the format's places.
 */
export function monthSignupCap(p: { playersPerTeam: number; openSquad: boolean | null | undefined; capFloor: number | null | undefined }): number {
  if (p.openSquad === true) return Number.POSITIVE_INFINITY;
  return Math.max(p.playersPerTeam * 2, p.capFloor ?? 0);
}

/**
 * The week's seed cap for a monthly club (review of #623). No squad limit:
 * none. Switched off part-way through the month: the match's places, or
 * the regulars signed plus anyone else already in (a pay-as-you-go player),
 * whichever is more, so the seed bumps nobody and benches no regular.
 * Otherwise the match's places, as always.
 */
export function monthSeedCap(p: { openSquad: boolean | null | undefined; places: number; capFloor: number | null | undefined; othersIn: number }): number {
  if (p.openSquad === true) return Number.POSITIVE_INFINITY;
  return p.capFloor == null ? p.places : Math.max(p.places, p.capFloor + p.othersIn);
}

/**
 * The players a side for an open squad: whoever is in, split into two
 * even sides, the odd one on the first (15 is 8 v 7, 19 is 10 v 9).
 * Handed to the balancer as its `perTeam`, so it never leaves anyone out.
 */
export function openSquadPerTeam(count: number): number {
  return Math.max(1, Math.ceil(Math.max(0, count) / 2));
}
