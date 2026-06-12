import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { resolveTeamLabels } from "@/lib/team-labels";
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

  // Members eligible to be the money collector — must have a phone (so they
  // can receive the "how much?" + confirm-direct DMs). Used by the collector
  // picker in the Payments section.
  const members = await db.membership.findMany({
    where: { orgId: org.id, leftAt: null, user: { phoneNumber: { not: null } } },
    select: { user: { select: { id: true, name: true } } },
    orderBy: { user: { name: "asc" } },
  });

  // Default team labels (what the org falls back to when no override is
  // set) — from the org's first sport, then "Red"/"Yellow". Drives the
  // placeholders in the Team names editor.
  const firstSport = await db.sport.findFirst({
    where: { orgId: org.id },
    select: { teamLabels: true },
    orderBy: { createdAt: "asc" },
  });
  const defaultTeamLabels = resolveTeamLabels(null, firstSport);

  return NextResponse.json({
    id: org.id,
    name: org.name,
    slug: org.slug,
    inviteCode: org.inviteCode,
    whatsappGroupId: org.whatsappGroupId,
    whatsappBotEnabled: org.whatsappBotEnabled,
    memberCount: org._count.memberships,
    // Team-name override (raw — empty array / empty strings mean
    // "use the defaults") + the defaults themselves for placeholders.
    teamLabels: org.teamLabels,
    defaultTeamLabels,
    features: {
      attendance: org.featureAttendance,
      bench: org.featureBench,
      teamBalancing: org.featureTeamBalancing,
      momVoting: org.featureMomVoting,
      playerRating: org.featurePlayerRating,
      reminders: org.featureReminders,
      statsQa: org.featureStatsQa,
      paymentTracking: org.paymentTrackingEnabled,
      paymentCollection: org.paymentCollectionEnabled,
      payByBank: org.payMethodPayByBank,
      payCard: org.payMethodCard,
      payDirect: org.payMethodDirect,
    },
    // Stripe Connect status — drives the "connect bank" button.
    stripeConnected: !!org.stripeConnectAccountId,
    stripeChargesEnabled: org.stripeChargesEnabled,
    // Money collector picker.
    paymentHolderId: org.paymentHolderId,
    members: members.map((m) => ({ id: m.user.id, name: m.user.name })),
  });
}
