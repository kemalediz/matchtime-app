/**
 * Vercel Web Analytics: what leaves the browser. Page views are counted by
 * `<WebAnalytics />` in the root layout; the one custom event is
 * `POOL_SIGNUP_EVENT`, sent with no properties (no name, phone or postcode).
 *
 * Before anything is sent the URL is cleaned: the query string goes (signed
 * login links, referral codes, callback URLs) and the token in a personal
 * link is replaced by a placeholder, so a link secret never sits in a
 * third party's dashboard.
 */
import type { BeforeSendEvent } from "@vercel/analytics/next";

export const POOL_SIGNUP_EVENT = "pool_signup";

/** Paths whose next segment is a secret or a code: prefix, placeholder. */
const SECRET_SEGMENTS: ReadonlyArray<readonly [string, string]> = [
  ["/r/", "[token]"],
  ["/play/offer/", "[token]"],
  ["/join/", "[code]"],
  ["/finish-setup/", "[sessionId]"],
];

function redactPath(pathname: string): string {
  for (const [prefix, placeholder] of SECRET_SEGMENTS) {
    if (pathname.startsWith(prefix) && pathname.length > prefix.length) {
      const rest = pathname.slice(prefix.length);
      const slash = rest.indexOf("/");
      return prefix + placeholder + (slash === -1 ? "" : rest.slice(slash));
    }
  }
  return pathname;
}

export function redactAnalyticsUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + redactPath(u.pathname);
  } catch {
    return redactPath(url.split(/[?#]/)[0]);
  }
}

export function analyticsBeforeSend(event: BeforeSendEvent): BeforeSendEvent {
  return { ...event, url: redactAnalyticsUrl(event.url) };
}
