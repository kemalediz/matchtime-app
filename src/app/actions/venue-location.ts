"use server";

/**
 * The confirm line under a weekly game's venue (/admin/activities):
 * the organiser's "Yes", "Change" and "Try again" (2026-10-12).
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
import {
  changeActivityVenue,
  changeActivityVenueToPick,
  confirmActivityVenue,
  resolveActivityVenueSafe,
  type ChangeResult,
} from "@/lib/venue-location";
import { parseVenuePick } from "@/lib/venue-suggest-rules";

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

/**
 * "Change": a fuller address, a pasted map link, or (2026-10-13) a place
 * picked from the suggestions in the Change box.
 *
 * `venuePick` is Google's place id and the suggestions' session token,
 * and nothing else is read from it: the server asks Google what the
 * place is. If Google does not resolve it, the typed words are looked up
 * exactly as if nothing had been picked.
 */
export async function changeVenueLocationAction(
  activityId: string,
  input: string,
  venuePick?: { placeId: string; sessionToken?: string | null } | null,
): Promise<ChangeResult> {
  const userId = await adminOf(activityId);
  if (!userId || typeof input !== "string") return { status: "error" };
  try {
    const pick = parseVenuePick(venuePick);
    if (pick) {
      const picked = await changeActivityVenueToPick(activityId, userId, pick);
      if (picked.status !== "unresolved") {
        revalidatePath("/admin/activities");
        return { status: picked.status };
      }
    }
    const res = await changeActivityVenue(activityId, userId, input.slice(0, 2100));
    revalidatePath("/admin/activities");
    return res;
  } catch (err) {
    console.error(`[geocode] activity=${activityId} change failed (${(err as Error)?.name ?? "error"})`);
    return { status: "error" };
  }
}

/**
 * "Try again": the lookup of the venue text could not be made earlier
 * (Google failed or timed out, or the club's daily lookups were used up).
 * Run it now, inside the cap like any other lookup. It answers within the
 * lookup's own 2.5 second limit, and the page reloads to show what it
 * came to.
 */
export async function retryVenueLookupAction(activityId: string): Promise<{ ok: boolean }> {
  const userId = await adminOf(activityId);
  if (!userId) return { ok: false };
  const res = await resolveActivityVenueSafe(activityId);
  revalidatePath("/admin/activities");
  return { ok: res.status === "found" || res.status === "not-found" || res.status === "skipped" };
}
