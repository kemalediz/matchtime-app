/**
 * A player's pay link for one match: a bookmark-length sign-in magic link
 * to `/pay/<matchId>`, shortened. The one way to build it, used by the pay
 * link DM (`payment-flow.ts`), the "paid for my mate" reply
 * (`payment-claim.ts`) and the DM Q&A's "how do I pay?" (`dm-qa.ts`).
 * Writes a ShortLink row; sends nothing.
 */
import { MAGIC_LINK_TTL, signMagicLinkToken } from "./magic-link";
import { buildShortMagicLinkUrl } from "./short-link";

export async function buildPayLinkUrl(userId: string, matchId: string): Promise<string> {
  return buildShortMagicLinkUrl(
    signMagicLinkToken({ userId, purpose: "sign-in", nextPath: `/pay/${matchId}`, ttlSeconds: MAGIC_LINK_TTL.bookmark }),
  );
}
