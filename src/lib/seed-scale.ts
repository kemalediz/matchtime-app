/**
 * Convert the onboarding analyser's player rating into a User.seedRating.
 *
 * The analyser emits a 1–10 rating (see onboarding-analyzer.ts SYSTEM_PROMPT)
 * and User.seedRating lives on the EXACT SAME 1–10 band — there is no
 * separate internal scale. player-rating.ts clamps blended ratings to
 * [1, 10] ("Clamp to [1, 10] just in case anyone seeds outside the band"),
 * so the only work here is to mirror that clamp and reject anything that
 * isn't a finite number.
 */

/**
 * Returns a finite 1–10 seed rating, or null when the input is
 * null / undefined / NaN / non-finite.
 */
export function seedFromAnalyzerRating(
  rating: number | null | undefined,
): number | null {
  if (rating == null) return null;
  if (typeof rating !== "number" || !Number.isFinite(rating)) return null;
  // Same band as player-rating.ts's blended-rating clamp.
  return Math.max(1, Math.min(10, rating));
}
