/**
 * Recent-history context for the WhatsApp analyzer.
 *
 * The analyzer's match context block previously only described the
 * NEXT upcoming match — so questions like "who got MoM last week?"
 * or "who's been the most consistent attender?" got an honest
 * "I don't know" reply. This module computes per-org historical
 * stats from the DB and exposes them as a structured object that
 * `buildMatchContextBlock` formats into the prompt.
 *
 * Performance:
 *   - One groupBy + one findMany per stat (MoM votes, attendance
 *     counts, Elo). All counts are aggregated server-side.
 *   - The whole result fits the 1-hour cached portion of the prompt,
 *     so cost-per-batch is dominated by the cache READ price (10×
 *     cheaper than fresh tokens). New stats only invalidate the
 *     cache when a match completes or a MoM vote lands — both
 *     low-frequency events at amateur-league cadence.
 *
 * Scope:
 *   - Per-match detail: ALL completed non-historical matches for the
 *     org, oldest first. The per-match block grows linearly with
 *     match count; at ~50 matches we'd want to roll up the older
 *     tail. Not a today problem.
 *   - MoM leaderboard: includes historical backfilled votes (their
 *     whole point) — `Match.isHistorical = true` only excludes the
 *     match-row itself from the per-match list, not the votes
 *     attributed to it.
 *   - Attendance + Elo leaderboards: top 10 + bottom 5 (for Elo).
 *     Excludes synthetic-historical matches from the denominators
 *     because those have no Attendance rows.
 */
import { db } from "./db";
import { getMomSummaries } from "./mom";
import { resolveTeamLabels } from "./team-labels";

export interface RecentMatchRow {
  id: string;
  date: Date;
  redLabel: string;
  yellowLabel: string;
  redScore: number | null;
  yellowScore: number | null;
  /** Display string like "5-4", "no score yet", or null when no score recorded. */
  scoreLabel: string;
  /** Resolved MoM display: "Wasim (5 of 11 votes)", "shared between X & Y (3 each)",
   *  or "no votes yet" when nobody voted. */
  momLabel: string;
}

export interface LeaderboardRow {
  userId: string;
  name: string;
  value: number;
  /** Optional context (e.g. "24/25 (96%)" for attendance). */
  detail?: string;
}

export interface RecentHistory {
  totalCompletedMatches: number;
  recentMatches: RecentMatchRow[];
  momLeaderboard: LeaderboardRow[];
  attendanceLeaderboard: LeaderboardRow[];
  eloTop: LeaderboardRow[];
  eloBottom: LeaderboardRow[];
}

const LEADERBOARD_LIMIT = 10;
const ELO_BOTTOM_LIMIT = 5;
/** Minimum matches played before a user qualifies for the Elo
 *  bottom-N list — otherwise a player with one bad match dominates. */
const ELO_BOTTOM_MIN_MATCHES = 3;

