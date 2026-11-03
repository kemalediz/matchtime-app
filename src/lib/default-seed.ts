/**
 * THE DEFAULT SEED: what a player is assumed to be when no admin has
 * given him a seed at this club. Pure, no Prisma, safe in client code.
 *
 * Kemal, 2026-11-02: a seed defaults to 6 out of 10, "so it gives the
 * admins a measurement for medium kind of players". The admin seed
 * boxes show 6 for an unseeded player so the admin moves him up or down
 * from a known middle, and the balancer uses the same 6, so what the
 * admin sees is what picks the teams.
 *
 * `Membership.seedRating` stays NULL for "not set by an admin". Nothing
 * writes 6 into the column on anybody's behalf: an untouched box saves
 * nothing (`isUnchangedSeed`), and null and 6 are read identically
 * everywhere, so a bulk write would add no information and would erase
 * the one fact the column holds that 6 does not, that nobody set it.
 * The seed nudge (`seed-nudge.ts`) still counts who an admin actually
 * seeded, which only null can tell it.
 *
 * Since 2026-11-03 one thing other than an admin does write a seed: a
 * player joining a club with ratings at his other clubs starts at his
 * average there (`carried-seed.ts`). The nudge counts him as seeded,
 * which is right: the balancer has real evidence for him.
 *
 * Before this the prior for an unseeded player was this club's mean
 * peer rating, else 5.0 (`player-rating.ts`). Both are gone: the club
 * mean disagreed with the 6 the admin is now shown, and 5.0 was the
 * old guess for the same thing this constant now names.
 */

export const DEFAULT_SEED_RATING = 6;

/** The seed a number is needed for: the admin's, else the default. */
export function effectiveSeed(seed: number | null | undefined): number {
  return seed ?? DEFAULT_SEED_RATING;
}

/** What an admin seed box shows: whole numbers, 6 when unset. */
export function seedBoxValue(seed: number | null | undefined): string {
  return String(Math.round(effectiveSeed(seed)));
}

/**
 * True when what an admin left in a seed box is what was already
 * there, so nothing should be written. For an unseeded player that is
 * the prefilled 6: tabbing through the box must not turn "not set"
 * into a stored 6.
 */
export function isUnchangedSeed(value: number, stored: number | null | undefined): boolean {
  return stored == null ? value === DEFAULT_SEED_RATING : value === stored;
}
