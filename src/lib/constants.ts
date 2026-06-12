export const DAYS_OF_WEEK = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * Render hints for the two team slots. The *labels* are resolved via
 * `resolveTeamLabels()` in src/lib/team-labels.ts (org override →
 * `sport.teamLabels` → "Red"/"Yellow"), so "Red"/"Yellow" in football
 * becomes "Home"/"Away" in basketball or whatever the org admin set —
 * but the colour palette stays in these two slots because we only
 * support 2-team play for now.
 */
export const TEAM_COLORS: Record<"RED" | "YELLOW", { bg: string; text: string; dot: string }> = {
  RED: { bg: "bg-red-500", text: "text-white", dot: "bg-red-500" },
  YELLOW: { bg: "bg-amber-400", text: "text-slate-900", dot: "bg-amber-400" },
};
