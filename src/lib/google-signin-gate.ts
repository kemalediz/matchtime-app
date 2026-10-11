/**
 * Who may be given a session, by provider. This is the Auth.js `signIn`
 * callback (src/lib/auth.ts), in its own module so it is unit tested
 * without booting NextAuth.
 *
 * WhatsApp is the only sign-in the product shows (2026-10-11):
 *
 *   magic-link   the WhatsApp code on /login and /signup, and the links
 *                the bot DMs. Its own `authorize` has already verified
 *                the token and found the user. Allowed.
 *   google       the platform owner's fallback at /login?via=google, for
 *                when the Pi bot is down and no code can be sent. Allowed
 *                ONLY for a Google account already linked to a user (an
 *                `Account` row). Never creates a user, never links by
 *                email.
 *   anything else  refused.
 *
 * Why the Google rule needs code: with the Prisma adapter, Auth.js
 * answers an unknown Google account by creating a User and an Account.
 * The `signIn` callback runs before that step, so refusing here means
 * nothing is written. Returning a URL (rather than false) sends the
 * visitor back to the fallback page with a reason it can show.
 */
import { db } from "./db";

export const GOOGLE_NOT_LINKED_URL = "/login?via=google&error=not-linked";

interface GateParams {
  account?: { provider?: string; providerAccountId?: string; type?: string } | null;
  // Present on the real callback; deliberately never read. Only the
  // stored link decides.
  user?: unknown;
  profile?: unknown;
}

export async function gateSignIn({ account }: GateParams): Promise<boolean | string> {
  if (account?.provider === "magic-link") return true;
  if (account?.provider !== "google") return false;

  const providerAccountId = account.providerAccountId;
  if (!providerAccountId) return GOOGLE_NOT_LINKED_URL;
  try {
    const linked = await db.account.findUnique({
      where: { provider_providerAccountId: { provider: "google", providerAccountId } },
      select: { userId: true },
    });
    return linked ? true : GOOGLE_NOT_LINKED_URL;
  } catch (err) {
    console.error("[auth] Google link lookup failed; refusing the sign-in.", err);
    return GOOGLE_NOT_LINKED_URL;
  }
}
