/**
 * Returns every Membership for the signed-in user (excluding ones marked
 * as left) plus the current active orgId. Used by the sidebar OrgSwitcher.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCurrentOrgId, getUserOrg, isSuperadmin } from "@/lib/org";
import { connectFocusFor } from "@/lib/connect-focus-server";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberships = await db.membership.findMany({
    where: { userId: session.user.id, leftAt: null },
    include: { org: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: "asc" },
  });

  const userId = session.user.id;
  const [currentOrgId, superadmin, connectFocus] = await Promise.all([
    getCurrentOrgId(),
    isSuperadmin(userId),
    // "Finish connecting" mode for the selected club: the sidebar leaves
    // out the links that lead nowhere useful yet (src/lib/connect-focus.ts).
    getUserOrg(userId).then((m) => connectFocusFor(userId, m)),
  ]);

  return NextResponse.json({
    memberships: memberships.map((m) => ({
      id: m.id,
      role: m.role,
      org: m.org,
    })),
    currentOrgId,
    isSuperadmin: superadmin,
    connectFocus,
  });
}
