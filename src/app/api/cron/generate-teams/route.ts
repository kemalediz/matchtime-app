import { db } from "@/lib/db";
import { balanceTeams, type BalancingStrategy } from "@/lib/team-balancer";
import { PlayerWithRating } from "@/types";
import { NextResponse } from "next/server";
import { completeFinishedMatches } from "@/lib/match-completion";
import { getOrgFeatures } from "@/lib/org-features";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // Find matches past deadline that need team generation.
  const matches = await db.match.findMany({
    where: {
      status: "UPCOMING",
      attendanceDeadline: { lte: now },
    },
    include: {
      activity: { include: { sport: true } },
      attendances: {
        where: { status: "CONFIRMED" },
        include: {
          user: {
            include: { activityPositions: true },
          },
        },
      },
    },
  });

  let generated = 0;
  let skippedNoTeamBalancing = 0;

  for (const match of matches) {
    // Skip orgs that have team-balancing turned off — they pick teams
    // manually in the group. Without this gate, a fully-attended
    // MoM-only org (e.g. Amir's Thursday group via squad-from-list)
    // would silently get TeamAssignment rows that never reach the
    // group (the bot-scheduler post-compute filter drops match-teams
    // posts), polluting the DB.
    const features = await getOrgFeatures(match.activity.orgId);
    if (!features.teamBalancing) {
      skippedNoTeamBalancing++;
      continue;
    }

    const sport = match.activity.sport;
    const perTeam = sport.playersPerTeam;
    if (match.attendances.length < perTeam * 2) continue;

    const players: PlayerWithRating[] = await Promise.all(
      match.attendances.map(async (a) => {
        const ratings = await db.rating.findMany({
          where: { playerId: a.userId },
          orderBy: { createdAt: "desc" },
          take: 60,
        });
        const avgRating =
          ratings.length >= 3
            ? ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length
            : a.user.seedRating ?? 5.0;

        const pap = a.user.activityPositions.find((p) => p.activityId === match.activityId);

        return {
          id: a.userId,
          name: a.user.name ?? "Unknown",
          positions: pap?.positions ?? [],
          rating: avgRating,
          image: a.user.image,
        };
      })
    );

    const composition = sport.positionComposition as Record<string, number> | null;
    const result = balanceTeams({
      players,
      perTeam,
      strategy: sport.balancingStrategy as BalancingStrategy,
      composition: composition ?? undefined,
    });

    await db.teamAssignment.deleteMany({ where: { matchId: match.id } });
    await db.teamAssignment.createMany({
      data: [
        ...result.red.map((p) => ({ matchId: match.id, userId: p.id, team: "RED" as const })),
        ...result.yellow.map((p) => ({ matchId: match.id, userId: p.id, team: "YELLOW" as const })),
      ],
    });

    await db.match.update({
      where: { id: match.id },
      data: { status: "TEAMS_GENERATED" },
    });

    generated++;
  }

  // Auto-publish teams generated more than 1 hour ago.
  const autoPublishCutoff = new Date(now.getTime() - 60 * 60 * 1000);
  const toPublish = await db.match.findMany({
    where: {
      status: "TEAMS_GENERATED",
      updatedAt: { lte: autoPublishCutoff },
    },
  });

  let published = 0;
  for (const match of toPublish) {
    await db.match.update({
      where: { id: match.id },
      data: { status: "TEAMS_PUBLISHED" },
    });
    published++;
  }

  // Auto-complete matches whose duration has expired. The actual logic
  // lives in `src/lib/match-completion.ts` and is also called every
  // 15 min by `/api/cron/complete-matches` (which is the primary
  // trigger — that gives ~20 min end-to-end from whistle to post-match
  // bot post). Calling it here too keeps the daily generate-teams as
  // a backstop; the helper is idempotent.
  const { completed } = await completeFinishedMatches(now);

  return NextResponse.json({ generated, published, completed, skippedNoTeamBalancing });
}
