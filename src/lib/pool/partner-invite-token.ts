/**
 * THE PARTNER POOL INVITE'S LINK (2026-11-02): `/play/j/<token>`.
 *
 * The one DM a partner club's player gets after playing for another club
 * through a partner ask (`partner-invite.ts`) carries this link. It went
 * to his own WhatsApp, so holding it stands in for the /play WhatsApp code:
 * the page joins him with no code step.
 *
 * The token is his user id, when it runs out (ms since the epoch, base 36)
 * and the pool's one HMAC (`poolSignature`, AUTH_SECRET) over both under
 * its own purpose, so it is bound to him, cannot be stretched, and never
 * passes as an offer or friend link (or the other way round). It lives
 * `PARTNER_INVITE_LINK_TTL_DAYS`; an expired one names nobody.
 */
import { timingSafeEqual } from "node:crypto";
import { poolSignature } from "./offer-token";

export const PARTNER_INVITE_PATH_PREFIX = "/play/j/";
/** How long the link works after the DM was made. */
export const PARTNER_INVITE_LINK_TTL_DAYS = 14;

const PURPOSE = "pool-partner-invite";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EXP_RE = /^[0-9a-z]{1,12}$/;

export function partnerInviteToken(userId: string, now: Date): string {
  const exp = (now.getTime() + PARTNER_INVITE_LINK_TTL_DAYS * 86_400_000).toString(36);
  return `${userId}.${exp}.${poolSignature(PURPOSE, `${userId}:${exp}`)}`;
}

export function partnerInvitePath(userId: string, now: Date): string {
  return `${PARTNER_INVITE_PATH_PREFIX}${partnerInviteToken(userId, now)}`;
}

export type PartnerInviteTokenRead = { kind: "ok"; userId: string } | { kind: "expired" } | { kind: "invalid" };

/** Whose link this is, or why it is not one: never thrown. */
export function readPartnerInviteToken(token: unknown, now: Date): PartnerInviteTokenRead {
  if (typeof token !== "string" || token.length > 200) return { kind: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 3) return { kind: "invalid" };
  const [userId, exp, sig] = parts;
  if (!ID_RE.test(userId) || !EXP_RE.test(exp) || !sig) return { kind: "invalid" };
  const want = Buffer.from(poolSignature(PURPOSE, `${userId}:${exp}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { kind: "invalid" };
  return now.getTime() < Number.parseInt(exp, 36) ? { kind: "ok", userId } : { kind: "expired" };
}
