import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isPublicPath, retiredAuthRedirect } from "@/lib/public-paths";
import { PATHNAME_HEADER } from "@/lib/connect-focus";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Retired email sign-up pages: send an old link somewhere useful. The
  // query string is dropped on purpose (it only ever held an email).
  const retired = retiredAuthRedirect(pathname);
  if (retired) {
    return NextResponse.redirect(new URL(retired, request.url));
  }

  // Public routes: no auth check needed. See src/lib/public-paths.ts.
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Check for session token (JWT strategy uses authjs.session-token)
  const token =
    request.cookies.get("authjs.session-token")?.value ||
    request.cookies.get("__Secure-authjs.session-token")?.value;

  if (!token) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Hand the pathname to the server components: a layout is given none,
  // and the admin layout needs it to send an organiser who has not
  // connected yet back to the connect panel (src/lib/connect-focus.ts).
  // Always SET, so a value the browser sent is never what the page reads.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(PATHNAME_HEADER, pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logo.svg|default-avatar.png).*)"],
};
