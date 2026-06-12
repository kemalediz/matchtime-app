import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveTeamLabels } from "@/lib/team-labels";
import { NextResponse } from "next/server";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ matchId: string }> }
) {
  const { matchId } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: { include: { sport: true, org: { select: { teamLabels: true } } } },
      attendances: {
        where: { status: { in: ["CONFIRMED", "BENCH"] } },
        include: {
          user: {
            select: {
              id: true, name: true, image: true,
              activityPositions: true, // filtered by activityId in the flatten step
            },
          },
        },
        orderBy: { position: "asc" },
      },
      teamAssignments: {
        include: {
          user: {
            select: {
              id: true, name: true, image: true,
              activityPositions: true,
            },
          },
        },
      },
    },
  });

  if (!match) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Flatten: project each user's positions for THIS match's activity.
  const flatten = (u: {
    id: string; name: string | null; image: string | null;
    activityPositions: { activityId: string; positions: string[] }[];
  }) => {
    const pap = u.activityPositions.find((p) => p.activityId === match.activityId);
    return {
      id: u.id, name: u.name, image: u.image,
      positions: pap?.positions ?? [],
    };
  };

  const flatAttendances = match.attendances.map((a) => ({ ...a, user: flatten(a.user) }));
  const flatTeamAssignments = match.teamAssignments.map((t) => ({ ...t, user: flatten(t.user) }));

  const existingRatings = await db.rating.findMany({
    where: { matchId, raterId: session.user.id },
  });
  const existingMoMVote = await db.moMVote.findUnique({
    where: { matchId_voterId: { matchId, voterId: session.user.id } },
  });

  return NextResponse.json({
    ...match,
    attendances: flatAttendances,
    teamAssignments: flatTeamAssignments,
    existingRatings,
    existingMoMVote,
    // Resolved display labels for the two team slots (org override →
    // sport labels → "Red"/"Yellow"). [0] = RED, [1] = YELLOW.
    teamLabels: resolveTeamLabels(match.activity.org, match.activity.sport),
  });
}
