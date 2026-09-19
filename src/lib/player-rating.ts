/**
 * THE CLUB RATING. One player, one rating per club.
 *
 * A player's rating is derived from a prior and their own peer scores,
 * blended the Bayesian "prior + observations" way so the number moves
 * smoothly from the first peer rating instead of jumping at an
 * arbitrary threshold.
 *
 *   blended = (sumClubPeer + prior x PRIOR_WEIGHT) / (clubPeerCount + PRIOR_WEIGHT)
 *
 * With PRIOR_WEIGHT = 3 the prior acts as 3 phantom ratings:
 *   - 0 peer ratings: the prior exactly
 *   - 1  peer rating: peer 25%, prior 75%
 *   - 3  peer ratings: 50/50
 *   - 10 peer ratings: peer ~77%
 *   - 60 peer ratings: peer ~95%
 *
 * ── WHAT CHANGED ON 2026-09-19, AND WHY ──────────────────────────────
 *
 * Every input is now scoped to ONE club. Until today the shape above
 * was fed a global seed (`User.seedRating`) and this player's 60 most
 * recent ratings FROM ANYWHERE, so Sutton FC's Tuesday team sheet was
 * partly picked by Sutton Lads, a club that removed MatchTime in June
 * 2026 and whose numbers can therefore never correct themselves. Nine
 * of Sutton FC's 43 rated members carried a wrong number into the
 * draft; the worst, Amir, rated 6.424 where his own club's ratings say
 * 7.037, which is thirtieth in the draft against a true thirteenth.
 * Measured read-only against production, section 3.5 of
 * `MDs/club-scoped-ratings-design-2026-09-18.md`.
 *
 * So `computeClubRating` takes three club-scoped inputs and nothing
 * else. There is deliberately no parameter through which another club's
 * number could arrive, which is the property the whole design turns on
 * and which `__tests__/club-rating-isolation.test.ts` pins end to end.
 *
 * ── THE PRIOR, WHEN THERE IS NO SEED ─────────────────────────────────
 *
 *   prior = Membership.seedRating for THIS club
 *           ?? the mean of every rating given in THIS club
 *           ?? 5.0
 *
 * The club mean replaced a hardcoded 5.0 because 5.0 is not neutral.
 * Sutton's own mean is 6.674, so an unseeded player entering at 5.0 was
 * not being called "unknown", he was being called the worst player on
 * the pitch, and the snake draft took that literally. Clubs rate on
 * their own scales and a fixed midpoint is a guess about all of them.
 *
 * The club mean is a FALLBACK, not the expected path: a new club's
 * admin is offered the seed editor at setup, so the normal case is that
 * the seed wins. The mean catches the member nobody seeded, the
 * mid-season joiner, the auto-provisioned unknown sender, the guest who
 * turned into a regular.
 *
 * The final 5.0 is the honest answer for a club with no seeds and no
 * ratings at all: every player gets the same number, the rating term is
 * constant, and the balancer falls through to position composition. It
 * is self-correcting after one match and one round of rating DMs.
 *
 * Used by:
 *   - team-generation.ts (balancer input)
 *   - dashboard rating tile, via the shim below until slice 6
 *   - player profile pages (any future "show my rating" surface)
 */

const PRIOR_WEIGHT = 3;
/** Only reached when a club has no seed for the player AND has never
 *  rated anybody. See the header. */
const NO_INFORMATION_PRIOR = 5;

export type ClubRatingSource = "peer" | "blended" | "seed" | "club-average";

export function computeClubRating(args: {
  /** `Membership.seedRating` for THIS club. Null when unseeded. */
  clubSeedRating: number | null;
  /** `Rating.score` rows from THIS club only, newest first, capped at 60. */
  clubPeerRatings: number[];
  /** Mean of every rating given in THIS club. Null when the club has none. */
  clubMeanRating: number | null;
}): {
  rating: number;
  source: ClubRatingSource;
  peerCount: number;
} {
  const prior = args.clubSeedRating ?? args.clubMeanRating ?? NO_INFORMATION_PRIOR;
  const peerCount = args.clubPeerRatings.length;
  const sumPeer = args.clubPeerRatings.reduce((s, r) => s + r, 0);
  const blended = (sumPeer + prior * PRIOR_WEIGHT) / (peerCount + PRIOR_WEIGHT);
  // Clamp to [1, 10] just in case anyone seeds outside the band.
  const rating = Math.max(1, Math.min(10, blended));
  // "source" is for UI hints. It labels what dominated, and the UI
  // needs "club-average" as its own value so an empty state can say
  // "this club's average, waiting for your first rating" rather than
  // presenting a club average as if it were the player's own number.
  // Threshold: at PRIOR_WEIGHT=3, peer count >> 3 means peer dominates.
  let source: ClubRatingSource;
  if (peerCount === 0) source = args.clubSeedRating === null ? "club-average" : "seed";
  else if (peerCount >= PRIOR_WEIGHT * 3) source = "peer";
  else source = "blended";
  return { rating, source, peerCount };
}

/**
 * @deprecated The GLOBAL rating. Kept only so the surfaces slice 6 owns
 * keep compiling while slice 2 lands, and removed by that slice.
 *
 * Do NOT add a caller. It cannot tell you which club it is answering
 * about, which is the bug the design is fixing; the dashboard tile in
 * `app/page.tsx` and the two read-only scripts are the last callers and
 * they are on slice 6's list. New code calls `computeClubRating`.
 *
 * Behaviour is unchanged from what this file shipped before 2026-09-19,
 * to the last bit, and `__tests__/club-rating.test.ts` asserts that a
 * single-club seeded player gets the identical number from both. That
 * matters: 34 of Sutton's 43 rated members must not move at all.
 */
export function computePlayerRating(args: {
  seedRating: number | null;
  peerRatings: number[];
}): {
  rating: number;
  source: "peer" | "blended" | "seed";
  peerCount: number;
} {
  const r = computeClubRating({
    clubSeedRating: args.seedRating,
    clubPeerRatings: args.peerRatings,
    // No club, so no club mean: the old hardcoded 5.0 is what the final
    // fallback gives, which is exactly what this function used to do.
    clubMeanRating: null,
  });
  return {
    rating: r.rating,
    // The old union had no "club-average". An unseeded player with no
    // ratings used to be labelled "seed" (on the default of 5.0), and
    // the tile that reads this still renders that wording.
    source: r.source === "club-average" ? "seed" : r.source,
    peerCount: r.peerCount,
  };
}
