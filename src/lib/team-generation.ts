/**
 * Shared team-generation helper. Called from both the legacy
 * `/api/cron/generate-teams` (which still runs for maintenance — auto-
 * publish + auto-complete) and the LLM analyse route when a player
 * asks the bot to generate teams.
 *
 * Balances the confirmed squad via the Activity's configured strategy
 * (snake-draft + hill-climb, rating-only, etc.), writes TeamAssignment
 * rows, flips the Match into TEAMS_GENERATED, and returns a
 * ready-to-post group message with the Red/Yellow lineup.
 */
import { db } from "./db";
import { balanceTeams, type BalancingStrategy } from "./team-balancer";
import type { PlayerWithRating } from "@/types";
import { formatLondon } from "./london-time";
import { adjustRatings, type AdjusterMessage } from "./rating-adjuster";
import { computePlayerRating } from "./player-rating";
import { resolveTeamLabels } from "./team-labels";

export type GenerateTeamsResult =
  | { ok: true; groupPost: string; matchId: string }
  | { ok: false; reason: string };

export interface GenerateTeamsOptions {
  /** Pin specific userIds to specific teams. Honoured by the
   *  balancer even when it makes the rating-diff worse — admin
   *  intent overrides the optimiser. Used by the LLM "put me on
   *  Red" pathway. */
  pinnedToTeam?: Record<string, "RED" | "YELLOW">;
}

export async function generateTeamsForMatch(
  matchId: string,
  opts: GenerateTeamsOptions = {},
): Promise<GenerateTeamsResult> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: { include: { sport: true, org: true } },
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { include: { activityPositions: true } } },
      },
    },
  });
  if (!match) return { ok: false, reason: "match not found" };
  if (match.status === "COMPLETED" || match.status === "CANCELLED") {
    return { ok: false, reason: `match is ${match.status.toLowerCase()}` };
  }

  const sport = match.activity.sport;
  const perTeam = sport.playersPerTeam;
  if (match.attendances.length < perTeam * 2) {
    return {
      ok: false,
      reason: `not enough confirmed players — ${match.attendances.length}/${perTeam * 2}`,
    };
  }

  const basePlayers: PlayerWithRating[] = await Promise.all(
    match.attendances.map(async (a) => {
      const ratings = await db.rating.findMany({
        where: { playerId: a.userId },
        orderBy: { createdAt: "desc" },
        take: 60,
      });
      // Bayesian blend: seed acts as a prior with weight 3, smoothly
      // dominated by peer ratings as more arrive. Replaces the old
      // step function (which jumped from pure-seed → pure-peer at
      // exactly 3 ratings).
      const { rating } = computePlayerRating({
        seedRating: a.user.seedRating ?? null,
        peerRatings: ratings.map((r) => r.score),
      });
      const pap = a.user.activityPositions.find((p) => p.activityId === match.activityId);
      return {
        id: a.userId,
        name: a.user.name ?? "Unknown",
        positions: pap?.positions ?? [],
        rating,
        image: a.user.image,
      };
    }),
  );

  // Phase 4 — hybrid LLM rating adjuster. LLM reads the last week of
  // group chat and proposes per-player deltas for tonight (sick,
  // tentative, hot streak, rusty). Deltas clamped to [-2, +2] in the
  // adjuster itself. Falls through silently to base ratings on any
  // failure — team generation never blocks on the LLM.
  const adjustments = await runRatingAdjuster({
    matchId: match.id,
    orgId: match.activity.org.id,
    sportName: sport.name,
    matchDate: match.date,
    basePlayers,
  });

  const players: PlayerWithRating[] = basePlayers.map((p) => {
    const adj = adjustments.get(p.id);
    if (!adj || adj.delta === 0) return p;
    const adjusted = Math.max(1, Math.min(10, p.rating + adj.delta));
    return { ...p, rating: adjusted };
  });

  const composition = sport.positionComposition as Record<string, number> | null;
  const result = balanceTeams({
    players,
    perTeam,
    strategy: sport.balancingStrategy as BalancingStrategy,
    composition: composition ?? undefined,
    pinnedToTeam: opts.pinnedToTeam,
  });

  await db.teamAssignment.deleteMany({ where: { matchId } });
  await db.teamAssignment.createMany({
    data: [
      ...result.red.map((p) => ({ matchId, userId: p.id, team: "RED" as const })),
      ...result.yellow.map((p) => ({ matchId, userId: p.id, team: "YELLOW" as const })),
    ],
  });
  await db.match.update({
    where: { id: matchId },
    data: { status: "TEAMS_GENERATED" },
  });

  const [redLabel, yellowLabel] = resolveTeamLabels(match.activity.org, sport);
  const kickoff = formatLondon(match.date, "HH:mm");
  const listFor = (arr: typeof result.red) =>
    arr.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
  const groupPost =
    `⚽ *Teams for tonight* — ${kickoff} at ${match.activity.venue}\n\n` +
    `*${redLabel}*:\n${listFor(result.red)}\n\n` +
    `*${yellowLabel}*:\n${listFor(result.yellow)}\n\n` +
    `Objections? Reply \`swap X Y\` — admin will confirm.`;

  return { ok: true, groupPost, matchId };
}

async function runRatingAdjuster(args: {
  matchId: string;
  orgId: string;
  sportName: string;
  matchDate: Date;
  basePlayers: PlayerWithRating[];
}) {
  const cutoff = new Date(args.matchDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  const recent = await db.analyzedMessage.findMany({
    where: {
      orgId: args.orgId,
      createdAt: { gte: cutoff },
      body: { not: null },
    },
    orderBy: { createdAt: "asc" },
    take: 300,
    select: { authorUserId: true, body: true, createdAt: true },
  });

  const userIds = recent
    .map((r) => r.authorUserId)
    .filter((id): id is string => !!id);
  const userNames = new Map<string, string>();
  if (userIds.length > 0) {
    const users = await db.user.findMany({
      where: { id: { in: [...new Set(userIds)] } },
      select: { id: true, name: true },
    });
    for (const u of users) userNames.set(u.id, u.name ?? "Unknown");
  }

  const messages: AdjusterMessage[] = recent.map((r) => ({
    authorName: r.authorUserId ? userNames.get(r.authorUserId) ?? null : null,
    body: r.body ?? "",
    timestamp: r.createdAt,
  }));

  const adjusterPlayers = args.basePlayers.map((p) => ({
    id: p.id,
    name: p.name,
    baseRating: p.rating,
  }));

  const adjustments = await adjustRatings({
    players: adjusterPlayers,
    messages,
    sportName: args.sportName,
    matchDate: args.matchDate,
  });

  // Persist audit rows. Upsert so re-running team generation for the
  // same match overwrites prior adjustments cleanly.
  for (const adj of adjustments.values()) {
    await db.ratingAdjustment.upsert({
      where: { matchId_userId: { matchId: args.matchId, userId: adj.playerId } },
      create: {
        matchId: args.matchId,
        userId: adj.playerId,
        delta: adj.delta,
        reason: adj.reason,
        confidence: adj.confidence,
      },
      update: {
        delta: adj.delta,
        reason: adj.reason,
        confidence: adj.confidence,
      },
    });
  }

  return adjustments;
}
