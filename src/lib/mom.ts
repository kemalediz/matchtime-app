/**
 * Shared helper: compute MoM winner(s) + vote counts for a set of
 * matches in two queries (group-by MoMVote, then resolve playerIds to
 * names). Used by the dashboard recent-results, the past-matches list,
 * and anywhere else we want a compact "X (n votes)" display.
 *
 * Ties at the top are surfaced explicitly — DB ordering on equal
 * counts isn't deterministic, so we sort by name as a stable
 * tiebreaker. Callers decide whether to render "shared between" or
 * pick the first.
 */
import { db } from "./db";

export interface MomMatchSummary {
  topPlayers: Array<{ playerId: string; name: string; votes: number }>;
  topCount: number;
  totalVotes: number;
  voterCount: number; // == totalVotes (one vote per voter, unique constraint)
}

export async function getMomSummaries(
  matchIds: string[],
): Promise<Map<string, MomMatchSummary>> {
  const out = new Map<string, MomMatchSummary>();
  if (matchIds.length === 0) return out;

  const rows = await db.moMVote.groupBy({
    by: ["matchId", "playerId"],
    where: { matchId: { in: matchIds } },
    _count: { playerId: true },
  });
  if (rows.length === 0) return out;

  const playerIds = [...new Set(rows.map((r) => r.playerId))];
  const users = await db.user.findMany({
    where: { id: { in: playerIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(users.map((u) => [u.id, u.name ?? "?"]));

  // Group rows by matchId.
  const byMatch = new Map<
    string,
    Array<{ playerId: string; name: string; votes: number }>
  >();
  for (const r of rows) {
    const arr = byMatch.get(r.matchId) ?? [];
    arr.push({
      playerId: r.playerId,
      name: nameById.get(r.playerId) ?? "?",
      votes: r._count.playerId,
    });
    byMatch.set(r.matchId, arr);
  }

  for (const [matchId, tally] of byMatch) {
    tally.sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
    const topCount = tally[0].votes;
    const topPlayers = tally.filter((t) => t.votes === topCount);
    const totalVotes = tally.reduce((s, t) => s + t.votes, 0);
    out.set(matchId, {
      topPlayers,
      topCount,
      totalVotes,
      voterCount: totalVotes,
    });
  }

  return out;
}