export async function loadRecentHistory(orgId: string): Promise<RecentHistory | null> {
  // 1. All completed, non-historical matches for the org. Oldest first
  //    so the LLM reads time left-to-right.
  const matches = await db.match.findMany({
    where: {
      activity: { orgId },
      status: "COMPLETED",
      isHistorical: false,
    },
    orderBy: { date: "asc" },
    include: {
      activity: {
        select: {
          sport: { select: { teamLabels: true } },
        },
      },
    },
  });

  if (matches.length === 0) {
    return null;
  }

  // Org-level team-label override (falls back to sport labels per slot).
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { teamLabels: true },
  });

  const matchIds = matches.map((m) => m.id);

  // 2. MoM votes for these matches — uses the shared helper so
  //    tie-handling matches the dashboard's display.
  const momSummaries = await getMomSummaries(matchIds);

  const recentMatches: RecentMatchRow[] = matches.map((m) => {
    const [redLabel, yellowLabel] = resolveTeamLabels(org, m.activity.sport);
    const hasScore = m.redScore !== null && m.yellowScore !== null;
    const scoreLabel = hasScore
      ? `${redLabel} ${m.redScore} - ${m.yellowScore} ${yellowLabel}`
      : "no score recorded";

    const summary = momSummaries.get(m.id);
    let momLabel = "no votes yet";
    if (summary && summary.topPlayers.length > 0) {
      if (summary.topPlayers.length === 1) {
        const p = summary.topPlayers[0];
        momLabel = `${p.name} (${p.votes} of ${summary.totalVotes} votes)`;
      } else {
        const names = summary.topPlayers.map((p) => p.name).join(" & ");
        momLabel = `shared between ${names} (${summary.topCount} votes each, ${summary.totalVotes} total)`;
      }
    }

    return {
      id: m.id,
      date: m.date,
      redLabel,
      yellowLabel,
      redScore: m.redScore,
      yellowScore: m.yellowScore,
      scoreLabel,
      momLabel,
    };
  });

  // 3. MoM leaderboard — count wins per player across ALL matches
  //    (including historical anchors). A "win" is being among the
  //    topPlayers for any match (ties co-win).
  const allMatchIds = (
    await db.match.findMany({
      where: { activity: { orgId } },
      select: { id: true },
    })
  ).map((m) => m.id);
  const allMomSummaries = await getMomSummaries(allMatchIds);
  const momWinsByPlayer = new Map<string, { name: string; wins: number }>();
  for (const summary of allMomSummaries.values()) {
    for (const winner of summary.topPlayers) {
      const cur = momWinsByPlayer.get(winner.playerId) ?? { name: winner.name, wins: 0 };
      cur.wins += 1;
      momWinsByPlayer.set(winner.playerId, cur);
    }
  }
  const momLeaderboard: LeaderboardRow[] = [...momWinsByPlayer.entries()]
    .map(([userId, v]) => ({ userId, name: v.name, value: v.wins }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, LEADERBOARD_LIMIT);

  // 4. Attendance leaderboard — count of CONFIRMED appearances per
  //    player across the completed matches above. Denominator is the
  //    org's TOTAL completed matches, not the player's personal
  //    "matches since first played" — Kemal flagged 2026-05-15 that
  //    showing "3/3 (100%)" for a player who joined late reads the
  //    same as "4/4 (100%)" for an ever-present, when it isn't. With
  //    the total denominator, Abid (joined match 2, attended all 3
  //    since) shows 3/4 (75%) — accurately positioning him below
  //    Kemal/Idris on consistency.
  const attendanceRows = await db.attendance.findMany({
    where: { matchId: { in: matchIds }, status: "CONFIRMED" },
    select: { userId: true, matchId: true },
  });
  const perPlayer = new Map<string, { count: number }>();
  for (const a of attendanceRows) {
    const cur = perPlayer.get(a.userId);
    if (!cur) perPlayer.set(a.userId, { count: 1 });
    else cur.count += 1;
  }
  const totalMatches = matches.length;
  const attendanceUserIds = [...perPlayer.keys()];
  const attendanceUsers = await db.user.findMany({
    where: { id: { in: attendanceUserIds } },
    select: { id: true, name: true },
  });
  const attendanceNameById = new Map(attendanceUsers.map((u) => [u.id, u.name ?? "(unnamed)"]));
  const attendanceLeaderboard: LeaderboardRow[] = [...perPlayer.entries()]
    .map(([userId, v]) => {
      const pct = totalMatches > 0 ? Math.round((v.count / totalMatches) * 100) : 0;
      return {
        userId,
        name: attendanceNameById.get(userId) ?? "(unnamed)",
        value: v.count,
        detail: `${v.count}/${totalMatches} (${pct}%)`,
      };
    })
    // Sort by raw count desc — with a fixed denominator that's the
    // same ordering as % desc. Stable name tiebreaker.
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, LEADERBOARD_LIMIT);

  // 5. Elo top + bottom — only players who've actually been assigned
  //    to a team in a completed match (rules out provisional ghosts
  //    that never played).
  const teamAssignmentUserIds = await db.teamAssignment.findMany({
    where: { match: { activity: { orgId }, status: "COMPLETED", isHistorical: false } },
    select: { userId: true },
    distinct: ["userId"],
  });
  const eloUserIds = teamAssignmentUserIds.map((t) => t.userId);
  const eloUsers = await db.user.findMany({
    where: { id: { in: eloUserIds } },
    select: { id: true, name: true, matchRating: true },
  });
  // Per-player matches-played (for the bottom-N min threshold).
  const matchesPlayedByUser = new Map<string, number>();
  for (const a of attendanceRows) {
    matchesPlayedByUser.set(a.userId, (matchesPlayedByUser.get(a.userId) ?? 0) + 1);
  }
  const eloRows: LeaderboardRow[] = eloUsers.map((u) => ({
    userId: u.id,
    name: u.name ?? "(unnamed)",
    value: u.matchRating,
    detail: `${matchesPlayedByUser.get(u.id) ?? 0} matches`,
  }));
  const eloTop = [...eloRows]
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, LEADERBOARD_LIMIT);
  const eloBottom = [...eloRows]
    .filter((r) => (matchesPlayedByUser.get(r.userId) ?? 0) >= ELO_BOTTOM_MIN_MATCHES)
    .sort((a, b) => a.value - b.value || a.name.localeCompare(b.name))
    .slice(0, ELO_BOTTOM_LIMIT);

  return {
    totalCompletedMatches: totalMatches,
    recentMatches,
    momLeaderboard,
    attendanceLeaderboard,
    eloTop,
    eloBottom,
  };
}

