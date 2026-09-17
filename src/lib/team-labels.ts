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
 *   4. the language's default   — "Red" / "Yellow" for English,
 *                                 "Kırmızı" / "Sarı" for Turkish
 *
 * Per-slot fallback means an admin can rename just one team and the
 * other keeps its sport default. The match override likewise falls
 * through per-slot: a match labels array of `["Lions", ""]` keeps the
 * RED slot as "Lions" and resolves the YELLOW slot from org/sport/default.
 *
 * THE LANGUAGE (2026-09-17, Phase 2 of the multi-language design). The
 * sport preset library (`sport-presets.ts`) is English and copies "Red"
 * / "Yellow" into every new org's football sports, so a Turkish org
 * whose sport carries exactly the English hard default did not choose
 * those words: for a non-English language that sport-level label is
 * treated as unset and the language's default applies. An org-level or
 * match-level label is always respected, whatever it says, because an
 * admin typed it. English resolution is unchanged by construction: its
 * default IS the hard default, so the check is a no-op.
 */
import { normaliseLang, type Lang } from "./i18n/lang";

export const DEFAULT_TEAM_LABELS: readonly [string, string] = ["Red", "Yellow"];

export const DEFAULT_TEAM_LABELS_BY_LANG: Record<Lang, readonly [string, string]> = {
  en: DEFAULT_TEAM_LABELS,
  tr: ["Kırmızı", "Sarı"],
};

type LabelSource = { teamLabels?: string[] | null } | null | undefined;

/** Is this sport-level label the English preset default for its slot?
 *  Case- and whitespace-insensitive; the preset library is ASCII. */
function isEnglishDefault(label: string | undefined, slot: 0 | 1): boolean {
  return (label ?? "").trim().toLowerCase() === DEFAULT_TEAM_LABELS[slot].toLowerCase();
}

/** Resolve the two display labels. Returns `[redLabel, yellowLabel]`. */
export function resolveTeamLabels(
  match: LabelSource,
  org: LabelSource,
  sport: LabelSource,
  lang: Lang | string | null | undefined = "en",
): [string, string] {
  const l = normaliseLang(lang);
  const fallback = DEFAULT_TEAM_LABELS_BY_LANG[l];
  const m = match?.teamLabels ?? [];
  const o = org?.teamLabels ?? [];
  const s = sport?.teamLabels ?? [];
  const sportLabel = (slot: 0 | 1): string =>
    l !== "en" && isEnglishDefault(s[slot], slot) ? "" : (s[slot]?.trim() ?? "");
  const red = m[0]?.trim() || o[0]?.trim() || sportLabel(0) || fallback[0];
  const yellow = m[1]?.trim() || o[1]?.trim() || sportLabel(1) || fallback[1];
  return [red, yellow];
}
