/**
 * Shared player-rating computation. Blends seed + peer ratings via a
 * Bayesian "prior + observations" approach so ratings move smoothly
 * from the moment the first peer rating arrives instead of jumping
 * at an arbitrary threshold.
 *
 *   blended = (sumPeer + seed × PRIOR_WEIGHT) / (peerCount + PRIOR_WEIGHT)
 *
 * With PRIOR_WEIGHT = 3, the seed acts as 3 phantom ratings. So:
 *   - 0 peer ratings: pure seed (or default if seed unset)
 *   - 1  peer rating: peer 25%, seed 75%
 *   - 3  peer ratings: 50/50
 *   - 10 peer ratings: peer ~77%
 *   - 60 peer ratings: peer ~95%
 *
 * Used by:
 *   - team-generation.ts (balancer input). Since 2026-09-15 that is the
 *     route BOTH human-triggered paths take, so this is the formula
 *     that picks teams whether the request arrives from WhatsApp or
 *     from the admin dashboard's Generate button. The dashboard's own
 *     rival formula, which blended the Elo `matchRating` in, was
 *     deleted; `app/actions/teams.ts` carries the tombstone.
 *
 *     It is NOT the only route into the balancer yet.
 *     `app/api/cron/generate-teams/route.ts:57-92` computes its own
 *     rating inline (mean of the last 60 peer scores once there are at
 *     least 3, otherwise the seed), calls `balanceTeams` directly and
 *     writes the sheet itself, on a live `0 12 * * *` schedule. Slice 3
 *     of `MDs/club-scoped-ratings-design-2026-09-18.md` removes it.
 *   - dashboard rating tile
 *   - player profile pages (any future "show my rating" surface)
 *
 * The Elo `matchRating` is NOT an input here and is not meant to be.
 * It is a leaderboard number: see the header of `lib/elo.ts`.
 */

const PRIOR_WEIGHT = 3;
const DEFAULT_SEED = 5;

export function computePlayerRating(args: {
  seedRating: number | null;
  peerRatings: number[];
}): {
  rating: number;
  source: "peer" | "blended" | "seed";
  peerCount: number;
} {
  const seed = args.seedRating ?? DEFAULT_SEED;
  const peerCount = args.peerRatings.length;
  const sumPeer = args.peerRatings.reduce((s, r) => s + r, 0);
  const blended = (sumPeer + seed * PRIOR_WEIGHT) / (peerCount + PRIOR_WEIGHT);
  // Clamp to [1, 10] just in case anyone seeds outside the band.
  const rating = Math.max(1, Math.min(10, blended));
  // "source" is for UI hints — peer/blended/seed labels what dominated.
  // Threshold: at PRIOR_WEIGHT=3, peer count >> 3 means peer dominates.
  let source: "peer" | "blended" | "seed";
  if (peerCount === 0) source = "seed";
  else if (peerCount >= PRIOR_WEIGHT * 3) source = "peer";
  else source = "blended";
  return { rating, source, peerCount };
}
