/**
 * THE RE-COMPUTATION OF SEEDS CARRIED BEFORE 2026-11-09. Pure, no Prisma.
 *
 * Until Kemal's "keep the ratings as they are, never round them"
 * (2026-11-09) a carried seed (`carried-seed.ts`) was stored rounded to a
 * whole number. The one-off script `scripts/_tmp-recompute-carried-seeds.ts`
 * recomputes those seeds unrounded; this decides, per membership, whether
 * it may.
 */

/**
 * What the re-computation of a seed carried before 2026-11-09 does with
 * one membership (`scripts/_tmp-recompute-carried-seeds.ts`). Those seeds
 * were stored rounded to a whole number. `exact` is the carried value
 * recomputed as of the moment it was written, unrounded, or null when
 * there was nothing to carry then.
 *
 * Replaced only when the stored seed is still exactly that value rounded:
 * a decimal, or any other whole number, is an admin's own seed (or was
 * set by hand) and is never touched.
 */
export type CarriedSeedRecompute =
  | { action: "recompute"; from: number; to: number }
  | { action: "skip"; reason: "no-seed" | "already-exact" | "no-carry" | "differs" };

export function classifyCarriedSeedRecompute(stored: number | null, exact: number | null): CarriedSeedRecompute {
  if (stored == null) return { action: "skip", reason: "no-seed" };
  if (!Number.isInteger(stored)) return { action: "skip", reason: "already-exact" };
  if (exact == null) return { action: "skip", reason: "no-carry" };
  if (exact === stored) return { action: "skip", reason: "already-exact" };
  // The old rule's own rounding, to recognise what it wrote. Nothing is
  // stored rounded here: `to` is the exact value.
  if (Math.round(exact) !== stored) return { action: "skip", reason: "differs" };
  return { action: "recompute", from: stored, to: exact };
}
