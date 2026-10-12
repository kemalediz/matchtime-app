/**
 * Where a sign-in may send somebody afterwards.
 *
 * `/login?callbackUrl=` is whatever the link says, and anyone can hand an
 * organiser a link. So it is followed only when it is a page of this site
 * that a sign-in may properly land on.
 *
 * IT PARSES, IT DOES NOT PATTERN-MATCH (security review of PR #248). The
 * first version checked prefixes of the raw string and returned the raw
 * string, so `/.//evil.tld`, `/x/..//evil.tld` and `/%2e//evil.tld`
 * passed: each RESOLVES to the path `//evil.tld`, which a browser reads as
 * another host. Now the input is resolved the way a browser resolves it,
 * and what is returned is the CANONICAL `pathname + search + hash`, never
 * what was typed.
 *
 * Refused:
 *   - anything that is not a string, is empty, or is over `MAX_LENGTH`;
 *   - a backslash, a control character, or a slash look-alike (fullwidth,
 *     fraction and division slashes and their backslash cousins) anywhere
 *     in the input;
 *   - anything not starting with exactly one "/";
 *   - anything that resolves off this origin, or to a path holding "//";
 *   - a path whose percent-escapes, decoded (twice over, for a double
 *     encoding), hold a slash, a backslash, a control character or a dot
 *     segment, or are not valid escapes at all;
 *   - DESTINATIONS THAT MUST NEVER BE REACHED THIS WAY, whatever letter
 *     case they are written in:
 *       /r/...     a signed link: following it would sign the browser in
 *                  as whoever that link is for (the review's fix 2: an
 *                  attacker's own live link as the callback);
 *       /login, /signup   the sign-in pages themselves;
 *       /api/...   never a page;
 *       /_next/... build assets.
 *
 * WHO CALLS IT, and what they legitimately pass:
 *   - `verifyPhoneSignIn` (actions/phone-signup.ts) with /login's
 *     `callbackUrl`. That is set by the middleware to the pathname of the
 *     protected page that was asked for (/admin, /admin/settings,
 *     /admin/players, /matches/<id>, /profile/..., /billing/<orgId>,
 *     /finish-setup/<id>, /pay/<matchId>, ...: a pathname only), and by
 *     four pages to a fixed path: /month, /month/collect, /create-org and
 *     /onboarding.
 *   - the Google fallback button on /login, with the same `callbackUrl`.
 *   - `expiredLinkDestination` (expired-link.ts) with a signed link's own
 *     `nextPath` (an admin page, sometimes with a query or a #fragment) or
 *     /matches/<id>/rate.
 * None of them passes a refused destination.
 *
 * Pure, so the rule is unit tested without a request.
 */
const MAX_LENGTH = 512;

/** Stands in for this site's origin. `.invalid` can never be a real host. */
const BASE = "https://matchtime.invalid";

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Characters a reader, or a careless normaliser, takes for "/" or "\". */
const SLASH_LOOKALIKE = /[⁄∕∖⧵⧸﹨／＼]/;
const DOT_SEGMENT = /(^|\/)\.{1,2}(\/|$)/;

const MAX_DECODE_ROUNDS = 4;

const FORBIDDEN_ROOTS = ["/r", "/login", "/signup", "/api", "/_next"];

function underForbiddenRoot(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return FORBIDDEN_ROOTS.some((root) => p === root || p.startsWith(`${root}/`));
}

export function safeCallbackPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_LENGTH) return null;
  if (raw.includes("\\") || CONTROL.test(raw) || SLASH_LOOKALIKE.test(raw)) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;

  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE || url.username || url.password) return null;

  // The path as the browser resolved it, then with its escapes opened,
  // again and again until nothing is left to open (a doubly encoded slash
  // is seen too). Escapes nested deeper than `MAX_DECODE_ROUNDS` are refused.
  let path = url.pathname;
  for (let round = 0; ; round++) {
    if (round > MAX_DECODE_ROUNDS) return null;
    if (!path.startsWith("/") || path.includes("//")) return null;
    if (path.includes("\\") || CONTROL.test(path) || SLASH_LOOKALIKE.test(path)) return null;
    if (round > 0 && DOT_SEGMENT.test(path)) return null;
    if (underForbiddenRoot(path)) return null;
    if (!path.includes("%")) break;
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null;
    }
    // An escape that hid a slash is refused outright: "/a%2fb" is not
    // the page "/a/b", and nothing of ours is addressed that way.
    if (decoded.split("/").length !== path.split("/").length) return null;
    if (decoded === path) break;
    path = decoded;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}
