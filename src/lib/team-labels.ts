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
 *   1. Organisation.teamLabels  — org-admin override (/admin/settings)
 *   2. Sport.teamLabels         — sport preset ("Home"/"Away", …)
 *   3. "Red" / "Yellow"         — hard default
 *
 * Per-slot fallback means an admin can rename just one team and the
 * other keeps its sport default.
 */

export const DEFAULT_TEAM_LABELS: readonly [string, string] = ["Red", "Yellow"];

type LabelSource = { teamLabels?: string[] | null } | null | undefined;

/** Resolve the two display labels. Returns `[redLabel, yellowLabel]`. */
export function resolveTeamLabels(
  org: LabelSource,
  sport: LabelSource,
): [string, string] {
  const o = org?.teamLabels ?? [];
  const s = sport?.teamLabels ?? [];
  const red = o[0]?.trim() || s[0]?.trim() || DEFAULT_TEAM_LABELS[0];
  const yellow = o[1]?.trim() || s[1]?.trim() || DEFAULT_TEAM_LABELS[1];
  return [red, yellow];
}
