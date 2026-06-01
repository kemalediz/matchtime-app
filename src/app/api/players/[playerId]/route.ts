import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { loadPlayerSeasonStats } from "@/lib/player-stats";
import { NextResponse } from "next/server";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ playerId: string }> }
) {
  const { playerId } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const player = await db.user.findUnique({
    where: { id: playerId },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      phoneNumber: true,
      activityPositions: {
        select: {
          positions: true,
          activity: {
            select: { id: true, name: true, sportId: true, isActive: true },
          },
        },
      },
    },
  });
  if (!player) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Flatten a `primary activity` view for backward-compat UI that expects `positions: string[]`.
  // Picks the first active activity of the viewer's org.
  const viewerOrg = await getUserOrg(session.user.id);
  let primaryPositions: string[] = [];
  if (viewerOrg) {
    const match = player.activityPositions.find((p) => p.activity.isActive);
    primaryPositions = match?.positions ?? [];
  }

  // Stats come from the SAME org-scoped engine as /profile/stats, so the
  // two pages never disagree. The old inline computation here counted
  // matches/MoM across ALL orgs (Kemal 2026-06-01: showed 35% attendance
  // = 6/17 across every org's matches instead of 6/6 in his own group,
  // and could mis-tally MoM for multi-org players). loadPlayerSeasonStats
  // scopes everything to the viewer's current org.
  const season = viewerOrg ? await loadPlayerSeasonStats(viewerOrg.orgId, playerId) : null;

  return NextResponse.json({
    player: {
      id: player.id,
      name: player.name,
      email: player.email,
      image: player.image,
      phoneNumber: player.phoneNumber,
      positions: primaryPositions, // back-compat — primary active activity
      activityPositions: player.activityPositions,
    },
    stats: {
      matchesPlayed: season?.gamesPlayed ?? 0,
      avgRating: season?.avgRating ?? null,
      momCount: season?.momCount ?? 0,
      attendanceRate: season?.attendanceRate ?? 0,
    },
  });
}
