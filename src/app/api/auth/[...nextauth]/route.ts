/**
 * Auth.js's own routes, as they were, with one addition (round 2 of #607,
 * 2026-11-16): signing out also clears the /play staff cookie
 * (`mt-staff`, `src/lib/pool/visit-rules.ts`), so Kemal signing in once on
 * someone else's device does not mark that browser as MatchTime staff for a
 * year. Every sign-out in the app (the sidebar, the claim page, the
 * player's erase on /play/manage) is `signOut` from next-auth/react, which
 * POSTs here to /api/auth/signout: the clearing is added to that one
 * answer, Auth.js's own status, body and cookies kept. GET
 * /api/auth/signout only shows a confirmation page and signs nobody out.
 */
import type { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";
import { poolStaffCookieClearedHeader } from "@/lib/pool/visit-rules";

export const GET = handlers.GET;

const isSignOut = (url: URL) => url.pathname.replace(/\/+$/, "") === "/api/auth/signout";

export async function POST(request: NextRequest): Promise<Response> {
  const res = await handlers.POST(request);
  const url = new URL(request.url);
  if (!isSignOut(url)) return res;
  // A fresh Response: Auth.js's may be a redirect with immutable headers.
  const headers = new Headers(res.headers);
  headers.append("set-cookie", poolStaffCookieClearedHeader({ secure: url.protocol === "https:" }));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
