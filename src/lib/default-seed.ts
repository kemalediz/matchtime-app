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

/**
 * What an admin seed box shows: the seed as it is, 6 when unset.
 *
 * Seeds are never rounded (Kemal, 2026-11-09: "keep the ratings as they
 * are, never round them"). A carried seed is stored at full precision
 * (6.41666666666667), so the box shows it to two places ("6.42") to fit;
 * that is display only. What is stored, and what the balancer uses, is
 * the full value, and `isUnchangedSeed` makes sure leaving the box as it
 * shows never writes the shorter number back.
 */
export function seedBoxValue(seed: number | null | undefined): string {
  return String(Math.round(effectiveSeed(seed) * 100) / 100);
}

/** The seed range every box and the server action accept. */
const SEED_BOX_MIN = 1;
const SEED_BOX_MAX = 10;

/**
 * What an admin typed in a seed box, exactly as typed: whole numbers and
 * decimals both work ("7", "6.5", "6,5"), and nothing is rounded. Null for
 * an empty box, not a number, or anything outside 1 to 10, so nothing is
 * saved.
 */
export function parseSeedBox(raw: string): number | null {
  const s = raw.trim().replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < SEED_BOX_MIN || n > SEED_BOX_MAX) return null;
  return n;
}

/**
 * True when what an admin left in a seed box is what the box showed for
 * the stored seed, so nothing should be written. For an unseeded player
 * that is the prefilled 6: tabbing through the box must not turn "not
 * set" into a stored 6. For a decimal seed it is the box's two places:
 * leaving "6.42" on a stored 6.41666 must not cut it to 6.42.
 */
export function isUnchangedSeed(value: number, stored: number | null | undefined): boolean {
  return value === Number(seedBoxValue(stored));
}

/**
 * The seed a form holds once its box is edited (`SeedInput`: onboarding,
 * finish setup), from what is in the box and the seed it held. Emptied:
 * unset. Outside 1 to 10: held at the nearest end. Typed back to what the
 * box showed: the seed it showed, so an unset 6 stays unset and a 6.41666
 * is not cut to 6.42. Anything else: exactly what was typed.
 */
export function seedFromBoxEdit(raw: string, current: number | null | undefined): number | null {
  const s = raw.trim().replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.min(SEED_BOX_MAX, Math.max(SEED_BOX_MIN, n));
  return isUnchangedSeed(clamped, current) ? (current ?? null) : clamped;
}
