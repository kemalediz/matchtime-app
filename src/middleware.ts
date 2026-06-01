import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public routes - no auth check needed. The root path serves the
  // marketing landing page for signed-out visitors and the dashboard
  // for signed-in ones (branching lives in app/page.tsx).
  if (
    pathname === "/" ||
    pathname === "/login" ||
    pathname === "/signup" ||
    pathname === "/verify-email" ||
    pathname === "/sitemap.xml" ||
    pathname === "/robots.txt" ||
    pathname.startsWith("/join/") ||
    pathname.startsWith("/r/") || // magic-link landing page does its own sign-in
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/cron") ||
    pathname.startsWith("/api/whatsapp") ||
    // Wrapped share card is a public image artifact — it must render
    // without a session so it can be shared straight into WhatsApp.
    // Shows only aggregate season stats the bot already posts to the
    // group as leaderboards. Keyed by an opaque cuid.
    pathname.startsWith("/api/wrapped") ||
    // Public brand / icon / social-preview assets must be reachable
    // without a session — they appear on the signed-out landing & login
    // pages and are fetched by social scrapers. (Kemal 2026-06-02: the
    // matcher only excluded favicon.ico, so /icon.svg, /apple-icon.png,
    // /opengraph-image.png and /matchtime-*.svg were 307-redirecting to
    // /login → broken logos on public pages + no social preview.)
    pathname.startsWith("/icon") ||
    pathname.startsWith("/apple-icon") ||
    pathname.startsWith("/opengraph-image") ||
    pathname.startsWith("/twitter-image") ||
    pathname.startsWith("/matchtime-") ||
    pathname === "/manifest.webmanifest"
  ) {
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

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logo.svg|default-avatar.png).*)"],
};
