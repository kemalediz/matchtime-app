/**
 * THE STATS TABLES' TARGETED READ (2026-09-23).
 *
 * The third read `loadSquadState` does not do, after `payments` and
 * `ratingProgress`, and for the same reasons: it is several queries
 * deep, a stats question is a handful of messages a season, and
 * `compose.ts` may not import Prisma. `answer-batch.ts` calls this once,
 * after extraction, only when a `stats` question with a table survived
 * ownership, and hands the result down as `SquadState.stats`.
 *
 * NOTHING HERE COMPUTES A TABLE. Every one comes from the loader the
 * website or the DM Q&A already uses, so the group and those surfaces
 * cannot disagree about the same table:
 *
 *   ratings          `loadRatingLeaderboard` (the `/profile/stats` table):
 *                    club-scoped, the RAW mean of the club ratings each
 *                    player received, three-month inactivity rule. With
 *                    the group's minimum of three rated matches rather
 *                    than the page's one.
 *   Man of the Match `loadRecentHistory().momLeaderboard`
 *   Elo              `loadRecentHistory().eloTop` (three matches, since
 *                    2026-09-23, applied at the source)
 *   Team of Season   `loadTeamOfSeason`: the ratings list's minimum of
 *                    three rated matches and the three-month inactivity
 *                    rule, the same as the page
 *   Mr Reliable      `loadMrReliableHolders`, the page badge's own rule
 *   chemistry        `loadPlayerSeasonStats`, the page's two cards and
 *                    the nemesis card, for one named player
 *   appearances      `loadClubRecordTables` (2026-09-23), counted by the
 *                    same function as `loadRecentHistory`'s attendance
 *                    leaderboard, three-month inactivity rule included,
 *                    over the whole record; and where the records begin
 *   last Man of the Match  `loadLastMom` (2026-11-10): ONE match, the most
 *                    recent one that can be told, as announced or by the
 *                    winner only (`last-mom.ts`, the rules of 2026-11-16)
 *
 * A PERIOD (2026-09-23): `loadStatsPeriod` cuts the three tables the
 * data genuinely supports (appearances, ratings, Man of the Match) to
 * the matches since a date, with the same loaders and the same rules.
 * Elo, Team of the Season, Mr Reliable and chemistry are whole-record by
 * nature and are never cut; the answer says so instead.
 *
 * READ-ONLY BY CONSTRUCTION: every statement is a find.
 */
import { db } from "../db";
import { loadClubRecordTables, loadRecentHistory } from "../match-history";
import {
  loadMrReliableHolders,
  loadPlayerSeasonStats,
  loadRatingLeaderboard,
  loadTeamOfSeason,
} from "../player-stats";
import { GROUP_RATINGS_MIN_GAMES } from "./stats-limits";
import { lastMomFacts, type LastMomFacts } from "./last-mom";
import { loadMomRecords } from "../mom-records";
import { matchRatingsFrom, type LastMatchRatings } from "./unified-answer";
import { NOT_CANCELLED } from "../played-match";
import type { StatsChemistry, StatsPeriodTables, StatsRatingRow, StatsSnapshot } from "./types";

/** Everything but the per-question parts, which `answer-batch.ts` adds. */
export type StatsTables = Omit<StatsSnapshot, "chemistry" | "generic" | "periods">;

/** Enough to hold every ranked player at club scale; the group prints
 *  ten, and the climbers are ranked over the whole table. */
const WHOLE_TABLE = 1_000;

/** The website's full tables, for the bottom and over-cap answers. The
 *  same host rule as `buildMagicLinkUrl`. */
export function fullStatsTableUrl(): string {
  const base = process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? "https://matchtime.ai";
  return `${base}/profile/stats`;
}

/** The ranked rows of `loadRatingLeaderboard`, as the group reads them. */
function rankedRows(rows: Awaited<ReturnType<typeof loadRatingLeaderboard>>): StatsRatingRow[] {
  return rows
    .filter((r) => r.rank !== null && !r.inactive)
    .map((r) => ({ userId: r.userId, name: r.name, avg: r.avg, games: r.games, rank: r.rank!, delta: r.delta }));
}

export async function loadStatsTables(orgId: string, now: Date = new Date()): Promise<StatsTables> {
  const [ratings, history, tots, reliable, aliases, record, lastMom] = await Promise.all([
    loadRatingLeaderboard(orgId, { minGames: GROUP_RATINGS_MIN_GAMES, limit: WHOLE_TABLE }),
    loadRecentHistory(orgId, now),
    loadTeamOfSeason(orgId),
    loadMrReliableHolders(orgId),
    db.userAlias.findMany({ where: { orgId }, select: { alias: true, userId: true } }),
    loadClubRecordTables(orgId, { now }),
    loadLastMom(orgId, now),
  ]);
  return {
    fullTableUrl: fullStatsTableUrl(),
    lastMom,
    ratings: rankedRows(ratings),
    appearances: record.appearances,
    recordsStart: record.recordsStart,
    completedMatches: record.completedMatches,
    mom: (history?.momLeaderboard ?? []).map((r) => ({ userId: r.userId, name: r.name, wins: r.value })),
    elo: (history?.eloTop ?? []).map((r) => ({
      userId: r.userId,
      name: r.name,
      rating: r.value,
      matches: r.matches ?? 0,
    })),
    teamOfSeason:
      tots && tots.formation.length > 0
        ? {
            sportName: tots.sportName,
            slots: tots.formation.map((x) => ({
              position: x.position,
              userId: x.userId,
              name: x.name,
              avg: x.avg,
              games: x.games,
            })),
          }
        : null,
    mrReliable: reliable,
    aliases,
  };
}

