/**
 * AN EXPIRED SIGNED LINK IS NOT A DEAD END (2026-10).
 *
 * The setup DM's and the reminder's links live 7 days. An organiser who
 * opened one later saw an error card and a button to a bare sign-in page
 * that then took them to the home page, not to where the link was going.
 *
 * Now the /r page sends them to `/login?expired=1&link=<the link>`, and
 * after they have signed in with their own WhatsApp code the server reads
 * the expired link and carries on to the page it was for, in the club it
 * was for.
 *
 * WHAT THE BROWSER IS TOLD BEFORE SIGN-IN: that the link has expired, and
 * nothing else (security review of PR #248, fix 4). Not the page, not the
 * club, not the club's language, not the person: a destination can hold
 * ids (/billing/<orgId>, /finish-setup/<id>, /pay/<matchId>). `link` is
 * the short code or the expired token the visitor already holds.
 *
 * WHAT THE SERVER DOES WITH IT AFTER SIGN-IN (fix 3), in
 * `verifyPhoneSignIn`:
 *   - `resolveExpiredLink` reads it: only a token with OUR signature, well
 *     formed, and past its expiry. It signs nobody in.
 *   - the link is honoured ONLY for the person it was minted for. Anybody
 *     else who signs in with it gets the default page and is not told why.
 *   - its page goes through `safeCallbackPath`; its club rides on the
 *     short sign-in token, so `pinOrgFromMagicLink` runs its membership
 *     check exactly as for a link that still works. Carrying the club in
 *     the query string would be forgeable; this is not.
 */
import { db } from "./db";
import { readExpiredMagicLink, type MagicLinkPayload } from "./magic-link";
import { safeCallbackPath } from "./safe-callback";

/** Longer than any token we mint; a short code is about ten characters. */
const MAX_HANDLE_LENGTH = 2048;

/** A short code or a token: base64url characters and the token's one dot. */
export function isLinkHandle(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0 && raw.length <= MAX_HANDLE_LENGTH && /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?$/.test(raw);
}

/** Where the link was going: the same choice the /r page makes on a good link. */
export function expiredLinkDestination(payload: Pick<MagicLinkPayload, "purpose" | "matchId" | "nextPath">): string | null {
  if (payload.purpose === "rate-match" && payload.matchId) {
    // One path segment, as written: an id is never a path of its own.
    if (!/^[A-Za-z0-9_-]+$/.test(payload.matchId)) return null;
    return safeCallbackPath(`/matches/${payload.matchId}/rate`);
  }
  return safeCallbackPath(payload.nextPath);
}

/**
 * SERVER ONLY. `codeOrToken` is what follows /r/: a short code, or a long
 * token (it holds a "."). The payload of a real link of ours that has
 * expired, else null. Never throws.
 */
export async function resolveExpiredLink(codeOrToken: unknown): Promise<MagicLinkPayload | null> {
  try {
    if (!isLinkHandle(codeOrToken)) return null;
    let token: string = codeOrToken;
    if (!codeOrToken.includes(".")) {
      // Whatever the row's own expiry says: the token decides.
      const row = await db.shortLink.findUnique({ where: { code: codeOrToken }, select: { token: true } });
      if (!row) return null;
      token = row.token;
    }
    return readExpiredMagicLink(token);
  } catch {
    return null;
  }
}

/** The sign-in page for somebody whose link expired: the link is the only thing carried. */
export function expiredLoginPath(codeOrToken: string): string {
  return `/login?expired=1&link=${encodeURIComponent(codeOrToken)}`;
}
