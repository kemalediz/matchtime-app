/**
 * Returns every Membership for the signed-in user (excluding ones marked
 * as left) plus the current active orgId. Used by the sidebar OrgSwitcher.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCurrentOrgId, isSuperadmin } from "@/lib/org";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberships = await db.membership.findMany({
    where: { userId: session.user.id, leftAt: null },
    include: { org: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: "asc" },
  });

  const [currentOrgId, superadmin] = await Promise.all([
    getCurrentOrgId(),
    isSuperadmin(session.user.id),
  ]);

  return NextResponse.json({
    memberships: memberships.map((m) => ({
      id: m.id,
      role: m.role,
      org: m.org,
    })),
    currentOrgId,
    isSuperadmin: superadmin,
  });
}