/** Format a RecentHistory as the "## Recent History" prompt section.
 *  Returns null when there's no completed match yet (so callers can
 *  omit the block entirely). */
export function formatRecentHistoryBlock(history: RecentHistory): string {
  const lines: string[] = [];
  lines.push(`## Recent History`);
  lines.push(
    `Completed matches: ${history.totalCompletedMatches} total. ` +
      `Use this block as the source of truth for ANY historical question — ` +
      `MoM winners, scores, attendance, current form. Never invent numbers; ` +
      `if the answer isn't here, say "I don't have that one yet" rather than guessing.`,
  );
  lines.push("");
  lines.push(`Completed matches (oldest first):`);
  for (const m of history.recentMatches) {
    const dateStr = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(m.date);
    lines.push(`  - ${dateStr}: ${m.scoreLabel} | MoM: ${m.momLabel}`);
  }
  if (history.momLeaderboard.length) {
    lines.push("");
    lines.push(`MoM leaderboard (most wins, includes historical backfill, ties co-win):`);
    history.momLeaderboard.forEach((r, i) => {
      lines.push(`  ${i + 1}. ${r.name} — ${r.value} ${r.value === 1 ? "win" : "wins"}`);
    });
  }
  if (history.attendanceLeaderboard.length) {
    lines.push("");
    lines.push(`Attendance leaderboard (CONFIRMED appearances out of every completed match — denominator is total matches, so a late-joining player who has played every match since is fairly ranked below an ever-present):`);
    history.attendanceLeaderboard.forEach((r, i) => {
      lines.push(`  ${i + 1}. ${r.name} — ${r.detail}`);
    });
  }
  if (history.eloTop.length) {
    lines.push("");
    lines.push(`Player rating top (current Elo, starting from 1000):`);
    history.eloTop.forEach((r, i) => {
      lines.push(`  ${i + 1}. ${r.name} — ${r.value} (${r.detail})`);
    });
  }
  if (history.eloBottom.length) {
    lines.push("");
    lines.push(`Player rating bottom (current Elo, ≥${ELO_BOTTOM_MIN_MATCHES} matches played):`);
    history.eloBottom.forEach((r, i) => {
      lines.push(`  ${i + 1}. ${r.name} — ${r.value} (${r.detail})`);
    });
  }
  return lines.join("\n");
}
