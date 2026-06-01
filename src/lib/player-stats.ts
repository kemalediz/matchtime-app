/**
 * Player performance stats since launch (2026-06-01).
 *
 * Pure, org-scoped data layer powering:
 *   - /profile/stats (the player-facing "my stats" experience)
 *   - the Wrapped share card (/api/wrapped/[playerId])
 *
 * Everything is computed from existing data — peer Ratings (1-10),
 * MoMVotes, TeamAssignments (team → W/D/L + teammates), Attendance,
 * and Match scores. No new capture needed. Goals/assists are NOT here
 * (we don't track them yet — flagged as a future data stream).
 *
 * One DB read of the org's completed matches + their ratings/votes/
 * assignments, then all aggregation in JS. At club scale (tens of
 * matches, ~14 players) this is a handful of rows — cheap.
 */

import { db } from "./db";
import { format } from "date-fns";

export interface TimelinePoint {
  matchId: string;
  date: string; // ISO
  label: string; // "12 May"
  /** Player's average peer rating this game (null if they got no ratings). */
  myAvg: number | null;
  /** How many teammates rated the player this game. */
  raterCount: number;
  /** Average rating across ALL players this game — the "field". */
  fieldAvg: number | null;
  /** Did the player win (or co-win) Man of the Match this game. */
  isMoM: boolean;
  /** Player's result this game from their team's perspective. */
  result: "W" | "D" | "L" | null;
  /** "3-2" from the player's team-first perspective, or null. */
  scoreLine: string | null;
}

export interface Badge {
  key: string;
  emoji: string;
  label: string;
  hint: string;
  earned: boolean;
}

export interface TeammateChemistry {
  userId: string;
  name: string;
  gamesTogether: number;
  wins: number;
  winRate: number; // 0..1
  /** Player's average rating in games alongside this teammate. */
  myAvgWith: number | null;
}

export interface PlayerSeasonStats {
  orgId: string;
  orgName: string;
  player: { id: string; name: string | null; image: string | null };
  /** Completed matches in the org overall (denominator for attendance). */
  totalOrgMatches: number;
  gamesPlayed: number;
  attendanceRate: number; // 0..100
  avgRating: number | null;
  fieldAvgSeason: number | null;
  /** % above/below the season field average (e.g. +8 = 8% above). */
  vsFieldPct: number | null;
  momCount: number;
  record: { w: number; d: number; l: number };
  goalDiff: number;
  /** Best single-game average rating + its label. */
  bestGame: { label: string; avg: number; matchId: string } | null;
  timeline: TimelinePoint[];
  form: {
    last5Avg: number | null;
    /** "hot" | "cold" | "steady" — emotional badge for the form curve. */
    trend: "hot" | "cold" | "steady";
  };
  badges: Badge[];
  chemistry: {
    bestByWinRate: TeammateChemistry | null;
    bestByRating: TeammateChemistry | null;
  };
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number | null {
  const m = mean(xs);
  if (m === null || xs.length < 2) return null;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

/** Resolve the MoM winner(s) for a match from its vote rows: the
 *  playerId(s) with the most votes (>0). Ties co-win, matching the
 *  bot's shared-MoM announcement. */
function momWinners(votes: { playerId: string }[]): Set<string> {
  if (votes.length === 0) return new Set();
  const tally = new Map<string, number>();
  for (const v of votes) tally.set(v.playerId, (tally.get(v.playerId) ?? 0) + 1);
  let max = 0;
  for (const c of tally.values()) if (c > max) max = c;
  const winners = new Set<string>();
  for (const [pid, c] of tally) if (c === max && max > 0) winners.add(pid);
  return winners;
}

export async function loadPlayerSeasonStats(
  orgId: string,
  userId: string,
): Promise<PlayerSeasonStats | null> {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { id: true, name: true },
  });
  if (!org) return null;

