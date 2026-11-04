/**
 * THE CLUB'S SETUP FOR A `club` QUESTION, FROM THE CLUB SUMMARY (slice A2,
 * MDs/club-summary-design-2026-11-04.md section 3.5: `loadClubSnapshot` is
 * deleted in favour of the summary). PURE: no Prisma, so `answer-batch.ts`
 * can import it without the database client.
 *
 * Read for a `club` question ("MatchTime who are the admins?", FNF HQ
 * 2026-10-16). The admins are already on the roster (`isAdmin`); this adds
 * the money collector, the fee of the upcoming match and "Teams ready".
 * Each value is the one `loadClubSnapshot` reads, taken from the summary:
 *   - the money collector's `User.name`, null when none is set or the user
 *     has no name (`payments.collector`);
 *   - the fee of the match asked about (`matchId`, the squad state's
 *     upcoming match): the summary's one fee fact (`fee.forPlayers`,
 *     slice B5, decision K3), no amount without a match. The match is
 *     found among the summary's matches (every live one is there; a
 *     historical match never is, see the PR's named edges);
 *   - "Teams ready" as the proposal scheduler reads it
 *     (`effectiveTeamsReadyTime`, `routine.teamsReady`), so the answer and
 *     the scheduler cannot disagree.
 */
import type { ClubSummary } from "../club-summary/types";
import { NO_FEE } from "../fee-fact";
import type { ClubSnapshot } from "./types";

export function clubSnapshotOf(summary: ClubSummary, matchId: string | null): ClubSnapshot {
  const match = matchId ? (summary.matches.find((m) => m.id === matchId) ?? null) : null;
  return {
    collectorName: summary.payments.collector?.name ?? null,
    fee: match?.fee.forPlayers ?? NO_FEE,
    teamsReady: summary.routine.teamsReady,
  };
}
