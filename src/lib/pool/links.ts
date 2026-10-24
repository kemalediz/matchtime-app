/**
 * The pool's personal link (slice L2): his manage page, as a short signed
 * sign-in link (`magic-link.ts` + `short-link.ts`, reused as they are),
 * bookmarkable for a year like a stats or pay link. Tapping it signs him in
 * and lands on /play/manage, where one tap pauses, stops or deletes.
 */
import { MAGIC_LINK_TTL, signMagicLinkToken } from "../magic-link";
import { buildShortMagicLinkUrl } from "../short-link";
import { POOL_MANAGE_PATH } from "./paths";

export async function buildPoolManageLink(userId: string): Promise<string> {
  const token = signMagicLinkToken({ userId, purpose: "sign-in", nextPath: POOL_MANAGE_PATH, ttlSeconds: MAGIC_LINK_TTL.bookmark });
  return buildShortMagicLinkUrl(token);
}
