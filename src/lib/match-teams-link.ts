/**
 * Which teams link an organiser sees on the match page (Kemal, 2026-11-09).
 *
 * Pure, so the rule is tested without rendering the page.
 *
 *   generate  UPCOMING and past the attendance deadline
 *   manage    TEAMS_GENERATED or TEAMS_PUBLISHED; or COMPLETED with teams
 *   null      anything else, and always for CANCELLED
 *
 * A match goes COMPLETED at kickoff (`match-completion.ts`). Until
 * 2026-11-09 the link then disappeared, and Kemal could not reach the
 * teams page to put Luca in for CJ on the Bibs after kickoff. The teams
 * page and its actions (`actions/teams.ts`) work on a COMPLETED match.
 */
export type TeamsLinkMatch = {
  status: string;
  isPastDeadline: boolean;
  hasTeams: boolean;
};

export function teamsLinkAction(m: TeamsLinkMatch): "generate" | "manage" | null {
  switch (m.status) {
    case "UPCOMING":
      return m.isPastDeadline ? "generate" : null;
    case "TEAMS_GENERATED":
    case "TEAMS_PUBLISHED":
      return "manage";
    case "COMPLETED":
      return m.hasTeams ? "manage" : null;
    default:
      return null;
  }
}
