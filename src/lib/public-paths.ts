/**
 * Routes a signed-out visitor may open without being sent to /login.
 * Used by src/middleware.ts; kept here as a pure function so it can be
 * unit tested without a request object.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    // The root path serves the marketing landing page for signed-out
    // visitors and the dashboard for signed-in ones (branching lives in
    // app/page.tsx).
    pathname === "/" ||
    pathname === "/login" ||
    pathname === "/signup" ||
    pathname === "/verify-email" ||
    pathname === "/sitemap.xml" ||
    pathname === "/robots.txt" ||
    // Help guides are linked from the landing page and must be readable
    // before anyone signs up. They render no session data.
    pathname === "/help" ||
    pathname.startsWith("/help/") ||
    pathname.startsWith("/join/") ||
    pathname.startsWith("/r/") || // magic-link landing page does its own sign-in
    pathname.startsWith("/api/r/") || // short-code to token resolver (code is the secret)
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/cron") ||
    pathname.startsWith("/api/whatsapp") ||
    // Wrapped share card is a public image artifact: it must render
    // without a session so it can be shared straight into WhatsApp.
    // Shows only aggregate season stats the bot already posts to the
    // group as leaderboards. Keyed by an opaque cuid.
    pathname.startsWith("/api/wrapped") ||
    // Badge share card: same model as Wrapped (public image, opaque cuid,
    // shared into WhatsApp). The route 404s unless the badge is EARNED at
    // a club the player is in, and shows no rating (src/lib/badge-card.ts).
    pathname.startsWith("/api/badge-card/") ||
    // Public brand / icon / social-preview assets must be reachable
    // without a session: they appear on the signed-out landing & login
    // pages and are fetched by social scrapers. (Kemal 2026-06-02: the
    // matcher only excluded favicon.ico, so /icon.svg, /apple-icon.png,
    // /opengraph-image.png and /matchtime-*.svg were 307-redirecting to
    // /login, giving broken logos on public pages + no social preview.)
    pathname.startsWith("/icon") ||
    pathname.startsWith("/apple-icon") ||
    pathname.startsWith("/opengraph-image") ||
    pathname.startsWith("/twitter-image") ||
    pathname.startsWith("/matchtime-") ||
    pathname === "/manifest.webmanifest" ||
    // Stripe webhook is server-to-server (Stripe's signature is the auth).
    pathname.startsWith("/api/stripe")
  );
}
