/**
 * Links to admin pages, for the DMs MatchTime sends organisers.
 *
 * A bare path such as "/admin/players/phones" is not tappable on WhatsApp,
 * and typed into a browser it lands on a sign-in page an organiser set up
 * over WhatsApp has no password for (2026-09-30, "MT Test"). Every
 * organiser DM that points at an admin page uses `buildAdminLink`: a short
 * sign-in magic link that opens the page, signed in, in the right club.
 *
 * `appUrl` is for text that is not personal (a group post): an absolute
 * URL, never a bare path, and no credential in it.
 */
import { signMagicLinkToken, MAGIC_LINK_TTL } from "./magic-link";
export { appBaseUrl, appUrl } from "./app-url";
import { buildShortMagicLinkUrl } from "./short-link";

/**
 * A signed-in link for ONE admin to ONE page of ONE club. The DM it goes
 * in must be addressed to that user's own phone: the link signs them in.
 */
export async function buildAdminLink(args: {
  userId: string;
  orgId: string;
  nextPath: string;
  ttlSeconds?: number;
}): Promise<string> {
  const { userId, orgId, nextPath } = args;
  if (!nextPath.startsWith("/") || nextPath.startsWith("//")) {
    throw new Error(`[admin-link] not a same-origin path: ${nextPath}`);
  }
  const token = signMagicLinkToken({
    userId,
    purpose: "sign-in",
    nextPath,
    orgId,
    ttlSeconds: args.ttlSeconds ?? MAGIC_LINK_TTL.actionNudge,
  });
  return buildShortMagicLinkUrl(token);
}
