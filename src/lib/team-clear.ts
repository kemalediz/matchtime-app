/**
 * "@MATCH TIME CLEAR THE TEAMS": THE APPLY LAYER (2026-09-29).
 *
 * Sutton FC, Thu 24 Sep 22:52 BST: "@Match Time delete these teams,
 * early to form them, there is still 5 days". It routed `admin_ops`, the
 * admin extractor said `other`, and nothing happened and nobody was
 * told. The early sheet stood until match day.
 *
 * WHAT IT DOES. For the next match that can carry teams (the SAME
 * selector the balancer uses, `owner-deps.ts#selectTeamsMatch`): delete
 * every `TeamAssignment` row and move a TEAMS_GENERATED or
 * TEAMS_PUBLISHED match back to UPCOMING, in one transaction. Then one
 * short line to the group.
 *
 * WHO. Admins (Membership role OWNER or ADMIN) only. Clearing is
 * destructive for everybody in the match, unlike a slot swap, which
 * changes one row. A non-admin is told so in one line.
 *
 * WHEN IT IS REACHED. From `analyze/route.ts`, as a deterministic peel
 * BEFORE the router, on the raw body (`isClearTeamsRequest` in
 * `team-requests.ts`) of a message that tags MatchTime. No model call
 * decides it.
 *
 * Pure over injected deps, like `team-ops-engine.ts`: no database import
 * here, so every branch is unit-testable. The real deps are
 * `owner-deps.ts#buildTeamClearDeps`.
 */
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";

export interface TeamClearDeps {
  /** Is this user an OWNER or ADMIN of the org, still in it? */
  isAdmin: (userId: string) => Promise<boolean>;
  /** The match whose teams would be cleared, or null. */
  selectTeamsMatch: () => Promise<{ id: string; date: Date } | null>;
  /** Delete the match's `TeamAssignment` rows and reset a
   *  TEAMS_GENERATED / TEAMS_PUBLISHED status to UPCOMING, atomically. */
  clearTeams: (matchId: string) => Promise<{ deleted: number; statusReset: boolean }>;
}

export interface TeamClearResult {
  kind: "cleared" | "nothing" | "not_admin" | "failed";
  matchId: string | null;
  /** One line for the group; null only when the write threw. */
  reply: string | null;
  /** For `AnalyzedMessage.reasoning`. */
  logReason: string;
}

export async function applyClearTeams(args: {
  senderUserId: string | null;
  lang?: Lang | string | null;
  deps: TeamClearDeps;
}): Promise<TeamClearResult> {
  const { senderUserId, lang, deps } = args;
  const s = t(lang);

  if (!senderUserId || !(await deps.isAdmin(senderUserId))) {
    return {
      kind: "not_admin",
      matchId: null,
      reply: s.teams_clear_admin_only,
      logReason: `clear-teams refused: sender ${senderUserId ?? "(unresolved)"} is not an admin`,
    };
  }

  const match = await deps.selectTeamsMatch();
  if (!match) {
    return {
      kind: "nothing",
      matchId: null,
      reply: s.teams_clear_nothing,
      logReason: "clear-teams: no match lined up that could carry teams",
    };
  }

  try {
    const { deleted, statusReset } = await deps.clearTeams(match.id);
    if (deleted === 0 && !statusReset) {
      return {
        kind: "nothing",
        matchId: match.id,
        reply: s.teams_clear_nothing,
        logReason: `clear-teams: match ${match.id} had no teams`,
      };
    }
    return {
      kind: "cleared",
      matchId: match.id,
      reply: s.teams_cleared,
      logReason:
        `clear-teams: deleted ${deleted} TeamAssignment row(s) on match ${match.id}` +
        (statusReset ? "; status reset to UPCOMING" : ""),
    };
  } catch (err) {
    // §3.2 S7: an ack must never outrun the write. Say nothing.
    const why = err instanceof Error ? err.message : String(err);
    console.error("[team-clear] clearing the teams failed:", err);
    return {
      kind: "failed",
      matchId: match.id,
      reply: null,
      logReason: `clear-teams FAILED on match ${match.id} (${why}); nothing was said`,
    };
  }
}
