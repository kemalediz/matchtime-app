import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isPublicPath, retiredAuthRedirect } from "@/lib/public-paths";

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

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logo.svg|default-avatar.png).*)"],
};
