/**
 * THE FRIEND LINK'S URL (2026-10-31): `/play/f/<linkId>.<sig>`.
 *
 * The pool's one HMAC (`poolSignature`, AUTH_SECRET) under its own purpose,
 * so a friend link never passes as an offer link or the other way round. It
 * names nothing about anyone: the page reads the link row by id, and
 * whether it is still usable is the row's and the match's state, never the
 * token's.
 */
import { timingSafeEqual } from "node:crypto";
import { poolSignature } from "../pool/offer-token";

export const FRIEND_LINK_PATH_PREFIX = "/play/f/";
const PURPOSE = "friend-link";

export function friendLinkToken(linkId: string): string {
  return `${linkId}.${poolSignature(PURPOSE, linkId)}`;
}

export function friendLinkPath(linkId: string): string {
  return `${FRIEND_LINK_PATH_PREFIX}${friendLinkToken(linkId)}`;
}

/** The link id a token names, or null when it is not one we signed. */
export function friendLinkIdFromToken(token: string): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [id, sig] = parts;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !sig) return null;
  const want = Buffer.from(poolSignature(PURPOSE, id));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}
