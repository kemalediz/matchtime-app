/**
 * POST /admin/staff-mark: the SERVER sets or clears the /play staff cookie
 * (2026-11-16). Called once by `StaffMark` when an /admin page loads.
 *
 * WHY A ROUTE. Until 2026-11-16 the page set the cookie from script, and
 * WebKit (Safari, every iPhone browser) caps a cookie set by script at 7
 * days, so Kemal's iPhone lost the mark every week. A cookie set in a
 * response header keeps its year. A layout cannot set a cookie, so it is a
 * Route Handler (Next's own place for `cookies().set`).
 *
 *   MatchTime staff (`User.isSuperadmin`)  set "mt-staff=2", a year
 *   a signed-in user who is not staff      cleared (the year-long "1" every
 *                                          club organiser got until then too)
 *   nobody signed in, or a failed check    left as it is
 *
 * Always 204, nothing in the body. The cookie is unsigned and holds no
 * secret: a visitor who set it by hand would only hide his own /play
 * visits from the counts (`visit-rules.ts`). It never makes a sign-up a
 * staff test: that needs a verified staff session (round 3 of #607,
 * `/api/play/signup`). Signing out clears it (`/api/auth/signout`).
 */
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { poolStaffCookieClearedOptions, poolStaffCookieOptions } from "@/lib/pool/visit-rules";

const done = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  let staff: boolean;
  try {
    const userId = (await auth())?.user?.id;
    if (!userId) return done();
    staff = await isSuperadmin(userId);
  } catch (err) {
    console.warn("[pool-funnel] staff mark check failed, cookie left as it is:", err instanceof Error ? err.message : err);
    return done();
  }
  const secure = new URL(request.url).protocol === "https:";
  (await cookies()).set(staff ? poolStaffCookieOptions({ secure }) : poolStaffCookieClearedOptions({ secure }));
  return done();
}
