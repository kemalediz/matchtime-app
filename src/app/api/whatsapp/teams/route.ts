import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { format } from "date-fns";
import { resolveTeamLabels } from "@/lib/team-labels";

export async function GET(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const groupId = searchParams.get("groupId");
  if (!groupId) {
    return NextResponse.json({ error: "groupId required" }, { status: 400 });
  }

  const org = await db.organisation.findFirst({ where: { whatsappGroupId: groupId } });
  if (!org) {
    return NextResponse.json({ error: "Organisation not found" }, { status: 404 });
  }

  const match = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      status: { in: ["TEAMS_PUBLISHED", "COMPLETED"] },
    },
    include: {
      activity: { include: { sport: true } },
      teamAssignments: {
        include: {
          user: {
            select: { name: true, activityPositions: true },
          },
        },
      },
    },
    orderBy: { date: "desc" },
  });

  if (!match || match.teamAssignments.length === 0) {
    return NextResponse.json({ teams: null, message: "No teams published yet" });
  }

  const positionFor = (u: { activityPositions: { activityId: string; positions: string[] }[] }) => {
    const pap = u.activityPositions.find((p) => p.activityId === match.activityId);
    return pap?.positions[0] ?? null;
  };

  const red = match.teamAssignments
    .filter((a) => a.team === "RED")
    .map((a) => ({ name: a.user.name, position: positionFor(a.user) }));
  const yellow = match.teamAssignments
    .filter((a) => a.team === "YELLOW")
    .map((a) => ({ name: a.user.name, position: positionFor(a.user) }));

  const [redLabel, yellowLabel] = resolveTeamLabels(org, match.activity.sport);

  return NextResponse.json({
    match: {
      name: match.activity.name,
      date: format(match.date, "EEEE d MMMM 'at' HH:mm"),
    },
    teams: {
      [redLabel.toLowerCase()]: red,
      [yellowLabel.toLowerCase()]: yellow,
      // Also expose with fixed keys for bot backward-compat:
      red,
      yellow,
    },
  });
}