/** Newest matches with Man of the Match votes read: the last one that can
 *  be told (the matches still voting, about one a week per fixture, sit in
 *  front of it) and, since 2026-11-11, the recent ones match by match for
 *  the unified answer ("the last 3 weeks' MoMs"): about two months of
 *  weekly games. */
const LAST_MOM_LOOKBACK = 10;

/**
 * THE LAST MAN OF THE MATCH (2026-11-10; `last-mom.ts` decides, by the
 * rules of 2026-11-16). The club's newest matches with Man of the Match
 * votes or a stored result, read by `loadMomRecords` (`mom-records.ts`), the
 * same loader every Man of the Match wins table reads, so the answer and the
 * tables cannot disagree.
 */
export async function loadLastMom(orgId: string, now: Date): Promise<LastMomFacts> {
  const { records, organisersPick } = await loadMomRecords(orgId, now, { take: LAST_MOM_LOOKBACK });
  return lastMomFacts(records, { now, organisersPick });
}

/** One named player's chemistry, as the stats page shows it. */
export async function loadStatsChemistry(orgId: string, userId: string, now: Date = new Date()): Promise<StatsChemistry | null> {
  // At the batch's clock: his Man of the Match count depends on which
  // matches are decided by then (review of #608).
  const st = await loadPlayerSeasonStats(orgId, userId, now);
  if (!st) return null;
  const w = st.chemistry.bestByWinRate;
  const r = st.chemistry.bestByRating;
  const n = st.rivalry.nemesis;
  return {
    userId,
    name: st.player.name ?? "(unknown)",
    bestByWinRate: w ? { name: w.name, gamesTogether: w.gamesTogether, wins: w.wins, winRate: w.winRate } : null,
    bestByRating:
      r && r.myAvgWith !== null
        ? { name: r.name, myAvgWith: r.myAvgWith, sameAsWinRate: !!w && w.userId === r.userId }
        : null,
    nemesis: n ? { name: n.name, gamesAgainst: n.gamesAgainst, wins: n.wins } : null,
  };
}

/**
 * The three tables the data can cut, cut to the matches since `since`
 * (2026-09-23). The same loaders and rules as the whole-record tables;
 * the group's ratings minimum of three rated matches applies within the
 * period.
 */
export async function loadStatsPeriod(orgId: string, since: Date, now: Date = new Date()): Promise<Omit<StatsPeriodTables, "since">> {
  const [record, ratings] = await Promise.all([
    // At the batch's clock, like the whole-record tables (review of #608).
    loadClubRecordTables(orgId, { since, now }),
    loadRatingLeaderboard(orgId, { minGames: GROUP_RATINGS_MIN_GAMES, limit: WHOLE_TABLE, since }),
  ]);
  return { appearances: record.appearances, ratings: rankedRows(ratings), mom: record.mom };
}

/**
 * THE RATINGS EACH PLAYER GOT IN THE LAST RATED MATCH (2026-11-11), for the
 * organisers' unified answer only (FNF HQ: "can you share the players who
 * were rated for last week's match and their ratings?"). The club's newest
 * match, not cancelled and already kicked off, that has Rating rows; each
 * player's average score from their team-mates and how many rated them.
 * Who rated whom is never read. READ-ONLY.
 */
export async function loadLastMatchRatings(orgId: string, now: Date): Promise<LastMatchRatings | null> {
  const match = await db.match.findFirst({
    where: { activity: { orgId }, ...NOT_CANCELLED, date: { lte: now }, ratings: { some: {} } },
    orderBy: { date: "desc" },
    select: { id: true, date: true },
  });
  if (!match) return null;
  const groups = await db.rating.groupBy({
    by: ["playerId"],
    where: { matchId: match.id },
    _avg: { score: true },
    _count: { playerId: true },
  });
  const users = await db.user.findMany({ where: { id: { in: groups.map((g) => g.playerId) } }, select: { id: true, name: true } });
  const nameOf = new Map(users.map((u) => [u.id, u.name ?? "?"]));
  return matchRatingsFrom(
    match.date,
    groups.map((g) => ({ userId: g.playerId, name: nameOf.get(g.playerId) ?? "?", avg: Math.round((g._avg.score ?? 0) * 10) / 10, count: g._count.playerId })),
  );
}
