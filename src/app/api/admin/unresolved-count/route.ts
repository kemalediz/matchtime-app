import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg, isOrgAdmin } from "@/lib/org";
import { NextResponse } from "next/server";

/**
 * Distinct count of unresolved attendance-relevant pushnames in the
 * last 21 days, for the admin subnav badge (#1 — make silent drops
 * impossible to miss). Cheap: one indexed query + in-memory distinct.
 */
const norm = (s: string) =>
  s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ count: 0 });
  const membership = await getUserOrg(session.user.id);
  if (!membership) return NextResponse.json({ count: 0 });
  if (!(await isOrgAdmin(session.user.id, membership.orgId))) {
    return NextResponse.json({ count: 0 });
  }
  const since = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
  const rows = await db.analyzedMessage.findMany({
    where: {
      orgId: membership.orgId,
      authorUserId: null,
      authorName: { not: null },
      intent: { in: ["in", "out", "replacement_request"] },
      createdAt: { gte: since },
    },
    select: { authorName: true },
  });
  const count = new Set(
    rows.map((r) => norm(r.authorName ?? "")).filter(Boolean),
  ).size;
  return NextResponse.json({ count });
}
