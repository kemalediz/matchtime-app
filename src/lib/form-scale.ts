/**
 * THE FORM SCALE, DEFINED ONCE (2026-11-10).
 *
 * How much a player's rating moves for ONE match, and what each size
 * means. Two prompts read it, word for word:
 *   - the rating adjuster (`rating-adjuster.ts`), which reads the week's
 *     chat when the teams are made;
 *   - the teams extractor's `form` action (`pipeline/extractors.ts`), which
 *     decides the amount the moment a player tells MatchTime, so MatchTime
 *     can say it (Kemal: "tell explicitly how much rating adjustment it
 *     made, so if I don't like it, I can get it amended").
 * One scale, so the amount MatchTime states for a note is the amount the
 * adjuster would have made of the same words. Code clamps every amount to
 * plus or minus MAX_DELTA, whatever a model or a person says.
 *
 * Pure: no imports, so a prompt module can read it without loading anything.
 */

/** The most a rating moves for one match, either way (Kemal, 2026-11-10:
 *  2 was harsh on a 1 to 10 scale). */
export const MAX_DELTA = 1;

/** What counts and what it is worth: the sizes, one line each. The
 *  adjuster's prompt has carried these words since 2026-11-10. */
export const FORM_SIZES = [
  "- Tired, hungover or a bit rusty for the match: about -0.5.",
  "- Ill or injured for the match, or back after weeks without playing: about -1.",
  "- A standout run just before this match (goals, Man of the Match, team-mates saying they were the best player): +0.5, or +1 if it was clearly exceptional.",
].join("\n");
