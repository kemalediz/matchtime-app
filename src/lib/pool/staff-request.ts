/**
 * Is this /play request from MatchTime staff (2026-11-16)? Staff is
 * `User.isSuperadmin`, the platform owner's own check, never a club's owner
 * or admin. Two questions, with different answers on purpose (round 3 of
 * #607):
 *
 *   isPoolStaffRequest(cookie)   for the page's beacon (`/api/play/visit`):
 *                                the staff cookie, or a staff session. The
 *                                cookie is unsigned, so anyone could set it,
 *                                but it only hides that browser's own
 *                                visits from the counts: harmless if forged.
 *   isPoolStaffSession()         for a sign-up (`/api/play/signup`): a staff
 *                                TEST is kept on the profile for good and
 *                                leaves it out of the pool's statistics,
 *                                so only a VERIFIED staff session makes
 *                                one, never the cookie.
 *
 * A lookup that fails is not staff: a count is never lost, and a sign-up
 * never becomes a staff test, because of it. Never throws.
 */
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { hasPoolStaffCookie, isPoolStaffVisit } from "./visit-rules";

/** The request's session is a MatchTime staff account. Reads no cookie of ours. */
export async function isPoolStaffSession(): Promise<boolean> {
  try {
    const userId = (await auth())?.user?.id;
    return !!userId && (await isSuperadmin(userId));
  } catch (err) {
    console.warn("[pool-funnel] staff check failed, counting:", err instanceof Error ? err.message : err);
    return false;
  }
}

/** `staffCookie`: the request's `mt-staff` cookie value, read by the caller
 *  (`cookies()` belongs to the request, and the beacon checks after it).
 *  For visits only. */
export async function isPoolStaffRequest(staffCookie: string | null | undefined): Promise<boolean> {
  if (hasPoolStaffCookie(staffCookie)) return true;
  return isPoolStaffVisit({ staffCookie, staffSession: await isPoolStaffSession() });
}
