/**
 * "PLAYERS NEAR YOU" FOR THE ORGANISER (slice L4, 2026-10-24). PURE.
 *
 * Before a club asks the pool it sees a band, never a list (plan section
 * 6): "none", "a few" or "5+". Never a name, number, area or exact count.
 * This module takes a count (or a list it only measures) and returns one
 * of three strings; it imports nothing and builds no object, so nothing
 * about a person can travel through it (privacy test in
 * `__tests__/near-band.test.ts`). The words shown are the caller's i18n
 * strings, keyed by the band.
 *
 * The count is the loader's: pool players who pass every filter and cap
 * for that match right now (`candidates.ts` `poolNearBand`).
 */

export const POOL_NEAR_BANDS = ["none", "few", "5+"] as const;
export type PoolNearBand = (typeof POOL_NEAR_BANDS)[number];

/** From this many on, the band is "5+". */
export const NEAR_BAND_MANY = 5;

export function nearBand(count: number): PoolNearBand {
  if (!Number.isFinite(count) || count <= 0) return "none";
  return count >= NEAR_BAND_MANY ? "5+" : "few";
}

/** The band for a list, measured by its length alone. */
export function nearBandOf(list: readonly unknown[]): PoolNearBand {
  return nearBand(list.length);
}
