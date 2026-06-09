"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { balanceTeams, type BalancingStrategy } from "@/lib/team-balancer";
import { requireOrgAdmin } from "@/lib/org";
import { PlayerWithRating } from "@/types";
import { revalidatePath } from "next/cache";

async function getPlayerRating(userId: string): Promise<number> {
  const user = await db.user.findUnique({ where: { id: userId } });

  const recentRatings = await db.rating.findMany({
    where: { playerId: userId },
    orderBy: { createdAt: "desc" },
    take: 60,
  });

  // Scale Elo matchRating (1000 = average) onto the 1-10 scale the balancer
  // expects: 1000 → 5.0, 1200 → 6.0, 1400 → 7.0, etc.
  const eloScaled = user ? user.matchRating / 200 : 5.0;

  if (recentRatings.length >= 3) {
    const peerAvg = recentRatings.reduce((sum, r) => sum + r.score, 0) / recentRatings.length;
    // Blend peer perception 50/50 with Elo (actual outcomes). Peer signal
    // reflects "did this player feel impactful?", Elo reflects "did their
    // team win?". Both matter.
    return 0.5 * peerAvg + 0.5 * eloScaled;
  }

  // Early-days: bootstrap from seed rating, nudged by Elo as matches land.
  const base = user?.seedRating ?? 5.0;
  return 0.7 * base + 0.3 * eloScaled;
}

