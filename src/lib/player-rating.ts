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
 * ── TWO NUMBERS SINCE 2026-09-19, AND WHY ────────────────────────────
 *
 * `computeClubRating` above is the BALANCER's number. It is not the
 * number a player is shown. `clubDisplayRating`, at the foot of this
 * file, is: the raw mean of the ratings this club actually gave them,
 * with no prior and no shrinking.
 *
 * Kemal answered the design's open question 2 that way round:
 *
 *   "i think the latter is a better one as whatever ratings are given
 *    the player should see but yeah for team setup shrunk number should
 *    be used initially"
 *
 * They answer two different questions. "What did people give me" is the
 * player's question and it has a factual answer, so shrinking it was
 * answering a question nobody asked. "How confident is MatchTime in
 * that yet" is team generation's question, and at one or two ratings
 * the honest answer is "not very", which is what the prior encodes.
 * A single 9 is the player's 9 on his own page and is worth about 7.3
 * to the draft, and both of those statements are true at once.
 *
 * Nothing about the arithmetic above changed when this was decided.
 * `clubDisplayRating` was ADDED beside it.
 *
 * Used by:
 *   - team-generation.ts (`computeClubRating`, the balancer input)
 *   - player-stats.ts `loadClubRating`, which returns BOTH and is what
 *     every player-visible tile reads (dashboard, /profile/stats)
 *
 * There is no global counterpart any more. `computePlayerRating`, the
 * deprecated shim slice 2 left behind so the surfaces slice 6 owned
 * kept compiling, was deleted on 2026-09-19 once the dashboard tile
 * became club-scoped. Nothing in the product can now ask for a rating
 * without naming the club it is asking about.
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
 * THE NUMBER A HUMAN IS SHOWN. The raw mean of the ratings this club
 * gave this player, and nothing else.
 *
 * ── WHAT IT DELIBERATELY DOES NOT TAKE ───────────────────────────────
 *
 * There is no `clubMeanRating` parameter. That is the point, and it is
 * the same trick `computeClubRating` uses to make another club's number
 * unrepresentable: a display figure cannot be shrunk toward anything if
 * the thing it would shrink toward cannot be passed in.
 * `__tests__/club-rating-shown-vs-balanced.test.ts` asserts it by type.
 *
 * ── NO RATINGS MEANS NO NUMBER, SEEDED OR NOT ────────────────────────
 *
 * With no peer ratings at all there is no mean to take, and the answer
 * is null whatever the club's seed says. Kemal, 2026-09-19:
 *
 *   "i prefer them to see nothing, better not to show seed, the ratings
 *    are important to the player, not the seed and it can be
 *    discouraging too."
 *
 * Slice 6 shipped it the other way, showing a seeded player their seed
 * on the grounds that it is the club's own stated opinion. It is, but
 * it is an admin's guess typed before anybody had played, and under the
 * heading "your rating" a player reads it as what their team-mates
 * think of them. When the guess is low that is discouraging, and it is
 * discouraging about something nobody actually said.
 *
 * So the seeded-but-unrated player and the never-mentioned player are
 * ONE state on screen: the empty state, whose copy
 * (`rating_club_empty`) already says the true thing, that team-mates
 * set this after the first game. `clubSeedRating` survives in the
 * signature only to be refused, which is deliberate: a caller that
 * holds a seed can still hand it over and still get null, so nobody has
 * to route around this function to do the right thing.
 *
 * The BALANCER is untouched. `computeClubRating` above still takes the
 * seed and still leans on it with no peer ratings present, because a
 * seed is exactly how a new club gets sensible teams in week one. The
 * two functions now disagree by the whole seed for these players, and
 * that is the decision:
 *
 *   shown     nothing, until a team-mate says something
 *   balanced  the seed, from the moment an admin types it
 *
 * Clamped to [1, 10] like the balancer. Peer scores are 1 to 10 by the
 * schema so the clamp never bites on a mean, and it is kept as the
 * cheap guard against a future caller passing something else.
 */
export function clubDisplayRating(args: {
  /** `Membership.seedRating` for THIS club. Null when unseeded. Read
   *  only to be ignored: see the header. */
  clubSeedRating: number | null;
  /** `Rating.score` rows from THIS club only, newest first, capped at 60. */
  clubPeerRatings: number[];
}): number | null {
  const { clubPeerRatings } = args;
  if (clubPeerRatings.length === 0) return null;
  const mean = clubPeerRatings.reduce((s, r) => s + r, 0) / clubPeerRatings.length;
  return Math.max(1, Math.min(10, mean));
}
