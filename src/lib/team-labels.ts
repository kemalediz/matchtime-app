/**
 * Single source of truth for the two team DISPLAY labels.
 *
 * The internal team identity is always the `Team` enum (RED | YELLOW)
 * — TeamAssignment rows, Elo, score columns (redScore/yellowScore) and
 * the LLM verdict fields (scoreRed/scoreYellow, teamOverrides) all key
 * off the enum and are untouched by custom names. Only what we *call*
 * the teams in user-facing output changes.
 *
 * Resolution order, per slot (index 0 = RED, index 1 = YELLOW):
 *   1. Match.teamLabels         — per-match override (MatchTime-invented fun
 *                                 names for THIS week, set when an admin asks
 *                                 the bot to pick the names)
 *   2. Organisation.teamLabels  — org-admin override (/admin/settings)
 *   3. Sport.teamLabels         — sport preset ("Home"/"Away", …)
 *   4. "Red" / "Yellow"         — hard default
 *
 * Per-slot fallback means an admin can rename just one team and the
 * other keeps its sport default. The match override likewise falls
 * through per-slot: a match labels array of `["Lions", ""]` keeps the
 * RED slot as "Lions" and resolves the YELLOW slot from org/sport/default.
 */

export const DEFAULT_TEAM_LABELS: readonly [string, string] = ["Red", "Yellow"];

type LabelSource = { teamLabels?: string[] | null } | null | undefined;

/** Resolve the two display labels. Returns `[redLabel, yellowLabel]`. */
export function resolveTeamLabels(
  match: LabelSource,
  org: LabelSource,
  sport: LabelSource,
): [string, string] {
  const m = match?.teamLabels ?? [];
  const o = org?.teamLabels ?? [];
  const s = sport?.teamLabels ?? [];
  const red = m[0]?.trim() || o[0]?.trim() || s[0]?.trim() || DEFAULT_TEAM_LABELS[0];
  const yellow = m[1]?.trim() || o[1]?.trim() || s[1]?.trim() || DEFAULT_TEAM_LABELS[1];
  return [red, yellow];
}
