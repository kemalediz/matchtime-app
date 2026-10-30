/**
 * COLD self-attendance in a 1-1 DM (2026-08-31; model only since
 * 2026-10-30).
 *
 * WHY THIS EXISTS
 * ---------------
 * The recruit blast DMs a player about the next match. Plenty of players
 * (especially the older, less technical half of a club) reply "IN" to the
 * DM and consider themselves signed up. Until this existed, that reply
 * matched no pending prompt in /api/whatsapp/dm-reply (tentative
 * follow-up, roster survey, bench offer, collector fee) so it was silently
 * dropped: the player believed they had a spot and nothing was recorded.
 *
 * INTERACTION CONTRACT
 * --------------------
 * A DM to MatchTime is inherently directed at the bot, so no "@Match Time"
 * tag is required. This module handles the sender's OWN in or out, never
 * a third party's.
 *
 * THE MODEL READS IT, NOTHING ELSE DOES (2026-10-30)
 * --------------------------------------------------
 * Kemal: "I don't want any string parsing at all." There used to be a
 * whole-message regex fast path in front of the model ("IN", "count me
 * in", "varım", "gelemiyorum") and a hypothetical or past-tense regex
 * seatbelt (`looksLikeHypotheticalOrPast`, interaction-contract.ts). Both
 * are deleted. `classifyMatchAvailability` reads the reply against what
 * MatchTime last said to the player and the match it is about, and its
 * prompt already makes a past or hypothetical game, a maybe, a question
 * and somebody else's attendance "unclear". "unclear", a failed call and a
 * call refused at the daily AI cap all mean DO NOTHING, never a guess.
 */
import {
  classifyMatchAvailability,
  type MatchAvailabilityContext,
} from "./match-availability-classifier";

export type DmSelfAttendance = "in" | "out";

export interface DmSelfAttendanceResolution {
  /** What to write, or null to leave the DM to the existing handling. */
  decision: DmSelfAttendance | null;
  /** Which layer decided. Surfaced in the API response for observability. */
  via: "llm" | "pending-prompt" | "none";
  confidence?: number;
  reasoning?: string;
}

export interface ResolveDmSelfAttendanceInput {
  /** The raw DM body. */
  text: string;
  /**
   * Does a MORE SPECIFIC pending prompt own this DM (an open tentative
   * follow-up, bench offer, collector-fee request or roster survey)? Those
   * paths run first in the route and must keep winning: they know which
   * match or question the answer belongs to, and this fallback does not.
   */
  hasPendingPrompt: boolean;
  /** Context handed to the model (club, player, kick-off, what MatchTime said). */
  context?: MatchAvailabilityContext;
}

/**
 * The decision: a pending prompt wins, otherwise the model reads it.
 *
 * The model is only consulted when the caller has already established
 * there IS something to register against (an active match on an
 * attendance-tracking org), so an idle club never burns tokens on chat.
 */
export async function resolveDmSelfAttendance(
  input: ResolveDmSelfAttendanceInput,
): Promise<DmSelfAttendanceResolution> {
  if (input.hasPendingPrompt) return { decision: null, via: "pending-prompt" };
  const raw = (input.text ?? "").trim();
  if (!raw) return { decision: null, via: "none" };

  const verdict = await classifyMatchAvailability(raw, input.context ?? {});
  return {
    decision: verdict.decision === "unclear" ? null : verdict.decision,
    via: "llm",
    confidence: verdict.confidence,
    reasoning: verdict.reasoning,
  };
}
