/**
 * Bot hits this endpoint when someone in the group replies with a score
 * like "7-3" to the "what was the final score?" prompt.
 *
 * Strategy:
 *  - Only accept score submissions from a user who is a confirmed
 *    participant of the match (or org admin).
 *  - Apply to the most recent match in the org that has already ended
 *    (match.date + activity.matchDurationMins ≤ now) and has no score
 *    recorded yet. This avoids ambiguity when there's a single in-flight
 *    match to score.
 *  - Use the same update path as admin's manual entry so the Elo Elo
 *    delta is computed and match-end flow triggers fire.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { computeEloDeltas } from "@/lib/elo";
import { applyMembershipEloDeltas, loadMembershipEloInputs } from "@/lib/membership-elo";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { fromPhone, redScore, yellowScore, groupId } = body as {
    fromPhone: string;
    redScore: number;
    yellowScore: number;
    groupId: string;
  };
  if (!fromPhone || redScore === undefined || yellowScore === undefined || !groupId) {
    return NextResponse.json(
      { error: "fromPhone, redScore, yellowScore, groupId required" },
      { status: 400 },
    );
  }
  if (!Number.isFinite(redScore) || !Number.isFinite(yellowScore) || redScore < 0 || yellowScore < 0) {
    return NextResponse.json({ error: "Scores must be non-negative numbers" }, { status: 400 });
  }

  const org = await db.organisation.findFirst({ where: { whatsappGroupId: groupId } });
  if (!org) return NextResponse.json({ error: "Organisation not found" }, { status: 404 });

  const normalised = normalisePhone(fromPhone);
  if (!normalised) return NextResponse.json({ error: "Bad phone" }, { status: 400 });

  const user = await db.user.findUnique({ where: { phoneNumber: normalised } });
  if (!user) {
    return NextResponse.json(
      { error: "unknown_player", message: `Phone ${normalised} not registered.` },
      { status: 404 },
    );
  }

  // Find the most recent match in this org that's ended but unscored.
  const now = new Date();
  const candidates = await db.match.findMany({
    where: {
      activity: { orgId: org.id },
      redScore: null,
      yellowScore: null,
      status: { in: ["TEAMS_PUBLISHED", "COMPLETED", "TEAMS_GENERATED"] },
    },
    include: {
      activity: true,
      teamAssignments: { select: { userId: true, team: true } },
    },
    orderBy: { date: "desc" },
    take: 10,
  });
  const target = candidates.find((m) => {
    const endedAt = new Date(m.date.getTime() + m.activity.matchDurationMins * 60 * 1000);
    return endedAt <= now;
  });

  if (!target) {
    return NextResponse.json(
      { error: "no_match", message: "No recently-ended match waiting for a score." },
      { status: 404 },
    );
  }

  // Authorise: user must be a confirmed participant OR org admin.
  const attendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId: target.id, userId: user.id } },
  });
  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId: user.id, orgId: org.id } },
  });
  const isAdmin = membership && (membership.role === "OWNER" || membership.role === "ADMIN");
  const wasPlaying = attendance?.status === "CONFIRMED";
  if (!isAdmin && !wasPlaying) {
    return NextResponse.json(
      { error: "forbidden", message: "Only players from this match or admins can record the score." },
      { status: 403 },
    );
  }

  // Persist score + flip to COMPLETED.
  await db.match.update({
    where: { id: target.id },
    data: { redScore, yellowScore, status: "COMPLETED" },
  });

  // Apply Elo deltas onto THIS club's memberships. `org` is already
  // resolved from the request, and the match was selected by
  // `activity: { orgId: org.id }` above, so the two cannot disagree.
  // See lib/membership-elo.ts.
  try {
    const { inputs } = await loadMembershipEloInputs({
      orgId: org.id,
      assignments: target.teamAssignments,
    });
    const deltas = computeEloDeltas(inputs, redScore, yellowScore);
    await applyMembershipEloDeltas({ orgId: org.id, deltas });
  } catch (err) {
    console.error("Elo update failed after WhatsApp score submission:", err);
  }

  return NextResponse.json({
    ok: true,
    matchId: target.id,
    activity: target.activity.name,
    redScore,
    yellowScore,
  });
}
