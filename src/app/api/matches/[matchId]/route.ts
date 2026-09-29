import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isSuperadmin } from "@/lib/org";
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
      activity: { include: { sport: true, org: { select: { teamLabels: true, language: true } } } },
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

  // Club scope (PR #148 review audit). Only someone who is or was a
  // member of the match's club (a left member can still hold a rating
  // link) or the platform superadmin may read it; to anyone else the
  // match does not exist. It used to be any signed-in user, any club.
  const viewerMembership = await db.membership.findFirst({
    where: { userId: session.user.id, orgId: match.activity.orgId },
    select: { id: true },
  });
  if (!viewerMembership && !(await isSuperadmin(session.user.id))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

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

  // Attendance rows go out WITHOUT their payment fields (amount, method,
  // Stripe session id, who paid or confirmed a cash payment). No page
  // that reads this route uses them, and the rate page is member-facing.
  const flatAttendances = match.attendances.map((a) => ({
    id: a.id,
    matchId: a.matchId,
    userId: a.userId,
    status: a.status,
    position: a.position,
    respondedAt: a.respondedAt,
    user: flatten(a.user),
  }));
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
    // Resolved display labels for the two team slots (per-match override →
    // org override → sport labels → "Red"/"Yellow"). [0] = RED, [1] = YELLOW.
    // NOTE: this overwrites the raw `match.teamLabels` scalar spread from
    // `...match` above (intentional — clients read the resolved pair here).
    teamLabels: resolveTeamLabels(match, match.activity.org, match.activity.sport, match.activity.org.language),
  });
}
