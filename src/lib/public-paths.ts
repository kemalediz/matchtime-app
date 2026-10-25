import { PRIVACY_PATH } from "./privacy-policy";
import { PLAYERS_PAGE_PATH, POOL_API_PREFIX, POOL_PLAY_PATH } from "./pool/paths";

/**
 * The email sign-up pages, retired 2026-10-11 when WhatsApp became the
 * only way in. The pages are deleted; an old link to one is redirected
 * (by src/middleware.ts, before the session check, so it works signed in
 * or out) to the page that does the same job now. Exact paths only.
 */
export function retiredAuthRedirect(pathname: string): string | null {
  if (pathname === "/signup-email") return "/signup";
  if (pathname === "/verify-email") return "/login";
  return null;
}

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
    pathname === "/sitemap.xml" ||
    pathname === "/robots.txt" ||
    // Help guides are linked from the landing page and must be readable
    // before anyone signs up. They render no session data.
    pathname === "/help" ||
    pathname.startsWith("/help/") ||
    // The privacy policy: anyone must be able to read it before signing
    // up or sharing a detail (local player pool slice L0).
    pathname === PRIVACY_PATH ||
    // The website's page for players (2026-10-25), linked from the menu.
    pathname === PLAYERS_PAGE_PATH ||
    // The pricing page (2026-10-25), linked from the menu.
    pathname === "/pricing" ||
    // The local player pool's sign-up (slice L2): a visitor with no club
    // and no session fills it in, and the form posts to /api/play/. The
    // manage page (/play/manage) is NOT public: it needs his session.
    pathname === POOL_PLAY_PATH ||
    pathname.startsWith(POOL_API_PREFIX) ||
    pathname.startsWith("/join/") ||
    pathname.startsWith("/r/") || // magic-link landing page does its own sign-in
    pathname.startsWith("/api/r/") || // short-code to token resolver (code is the secret)
    // A pool offer's tap link (local player pool L5a): the signed token in
    // the path is the access control (src/lib/pool/offer-token.ts, the
    // prefix pinned by its test); opening it changes nothing.
    pathname.startsWith("/play/offer/") ||
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
    // A club's list poster or team sheet (2026-10-14), fetched by the Pi to
    // post in the admin group. The signed, short-lived token in the path is
    // the access control (src/lib/graphic-token.ts); anything else is a 404.
    pathname.startsWith("/api/graphics/") ||
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
