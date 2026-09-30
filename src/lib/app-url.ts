/**
 * Absolute URLs on the app's own host, for text that is not personal (a
 * group post, a public help line): never a bare path, which WhatsApp does
 * not make tappable, and never a credential. Pure: no DB, no crypto, so a
 * copy module can import it. Signed-in links for one admin are
 * `buildAdminLink` in `admin-link.ts`.
 */

/** The app's own origin, without a trailing slash. */
export function appBaseUrl(): string {
  return (process.env.NEXTAUTH_URL?.trim() || "https://matchtime.ai").replace(/\/+$/, "");
}

/** An absolute URL on the app's host for a same-origin path. */
export function appUrl(path: string): string {
  return `${appBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