  const player = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, image: true },
  });
  if (!player) return null;

  const matches = await db.match.findMany({
    where: {
      activity: { orgId },
      status: "COMPLETED",
      isHistorical: false,
    },
    orderBy: { date: "asc" },
    select: {
      id: true,
      date: true,
      redScore: true,
      yellowScore: true,
      ratings: { select: { playerId: true, score: true } },
      momVotes: { select: { playerId: true } },
      teamAssignments: { select: { userId: true, team: true } },
      attendances: {
        where: { userId },
        select: { status: true },
      },
    },
  });

  const totalOrgMatches = matches.length;

  // Names for chemistry labelling — gather all teammate userIds first.
  const teammateIds = new Set<string>();
  for (const m of matches) {
    const mine = m.teamAssignments.find((t) => t.userId === userId);
    if (!mine) continue;
    for (const t of m.teamAssignments) {
      if (t.userId !== userId && t.team === mine.team) teammateIds.add(t.userId);
    }
  }
  const teammateNames = new Map<string, string>();
  if (teammateIds.size > 0) {
    const users = await db.user.findMany({
      where: { id: { in: [...teammateIds] } },
      select: { id: true, name: true },
    });
    for (const u of users) teammateNames.set(u.id, u.name ?? "(unknown)");
  }

  const timeline: TimelinePoint[] = [];
  const myScoresAll: number[] = [];
  const fieldScoresAll: number[] = [];
  let gamesPlayed = 0;
  let momCount = 0;
  const record = { w: 0, d: 0, l: 0 };
  let goalDiff = 0;

  // teammateId -> { games, wins, myScores[] }
  const chem = new Map<string, { games: number; wins: number; myScores: number[] }>();

  for (const m of matches) {
    const played =
      m.attendances.some((a) => a.status === "CONFIRMED") ||
      m.teamAssignments.some((t) => t.userId === userId);
    if (played) gamesPlayed++;

    const myRatings = m.ratings.filter((r) => r.playerId === userId).map((r) => r.score);
    const fieldRatings = m.ratings.map((r) => r.score);
    const myAvg = mean(myRatings);
    const fieldAvg = mean(fieldRatings);
    if (myAvg !== null) myScoresAll.push(...myRatings);
    fieldScoresAll.push(...fieldRatings);

    const winners = momWinners(m.momVotes);
    const isMoM = winners.has(userId);
    if (isMoM) momCount++;

    // Result from the player's team perspective.
    const mine = m.teamAssignments.find((t) => t.userId === userId);
    let result: "W" | "D" | "L" | null = null;
    let scoreLine: string | null = null;
    if (mine && m.redScore !== null && m.yellowScore !== null) {
      const ownScore = mine.team === "RED" ? m.redScore : m.yellowScore;
      const oppScore = mine.team === "RED" ? m.yellowScore : m.redScore;
      scoreLine = `${ownScore}-${oppScore}`;
      goalDiff += ownScore - oppScore;
      if (ownScore > oppScore) {
        result = "W";
        record.w++;
      } else if (ownScore < oppScore) {
        result = "L";
        record.l++;
      } else {
        result = "D";
        record.d++;
      }
      // Chemistry: accumulate per teammate on the same team.
      for (const t of m.teamAssignments) {
        if (t.userId === userId || t.team !== mine.team) continue;
        const c = chem.get(t.userId) ?? { games: 0, wins: 0, myScores: [] };
        c.games++;
        if (result === "W") c.wins++;
        if (myAvg !== null) c.myScores.push(myAvg);
        chem.set(t.userId, c);
      }
    }

    // Only surface games where the player actually received ratings —
    // those are the meaningful points on a "my ratings" timeline.
    if (myAvg !== null) {
      timeline.push({
        matchId: m.id,
        date: m.date.toISOString(),
        label: format(m.date, "d MMM"),
        myAvg,
        raterCount: myRatings.length,
        fieldAvg,
        isMoM,
        result,
        scoreLine,
      });
    }
  }

  const avgRating = mean(myScoresAll);
  const fieldAvgSeason = mean(fieldScoresAll);
  const vsFieldPct =
    avgRating !== null && fieldAvgSeason !== null && fieldAvgSeason > 0
      ? ((avgRating - fieldAvgSeason) / fieldAvgSeason) * 100
      : null;

  // Best single game.
  let bestGame: PlayerSeasonStats["bestGame"] = null;
  for (const p of timeline) {
    if (p.myAvg !== null && (bestGame === null || p.myAvg > bestGame.avg)) {
      bestGame = { label: p.label, avg: p.myAvg, matchId: p.matchId };
    }
  }

  // Form: last 5 rated games + hot/cold/steady trend.
  const last5 = timeline.slice(-5).map((p) => p.myAvg!).filter((x) => x != null);
  const last5Avg = mean(last5);
  let trend: "hot" | "cold" | "steady" = "steady";
  if (last5.length >= 3) {
    const half = Math.floor(last5.length / 2);
    const earlier = mean(last5.slice(0, half));
    const later = mean(last5.slice(-half));
    if (earlier !== null && later !== null) {
      if (later - earlier >= 0.5) trend = "hot";
      else if (earlier - later >= 0.5) trend = "cold";
    }
  }

  // Badges (milestones).
  const playedEvery = totalOrgMatches > 0 && gamesPlayed === totalOrgMatches;
  const sd = stddev(timeline.map((p) => p.myAvg!).filter((x) => x != null));
  const hadMasterclass = timeline.some((p) => p.myAvg !== null && p.myAvg >= 9);
  const badges: Badge[] = [
    { key: "first-game", emoji: "👟", label: "On the board", hint: "Played your first game", earned: gamesPlayed >= 1 },
    { key: "ten-games", emoji: "🔟", label: "Regular", hint: "Played 10+ games", earned: gamesPlayed >= 10 },
    { key: "ironman", emoji: "🦾", label: "Iron Man", hint: "Played every single match", earned: playedEvery && totalOrgMatches >= 3 },
    { key: "first-mom", emoji: "🏆", label: "Man of the Match", hint: "Won MoM at least once", earned: momCount >= 1 },
    { key: "mom-machine", emoji: "👑", label: "MoM Machine", hint: "Won MoM 3+ times", earned: momCount >= 3 },
    { key: "masterclass", emoji: "🌟", label: "Masterclass", hint: "Averaged 9+ in a game", earned: hadMasterclass },
    { key: "reliable", emoji: "🧱", label: "Mr Reliable", hint: "Consistently strong ratings", earned: sd !== null && sd < 1 && (avgRating ?? 0) >= 6.5 && timeline.length >= 4 },
    { key: "above-field", emoji: "📈", label: "Above the Curve", hint: "Season rating above the squad average", earned: vsFieldPct !== null && vsFieldPct > 0 && timeline.length >= 3 },
  ];

  // Chemistry: best teammate by win-rate and by your avg rating (min 2 games together).
  const chemRows: TeammateChemistry[] = [...chem.entries()]
    .filter(([, c]) => c.games >= 2)
    .map(([id, c]) => ({
      userId: id,
      name: teammateNames.get(id) ?? "(unknown)",
      gamesTogether: c.games,
      wins: c.wins,
      winRate: c.games > 0 ? c.wins / c.games : 0,
      myAvgWith: mean(c.myScores),
    }));
  const bestByWinRate =
    chemRows.length > 0
      ? [...chemRows].sort((a, b) => b.winRate - a.winRate || b.gamesTogether - a.gamesTogether)[0]
      : null;
  const bestByRating =
    chemRows.filter((c) => c.myAvgWith !== null).length > 0
      ? [...chemRows]
          .filter((c) => c.myAvgWith !== null)
          .sort((a, b) => (b.myAvgWith ?? 0) - (a.myAvgWith ?? 0))[0]
      : null;

  return {
    orgId: org.id,
    orgName: org.name,
    player: { id: player.id, name: player.name, image: player.image },
    totalOrgMatches,
    gamesPlayed,
    attendanceRate: totalOrgMatches > 0 ? Math.round((gamesPlayed / totalOrgMatches) * 100) : 0,
    avgRating,
    fieldAvgSeason,
    vsFieldPct,
    momCount,
    record,
    goalDiff,
    bestGame,
    timeline,
    form: { last5Avg, trend },
    badges,
    chemistry: { bestByWinRate, bestByRating },
  };
}
