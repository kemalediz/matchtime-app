/**
 * What someone who is not an organiser asked MatchTime for, so the line
 * that refuses them names it (2026-11-08, Monday night vets: a player's
 * "we need 2 players, ask our partner clubs and the player pool" got
 * "Only Davide can change that."). Always decided from what the code
 * already knows (the extractor's action, or the path itself), never from
 * the person's words. Pure: no database, no model.
 */

/** The closed set of things the organisers-only line can name. "settings"
 *  is a change to how the club runs (the pitch, quiet hours, the player
 *  numbers, the format, a game's kickoff, a season break); "other" is anything else, or
 *  unknown, and says "do that". */
export type OrganisersOnlyKind = "players" | "cancel" | "restore" | "teams" | "score" | "settings" | "other";

/** The kind for an admin extractor action (`AdminFacts.action`). */
export function organisersOnlyKindOfAction(action: string | null | undefined): OrganisersOnlyKind {
  switch (action) {
    case "recruit":
    case "retry_ask":
      return "players";
    case "cancel_match":
      return "cancel";
    case "restore_match":
      return "restore";
    case "set_venue":
    case "quiet_hours":
    case "player_numbers":
    case "switch_format":
    case "move_game":
    case "season_break":
      return "settings";
    default:
      return "other";
  }
}
