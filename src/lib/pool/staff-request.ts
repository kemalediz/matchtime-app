/**
 * Is this /play request from MatchTime staff (2026-11-16)? The I/O half of
 * `isPoolStaffVisit` (`visit-rules.ts`), shared by the page's beacon
 * (`/api/play/visit`, nothing counted) and the sign-up (`/api/play/signup`,
 * marked a staff test, `PoolProfile.staffTest`).
 *
 * Staff is `User.isSuperadmin`, the platform owner's own check, never a
 * club's owner or admin. The staff cookie decides without a database read;
 * without it, the request's session, if any, is looked up. A lookup that
 * fails is not staff: a count is never lost to the check. Never throws.
 */
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { hasPoolStaffCookie, isPoolStaffVisit } from "./visit-rules";

/** `staffCookie`: the request's `mt-staff` cookie value, read by the caller
 *  (`cookies()` belongs to the request, and the beacon checks after it). */
export async function isPoolStaffRequest(staffCookie: string | null | undefined): Promise<boolean> {
  if (hasPoolStaffCookie(staffCookie)) return true;
  let staffSession = false;
  try {
    const userId = (await auth())?.user?.id;
    staffSession = !!userId && (await isSuperadmin(userId));
  } catch (err) {
    console.warn("[pool-funnel] staff check failed, counting:", err instanceof Error ? err.message : err);
  }
  return isPoolStaffVisit({ staffCookie, staffSession });
}
