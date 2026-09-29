import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { loadPlayerSeasonStats } from "@/lib/player-stats";
import { seesAdminFields } from "@/lib/admin-view";
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
            select: { id: true, name: true, sportId: true, isActive: true, orgId: true },
          },
        },
      },
    },
  });
  if (!player) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Club scope (PR #148 review). Anyone other than the player themself
  // may only read a player who is (or was) a member of the viewer's
  // current club; anything else is a 404, so the route cannot be used to
  // probe other clubs' players. Phone and email go to the player
  // themself and to that club's OWNER/ADMIN (or the platform superadmin)
  // only; a plain club-mate sees the name, positions and stats.
  const viewerOrg = await getUserOrg(session.user.id);
  const isSelf = playerId === session.user.id;
  if (!isSelf) {
    if (!viewerOrg) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const shared = await db.membership.findFirst({
      where: { userId: playerId, orgId: viewerOrg.orgId },
      select: { id: true },
    });
    if (!shared) return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const showContact = isSelf || (!!viewerOrg && (await seesAdminFields(session.user.id, viewerOrg.role)));

  // Someone else's positions: the viewer's club's activities only, since
  // another club's activity names and ids are that club's business. The
  // player's own profile keeps every club's, which is their own data and
  // what the /profile position editor lists.
  const clubPositions = isSelf
    ? player.activityPositions
    : player.activityPositions.filter((p) => p.activity.orgId === viewerOrg?.orgId);

  // Flatten a `primary activity` view for backward-compat UI that expects
  // `positions: string[]`: the first active activity of the viewer's club.
  const primaryPositions = clubPositions.find((p) => p.activity.isActive)?.positions ?? [];

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
      image: player.image,
      ...(showContact ? { email: player.email, phoneNumber: player.phoneNumber } : {}),
      positions: primaryPositions, // back-compat: primary active activity
      activityPositions: clubPositions,
    },
    stats: {
      matchesPlayed: season?.gamesPlayed ?? 0,
      avgRating: season?.avgRating ?? null,
      momCount: season?.momCount ?? 0,
      attendanceRate: season?.attendanceRate ?? 0,
    },
  });
}
