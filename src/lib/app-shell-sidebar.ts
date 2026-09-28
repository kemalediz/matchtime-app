export type SessionStatus = "authenticated" | "unauthenticated" | "loading";

/**
 * Whether the app shell renders the signed-in Sidebar for this page.
 *
 * - Auth routes, magic links, join links and onboarding are always
 *   full-bleed: they have their own background.
 * - Public marketing pages (the landing page at `/` and the help guides)
 *   are full-bleed for signed-out visitors, so an empty app sidebar does
 *   not appear next to them. Signed-in users keep the sidebar there.
 * - "loading" counts as signed in, so a signed-in user's hard refresh
 *   does not flash the marketing layout.
 */
export function shouldShowSidebar(pathname: string | null, status: SessionStatus): boolean {
  const isAuthRoute =
    pathname?.startsWith("/login") ||
    pathname?.startsWith("/signup") ||
    pathname?.startsWith("/verify-email");
  const isMagicLink = pathname?.startsWith("/r/");
  const isJoinLink = pathname?.startsWith("/join/");
  const isOnboarding = pathname?.startsWith("/onboarding");

  const isMarketingPath =
    pathname === "/" || pathname === "/help" || !!pathname?.startsWith("/help/");
  const signedOut = status === "unauthenticated";
  const isPublicMarketing = isMarketingPath && signedOut;

  return !isAuthRoute && !isMagicLink && !isJoinLink && !isPublicMarketing && !isOnboarding;
}
