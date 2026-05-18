import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const membership = await getUserOrg(session.user.id);
  if (!membership) {
    return NextResponse.json({ error: "No organisation" }, { status: 404 });
  }

  const org = await db.organisation.findUnique({
    where: { id: membership.orgId },
    include: { _count: { select: { memberships: true } } },
  });

  if (!org) {
    return NextResponse.json({ error: "Organisation not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: org.id,
    name: org.name,
    slug: org.slug,
    inviteCode: org.inviteCode,
    whatsappGroupId: org.whatsappGroupId,
    whatsappBotEnabled: org.whatsappBotEnabled,
    memberCount: org._count.memberships,
    features: {
      attendance: org.featureAttendance,
      bench: org.featureBench,
      teamBalancing: org.featureTeamBalancing,
      momVoting: org.featureMomVoting,
      playerRating: org.featurePlayerRating,
      reminders: org.featureReminders,
      statsQa: org.featureStatsQa,
      paymentTracking: org.paymentTrackingEnabled,
    },
  });
}
