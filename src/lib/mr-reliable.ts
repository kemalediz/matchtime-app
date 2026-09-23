/**
 * THE MR RELIABLE BADGE RULE: pure, and in exactly one place.
 *
 * The badge on `/profile/stats` ("Consistently strong ratings") and the
 * group's answer to "who is the most Mr. Reliable?" (2026-09-23) must
 * never disagree, so both call `earnsMrReliable`: the page through
 * `loadPlayerSeasonStats`, the group through `loadMrReliableHolders`.
 * Its own module, with no imports, so the Prisma-free composer can print
 * the thresholds without pulling a database client in behind them.
 *
 * The thresholds are the ones the badge has always used, moved here
 * unchanged from the badge list in `player-stats.ts`.
 */
export const MR_RELIABLE_MIN_AVG = 6.5;
export const MR_RELIABLE_MIN_GAMES = 4;
/** The spread (population standard deviation of the per-match averages)
 *  must be BELOW this. */
export const MR_RELIABLE_MAX_SPREAD = 1;

/** Population standard deviation, or null under two values: the same
 *  `stddev` the badge has always used. */
export function ratingSpread(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

/**
 * `perGameAverages`: the player's average rating in each match they were
 * rated in. `avgRating`: the mean of every individual rating they
 * received (NOT the mean of the per-match averages), as the page shows.
 */
export function earnsMrReliable(args: { perGameAverages: number[]; avgRating: number | null }): boolean {
  const sd = ratingSpread(args.perGameAverages);
  return (
    sd !== null &&
    sd < MR_RELIABLE_MAX_SPREAD &&
    (args.avgRating ?? 0) >= MR_RELIABLE_MIN_AVG &&
    args.perGameAverages.length >= MR_RELIABLE_MIN_GAMES
  );
}
