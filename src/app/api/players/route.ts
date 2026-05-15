import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const membership = await getUserOrg(session.user.id);
  if (!membership) return NextResponse.json({ error: "No organisation" }, { status: 404 });

  const { searchParams } = new URL(request.url);
  const activityIdParam = searchParams.get("activityId");
  const includeFormer = searchParams.get("includeFormer") === "1";

  // If admin passed a specific activityId, scope positions to THAT activity.
  // Otherwise fall back to the org's primary active activity.
  let targetActivityId: string | null = activityIdParam;
  if (!targetActivityId) {
    const primaryActivity = await db.activity.findFirst({
      where: { orgId: membership.orgId, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    targetActivityId = primaryActivity?.id ?? null;
  } else {
    // Validate the requested activity belongs to the user's org (prevents
    // cross-org sniffing).
    const activity = await db.activity.findFirst({
      where: { id: targetActivityId, orgId: membership.orgId },
      select: { id: true },
    });
    if (!activity) targetActivityId = null;
  }

  const memberships = await db.membership.findMany({
    where: {
      orgId: membership.orgId,
      ...(includeFormer ? {} : { leftAt: null }),
    },
    include: {
      user: {
        include: {
          _count: { select: { attendances: { where: { status: "CONFIRMED" } } } },
          activityPositions: targetActivityId
            ? { where: { activityId: targetActivityId } }
            : false,
        },
      },
    },
    orderBy: { user: { name: "asc" } },
  });

  // Aliases — per-org UserAlias rows for these users. Surfaced on the
  // admin player list so admins can see (and edit) the nickname/short
  // pushname mappings the analyzer uses to resolve ambiguous senders.
  // Populated automatically by mergePlayers but until now was invisible
  // (Kemal flagged 2026-05-15 — couldn't see "ba" → Baki or "Nunu" →
  // Elnur). One findMany + in-memory group-by, cheap.
  const aliasRows = await db.userAlias.findMany({
    where: {
      orgId: membership.orgId,
      userId: { in: memberships.map((m) => m.user.id) },
    },
    select: { userId: true, alias: true, source: true },
    orderBy: { createdAt: "asc" },
  });
  const aliasesByUser = new Map<string, Array<{ alias: string; source: string }>>();
  for (const a of aliasRows) {
    const arr = aliasesByUser.get(a.userId) ?? [];
    arr.push({ alias: a.alias, source: a.source });
    aliasesByUser.set(a.userId, arr);
  }

  const players = memberships.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    email: m.user.email,
    image: m.user.image,
    phoneNumber: m.user.phoneNumber,
    role: m.role,
    positions: m.user.activityPositions?.[0]?.positions ?? [],
    seedRating: m.user.seedRating,
    isActive: m.user.isActive,
    leftAt: m.leftAt ? m.leftAt.toISOString() : null,
    provisionallyAddedAt: m.provisionallyAddedAt ? m.provisionallyAddedAt.toISOString() : null,
    aliases: aliasesByUser.get(m.user.id) ?? [],
    _count: m.user._count,
  }));

  return NextResponse.json({ players, activityId: targetActivityId });
}