export async function generateTeams(matchId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: { include: { sport: true } },
      attendances: {
        where: { status: "CONFIRMED" },
        include: {
          user: {
            include: {
              activityPositions: true, // we filter by activityId in code
            },
          },
        },
      },
    },
  });
  if (!match) throw new Error("Match not found");

  await requireOrgAdmin(session.user.id, match.activity.orgId);

  const sport = match.activity.sport;
  const perTeam = sport.playersPerTeam;
  const confirmedPlayers = match.attendances;

  if (confirmedPlayers.length < perTeam * 2) {
    throw new Error(`Need ${perTeam * 2} players, only ${confirmedPlayers.length} confirmed`);
  }

  const players: PlayerWithRating[] = await Promise.all(
    confirmedPlayers.map(async (a) => {
      const pap = a.user.activityPositions.find((p) => p.activityId === match.activityId);
      return {
        id: a.userId,
        name: a.user.name ?? "Unknown",
        positions: pap?.positions ?? [],
        rating: await getPlayerRating(a.userId),
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

  await db.teamAssignment.deleteMany({ where: { matchId } });

  const assignments = [
    ...result.red.map((p) => ({ matchId, userId: p.id, team: "RED" as const })),
    ...result.yellow.map((p) => ({ matchId, userId: p.id, team: "YELLOW" as const })),
  ];
  await db.teamAssignment.createMany({ data: assignments });

  await db.match.update({
    where: { id: matchId },
    data: { status: "TEAMS_GENERATED" },
  });

  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

export async function swapPlayers(matchId: string, playerId1: string, playerId2: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: true },
  });
  if (!match) throw new Error("Match not found");

  await requireOrgAdmin(session.user.id, match.activity.orgId);

  const assignment1 = await db.teamAssignment.findUnique({
    where: { matchId_userId: { matchId, userId: playerId1 } },
  });
  const assignment2 = await db.teamAssignment.findUnique({
    where: { matchId_userId: { matchId, userId: playerId2 } },
  });

  if (!assignment1 || !assignment2) throw new Error("Players not assigned to teams");
  if (assignment1.team === assignment2.team) throw new Error("Players are on the same team");

  await db.teamAssignment.update({
    where: { id: assignment1.id },
    data: { team: assignment2.team },
  });
  await db.teamAssignment.update({
    where: { id: assignment2.id },
    data: { team: assignment1.team },
  });

  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

/**
 * Flip the team labels — every RED becomes YELLOW and vice-versa — keeping
 * the exact same player groupings. One-click colour swap so admins never
 * need a DB edit for "swap the colours, keep the same teams" (Kemal
 * 2026-06-09). Mirrors the bot's handleColorSwapIfApplicable.
 */
export async function swapTeamColours(matchId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const match = await db.match.findUnique({ where: { id: matchId }, include: { activity: true } });
  if (!match) throw new Error("Match not found");
  await requireOrgAdmin(session.user.id, match.activity.orgId);

  const assignments = await db.teamAssignment.findMany({ where: { matchId } });
  await db.$transaction(
    assignments.map((a) =>
      db.teamAssignment.update({
        where: { id: a.id },
        data: { team: a.team === "RED" ? "YELLOW" : "RED" },
      }),
    ),
  );
  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

/**
 * Move a single player to the other team. Lets an admin build any line-up
 * by hand (no rebalance) — combined with the page's two-player swap, this
 * covers arbitrary corrections without DB surgery.
 */
export async function movePlayerToOtherTeam(matchId: string, userId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const match = await db.match.findUnique({ where: { id: matchId }, include: { activity: true } });
  if (!match) throw new Error("Match not found");
  await requireOrgAdmin(session.user.id, match.activity.orgId);

  const a = await db.teamAssignment.findUnique({
    where: { matchId_userId: { matchId, userId } },
  });
  if (!a) throw new Error("Player isn't assigned to a team");
  await db.teamAssignment.update({
    where: { id: a.id },
    data: { team: a.team === "RED" ? "YELLOW" : "RED" },
  });
  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

/** Put a confirmed player onto a team (or move them to a specific side).
 *  Used to slot a replacement/bench player into the line-up after a drop,
 *  without regenerating. */
export async function addToTeam(matchId: string, userId: string, team: "RED" | "YELLOW") {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const match = await db.match.findUnique({ where: { id: matchId }, include: { activity: true } });
  if (!match) throw new Error("Match not found");
  await requireOrgAdmin(session.user.id, match.activity.orgId);

  await db.teamAssignment.upsert({
    where: { matchId_userId: { matchId, userId } },
    create: { matchId, userId, team },
    update: { team },
  });
  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

/** Remove a player from the teams entirely — e.g. they dropped after teams
 *  were generated and are still showing in a slot. */
export async function removeFromTeam(matchId: string, userId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const match = await db.match.findUnique({ where: { id: matchId }, include: { activity: true } });
  if (!match) throw new Error("Match not found");
  await requireOrgAdmin(session.user.id, match.activity.orgId);

  await db.teamAssignment.deleteMany({ where: { matchId, userId } });
  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

/**
 * Promote a bench player into the playing squad and onto a team — sets
 * their attendance to CONFIRMED and assigns them to `team`. This is the
 * "move up from bench" admin action (Kemal 2026-06-09: a bench player like
 * Enayem couldn't be slotted in from any admin screen). Dedicated action
 * so the plain addToTeam/removeFromTeam keep their existing behaviour.
 */
export async function promoteFromBench(matchId: string, userId: string, team: "RED" | "YELLOW") {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const match = await db.match.findUnique({ where: { id: matchId }, include: { activity: true } });
  if (!match) throw new Error("Match not found");
  await requireOrgAdmin(session.user.id, match.activity.orgId);

  await db.attendance.upsert({
    where: { matchId_userId: { matchId, userId } },
    create: { matchId, userId, status: "CONFIRMED" },
    update: { status: "CONFIRMED" },
  });
  await db.teamAssignment.upsert({
    where: { matchId_userId: { matchId, userId } },
    create: { matchId, userId, team },
    update: { team },
  });
  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

export async function publishTeams(matchId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: true },
  });
  if (!match) throw new Error("Match not found");

  await requireOrgAdmin(session.user.id, match.activity.orgId);

  await db.match.update({
    where: { id: matchId },
    data: { status: "TEAMS_PUBLISHED" },
  });

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
}
