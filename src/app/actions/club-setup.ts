"use server";

/**
 * GOING LIVE FROM THE WEBSITE (go-live slice S4, 2026-10-12). The Go live
 * button on the settings page, and the MatchTime owner's "Go live now" on
 * the clubs page, both end here. No UI in this slice: slice S5 builds the
 * banner and the buttons on top of these two actions.
 *
 * Each is a thin, admin-gated wrapper round the single writer,
 * `goLiveClub` (src/lib/club-setup.ts), the same one the organiser's GO by
 * WhatsApp calls, so the two doors can never disagree and a race between
 * them gives one hello: the loser is told "already-live".
 *
 * Gate: `requireOrgAdmin`, the check every other club action uses (a
 * current owner or admin of the club, or the MatchTime owner).
 *
 * "use server" modules may export async functions only (see
 * __tests__/platform-jobs-source-guard.test.ts).
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireOrgAdmin } from "@/lib/org";
import { goLiveClub, helloPreviewForClub, liveByOwner, liveByUser, type GoLiveResult } from "@/lib/club-setup";

async function requireClubAdmin(orgId: string): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
  return session.user.id;
}

/**
 * Take a club that is setting up live. Returns the same outcomes as the
 * WhatsApp GO: "went-live", "already-live" (with who and when),
 * "still-reading", "removed-from-group", "not-setting-up".
 */
export async function goLiveClubAction(orgId: string): Promise<GoLiveResult> {
  const userId = await requireClubAdmin(orgId);
  // The club's own owner or admin is recorded by user id. Anybody else who
  // passed the gate is the MatchTime owner acting for the club.
  const own = await db.membership.findFirst({
    where: { userId, orgId, leftAt: null, role: { in: ["OWNER", "ADMIN"] } },
    select: { id: true },
  });
  // The hello names whoever connected the club (the loader's default).
  const result = await goLiveClub(orgId, own ? liveByUser(userId) : liveByOwner(userId));
  revalidatePath("/admin/settings");
  revalidatePath("/admin/clubs");
  return result;
}

/**
 * The hello this club's group would get if it went live now, for the
 * banner's preview. Built from the club's settings at this moment.
 */
export async function helloPreviewAction(orgId: string): Promise<string> {
  await requireClubAdmin(orgId);
  return helloPreviewForClub(orgId);
}
