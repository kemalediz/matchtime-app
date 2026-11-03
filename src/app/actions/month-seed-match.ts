"use server";

/**
 * /admin/months, "Who is who on your list" (2026-11-03): an organiser says
 * which member a name on his posted list is. `matchSeedName` checks the
 * organiser, the member and the open draft again; the page is not trusted.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { matchSeedName, type MatchSeedError } from "@/lib/month-seed-match";

export async function matchSeedListName(
  orgId: string,
  proposalId: string,
  ref: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: MatchSeedError }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if ([orgId, proposalId, ref, userId].some((v) => typeof v !== "string" || v === "")) return { ok: false, error: "not-found" };
  const { requireOrgAdmin } = await import("@/lib/org");
  await requireOrgAdmin(session.user.id, orgId);
  const res = await matchSeedName({ orgId, actorUserId: session.user.id, proposalId, ref, userId });
  revalidatePath("/admin/months");
  return res;
}
