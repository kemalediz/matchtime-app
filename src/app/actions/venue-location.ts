"use server";

/**
 * The confirm line under a weekly game's venue (/admin/activities):
 * the organiser's "Yes" and "Change" (2026-10-12).
 *
 * Both are for the club's OWNER and ADMINs (and the platform superadmin)
 * only, checked against the activity's own club. They return an outcome
 * rather than throw: Next replaces a thrown server-action message with a
 * generic one in production, and the organiser has to read what to do.
 *
 * Neither changes the venue TEXT, and neither sends anything to WhatsApp.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isOrgAdmin } from "@/lib/org";
import { changeActivityVenue, confirmActivityVenue, type ChangeResult } from "@/lib/venue-location";

async function adminOf(activityId: string): Promise<string | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId || typeof activityId !== "string") return null;
  const activity = await db.activity.findUnique({ where: { id: activityId }, select: { orgId: true } });
  if (!activity) return null;
  return (await isOrgAdmin(userId, activity.orgId)) ? userId : null;
}

/** "Yes": this is the right place. */
export async function confirmVenueLocationAction(activityId: string): Promise<{ ok: boolean }> {
  const userId = await adminOf(activityId);
  if (!userId) return { ok: false };
  const ok = await confirmActivityVenue(activityId, userId);
  revalidatePath("/admin/activities");
  return { ok };
}

/** "Change": a fuller address or a pasted map link. */
export async function changeVenueLocationAction(activityId: string, input: string): Promise<ChangeResult> {
  const userId = await adminOf(activityId);
  if (!userId || typeof input !== "string") return { status: "error" };
  try {
    const res = await changeActivityVenue(activityId, userId, input.slice(0, 2100));
    revalidatePath("/admin/activities");
    return res;
  } catch (err) {
    console.error(`[geocode] activity=${activityId} change failed (${(err as Error)?.name ?? "error"})`);
    return { status: "error" };
  }
}
