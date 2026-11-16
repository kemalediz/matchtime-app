/**
 * Auth.js's own routes, as they were, with one addition (round 2 of #607,
 * 2026-11-16): a sign-out also clears the /play staff cookie (`mt-staff`,
 * `src/lib/pool/visit-rules.ts`), so Kemal signing in once on someone
 * else's device does not mark that browser as MatchTime staff for a year.
 * Every sign-out in the app (the sidebar, the claim page, the player's
 * erase on /play/manage) is `signOut` from next-auth/react, which POSTs
 * here to /api/auth/signout.
 *
 * ONLY A REAL SIGN-OUT (round 3): the clearing is added only when Auth.js's
 * answer clears the session cookie itself (`signOutClearedSession`), which
 * it does on a sign-out that happened and on nothing else. A refused one
 * (no CSRF token: a 302 to /login?error=...), or one with nobody signed in,
 * is passed through untouched. Auth.js's status, body and cookies are kept;
 * a fresh Response is built, never Auth.js's headers edited (a redirect's
 * are immutable). GET /api/auth/signout only shows a confirmation page and
 * signs nobody out.
 */
import type { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";
import { signOutClearedSession } from "@/lib/auth-signout";
import { poolStaffCookieClearedHeader } from "@/lib/pool/visit-rules";

export const GET = handlers.GET;

const isSignOut = (url: URL) => url.pathname.replace(/\/+$/, "") === "/api/auth/signout";

export async function POST(request: NextRequest): Promise<Response> {
  const res = await handlers.POST(request);
  const url = new URL(request.url);
  if (!isSignOut(url) || !signOutClearedSession(res.headers.getSetCookie())) return res;
  const headers = new Headers(res.headers);
  headers.append("set-cookie", poolStaffCookieClearedHeader({ secure: url.protocol === "https:" }));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
