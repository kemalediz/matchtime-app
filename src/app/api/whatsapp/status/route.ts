import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { formatLondon } from "@/lib/london-time";

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
    return NextResponse.json({ error: "Organisation not found for this group" }, { status: 404 });
  }

  const now = new Date();
  const nextMatch = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      date: { gt: now },
    },
    include: {
      activity: { include: { sport: true } },
      attendances: {
        where: { status: { in: ["CONFIRMED", "BENCH"] } },
        include: { user: { select: { name: true } } },
        orderBy: { position: "asc" },
      },
    },
    orderBy: { date: "asc" },
  });

  if (!nextMatch) {
    return NextResponse.json({ match: null, message: "No upcoming matches" });
  }

  const confirmed = nextMatch.attendances.filter((a) => a.status === "CONFIRMED");
  const bench = nextMatch.attendances.filter((a) => a.status === "BENCH");

  return NextResponse.json({
    match: {
      id: nextMatch.id,
      name: nextMatch.activity.name,
      sport: nextMatch.activity.sport.name,
      date: formatLondon(nextMatch.date, "EEEE d MMMM 'at' HH:mm"),
      venue: nextMatch.activity.venue,
      status: nextMatch.status,
      confirmed: confirmed.length,
      max: nextMatch.maxPlayers,
      remaining: Math.max(0, nextMatch.maxPlayers - confirmed.length),
      deadlinePassed: now > nextMatch.attendanceDeadline,
      confirmedPlayers: confirmed.map((a) => a.user.name),
      benchPlayers: bench.map((a) => a.user.name),
    },
  });
}
