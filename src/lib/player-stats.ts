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

export interface RivalRecord {
  userId: string;
  name: string;
  /** Games where this opponent was on the OTHER team. */
  gamesAgainst: number;
  /** Of those, how many the player's team won. */
  wins: number;
  losses: number;
  winRate: number; // 0..1 (player's win rate against them)
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
  rivalry: {
    /** Opponent the player loses to most (worst win rate, min 2 games). */
    nemesis: RivalRecord | null;
    /** Opponent the player beats most (best win rate, min 2 games). */
    bestVictim: RivalRecord | null;
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

  // Names for chemistry + rivalry labelling — gather all teammate AND
  // opponent userIds first (one names lookup for both).
  const relatedIds = new Set<string>();
  for (const m of matches) {
    const mine = m.teamAssignments.find((t) => t.userId === userId);
    if (!mine) continue;
    for (const t of m.teamAssignments) {
      if (t.userId !== userId) relatedIds.add(t.userId);
    }
  }
  const relatedNames = new Map<string, string>();
  if (relatedIds.size > 0) {
    const users = await db.user.findMany({
      where: { id: { in: [...relatedIds] } },
      select: { id: true, name: true },
    });
    for (const u of users) relatedNames.set(u.id, u.name ?? "(unknown)");
  }
  const teammateNames = relatedNames; // alias kept for readability below

  const timeline: TimelinePoint[] = [];
  const myScoresAll: number[] = [];
  const fieldScoresAll: number[] = [];
  let gamesPlayed = 0;
  let momCount = 0;
  const record = { w: 0, d: 0, l: 0 };
  let goalDiff = 0;

  // teammateId -> { games, wins, myScores[] }
  const chem = new Map<string, { games: number; wins: number; myScores: number[] }>();
  // opponentId -> { games, wins, losses } (from the player's perspective)
  const opp = new Map<string, { games: number; wins: number; losses: number }>();

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
      // Chemistry (same team) + rivalry (other team) in one pass.
      for (const t of m.teamAssignments) {
        if (t.userId === userId) continue;
        if (t.team === mine.team) {
          const c = chem.get(t.userId) ?? { games: 0, wins: 0, myScores: [] };
          c.games++;
          if (result === "W") c.wins++;
          if (myAvg !== null) c.myScores.push(myAvg);
          chem.set(t.userId, c);
        } else {
          const o = opp.get(t.userId) ?? { games: 0, wins: 0, losses: 0 };
          o.games++;
          if (result === "W") o.wins++;
          else if (result === "L") o.losses++;
          opp.set(t.userId, o);
        }
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

  // Rivalry: best win-rate against (you own them) + worst (nemesis).
  // Min 2 head-to-heads so a single game doesn't crown a nemesis.
  const rivalRows: RivalRecord[] = [...opp.entries()]
    .filter(([, o]) => o.games >= 2)
    .map(([id, o]) => ({
      userId: id,
      name: relatedNames.get(id) ?? "(unknown)",
      gamesAgainst: o.games,
      wins: o.wins,
      losses: o.losses,
      winRate: o.games > 0 ? o.wins / o.games : 0,
    }));
  const bestVictim =
    rivalRows.length > 0
      ? [...rivalRows].sort((a, b) => b.winRate - a.winRate || b.gamesAgainst - a.gamesAgainst)[0]
      : null;
  const nemesis =
    rivalRows.length > 0
      ? [...rivalRows].sort((a, b) => a.winRate - b.winRate || b.gamesAgainst - a.gamesAgainst)[0]
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
    rivalry: {
      // Only call someone a nemesis if you actually lose to them more
      // than you beat them; only a "victim" if you win more than you
      // lose. (winRate<0.5 vs >0.5 → they can't be the same person.)
      nemesis: nemesis && nemesis.winRate < 0.5 ? nemesis : null,
      bestVictim: bestVictim && bestVictim.winRate > 0.5 ? bestVictim : null,
    },
  };
}

// ─── Org-wide leaderboards & Team of the Season ──────────────────────

export interface LeaderboardRow {
  userId: string;
  name: string;
  avg: number;
  games: number;
  rank: number;
  /** Rank as of the previous completed match (null if new this week). */
  prevRank: number | null;
  /** prevRank - rank: positive = climbed, negative = dropped, 0 = same. */
  delta: number | null;
}

/**
 * Season rating leaderboard with week-on-week movement arrows. Ranks
 * players by their average peer rating across all completed matches,
 * then re-ranks excluding the most recent completed match to compute
 * the movement since last week. Min `minGames` appearances to rank
 * (one lucky game shouldn't top the table).
 */
export async function loadRatingLeaderboard(
  orgId: string,
  opts: { minGames?: number; limit?: number } = {},
): Promise<LeaderboardRow[]> {
  const minGames = opts.minGames ?? 2;
  const limit = opts.limit ?? 20;

  const matches = await db.match.findMany({
    where: { activity: { orgId }, status: "COMPLETED", isHistorical: false },
    orderBy: { date: "asc" },
    select: {
      id: true,
      date: true,
      ratings: { select: { playerId: true, score: true } },
    },
  });
  if (matches.length === 0) return [];

  const latestMatchId = matches[matches.length - 1].id;

  // playerId -> { scores[], distinct matchIds } — `games` must count
  // matches, NOT rating rows (a game with 12 raters is still one game).
  type Acc = { scores: number[]; matches: Set<string> };
  const all = new Map<string, Acc>();
  const prior = new Map<string, Acc>();
  const bump = (map: Map<string, Acc>, pid: string, score: number, matchId: string) => {
    const a = map.get(pid) ?? { scores: [], matches: new Set<string>() };
    a.scores.push(score);
    a.matches.add(matchId);
    map.set(pid, a);
  };
  for (const m of matches) {
    for (const r of m.ratings) {
      bump(all, r.playerId, r.score, m.id);
      if (m.id !== latestMatchId) bump(prior, r.playerId, r.score, m.id);
    }
  }

  const nameRows = await db.user.findMany({
    where: { id: { in: [...all.keys()] } },
    select: { id: true, name: true },
  });
  const names = new Map(nameRows.map((u) => [u.id, u.name ?? "(unknown)"]));

  const rank = (map: Map<string, Acc>) => {
    const rows = [...map.entries()]
      .map(([id, a]) => ({ id, avg: mean(a.scores)!, games: a.matches.size }))
      .filter((r) => r.games >= minGames)
      .sort((a, b) => b.avg - a.avg);
    const rankMap = new Map<string, number>();
    rows.forEach((r, i) => rankMap.set(r.id, i + 1));
    return { rows, rankMap };
  };

  const now = rank(all);
  const priorRanked = rank(prior);

  return now.rows.slice(0, limit).map((r) => {
    const prevRank = priorRanked.rankMap.get(r.id) ?? null;
    const rankNow = now.rankMap.get(r.id)!;
    return {
      userId: r.id,
      name: names.get(r.id) ?? "(unknown)",
      avg: r.avg,
      games: r.games,
      rank: rankNow,
      prevRank,
      delta: prevRank !== null ? prevRank - rankNow : null,
    };
  });
}

export interface TeamOfSeasonSlot {
  position: string;
  userId: string;
  name: string;
  avg: number;
  games: number;
}

/**
 * Team of the Season — the single best XI (one team's worth) by season
 * average rating, respecting the sport's position composition when set
 * (e.g. {GK:1, DEF:2, MID:2, FWD:2}). Players are assigned greedily:
 * highest-rated eligible player fills each slot for the position they
 * list. Slots that can't be filled by a position specialist fall back
 * to the best remaining player. Returns [] if there isn't enough data.
 */
export async function loadTeamOfSeason(
  orgId: string,
  opts: { minGames?: number } = {},
): Promise<{ formation: TeamOfSeasonSlot[]; sportName: string } | null> {
  const minGames = opts.minGames ?? 2;

  const sport = await db.sport.findFirst({
    where: { orgId },
    orderBy: { createdAt: "asc" },
    select: { name: true, playersPerTeam: true, positions: true, positionComposition: true },
  });
  if (!sport) return null;

  const matches = await db.match.findMany({
    where: { activity: { orgId }, status: "COMPLETED", isHistorical: false },
    select: { id: true, ratings: { select: { playerId: true, score: true } } },
  });
  // games = distinct matches rated in, NOT rating-row count.
  const acc = new Map<string, { scores: number[]; matches: Set<string> }>();
  for (const m of matches) {
    for (const r of m.ratings) {
      const a = acc.get(r.playerId) ?? { scores: [], matches: new Set<string>() };
      a.scores.push(r.score);
      a.matches.add(m.id);
      acc.set(r.playerId, a);
    }
  }
  const eligible = [...acc.entries()]
    .map(([id, a]) => ({ id, avg: mean(a.scores)!, games: a.matches.size }))
    .filter((r) => r.games >= minGames)
    .sort((a, b) => b.avg - a.avg);
  if (eligible.length === 0) return null;

  // Player positions (per this org's primary activity set).
  const posRows = await db.playerActivityPosition.findMany({
    where: { userId: { in: eligible.map((e) => e.id) }, activity: { orgId } },
    select: { userId: true, positions: true },
  });
  const playerPositions = new Map<string, Set<string>>();
  for (const p of posRows) {
    const set = playerPositions.get(p.userId) ?? new Set<string>();
    p.positions.forEach((x) => set.add(x));
    playerPositions.set(p.userId, set);
  }

  const nameRows = await db.user.findMany({
    where: { id: { in: eligible.map((e) => e.id) } },
    select: { id: true, name: true },
  });
  const names = new Map(nameRows.map((u) => [u.id, u.name ?? "(unknown)"]));

  // Build the slot list from positionComposition, else fall back to a
  // flat top-N by rating.
  const comp = sport.positionComposition as Record<string, number> | null;
  const slots: string[] = [];
  if (comp && Object.keys(comp).length > 0) {
    for (const pos of sport.positions) {
      const n = comp[pos] ?? 0;
      for (let i = 0; i < n; i++) slots.push(pos);
    }
  }
  // If composition is missing/short, pad with generic slots up to team size.
  while (slots.length < sport.playersPerTeam) slots.push("ANY");

  const picked = new Set<string>();
  const formation: TeamOfSeasonSlot[] = [];
  for (const pos of slots) {
    // Best eligible unpicked player who lists this position (or ANY).
    const pick = eligible.find(
      (e) =>
        !picked.has(e.id) &&
        (pos === "ANY" || (playerPositions.get(e.id)?.has(pos) ?? false)),
    );
    const chosen = pick ?? eligible.find((e) => !picked.has(e.id)); // fallback: best leftover
    if (!chosen) break;
    picked.add(chosen.id);
    formation.push({
      position: pos,
      userId: chosen.id,
      name: names.get(chosen.id) ?? "(unknown)",
      avg: chosen.avg,
      games: chosen.games,
    });
  }

  return { formation, sportName: sport.name };
}
