/**
 * THE OFFER'S TAP LINK (slice L5a, 2026-10-24): `/play/offer/<token>`.
 *
 * The token is the offer id and its HMAC (AUTH_SECRET, the secret every
 * signed link here uses), so it needs no column and cannot be guessed or
 * pointed at another offer. It names nothing about the person: the page
 * reads the offer by id. Whether the offer is still open is the offer's
 * own state (`expiresAt`, `outcome`), never the token's.
 *
 * Opening the page never accepts: WhatsApp fetches a link to draw its
 * preview, so the yes is a button on the page (a POST).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const POOL_OFFER_PATH_PREFIX = "/play/offer/";

const SIG_BYTES = 16;

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET not set: pool offer links disabled");
  return s.trim();
}

const b64url = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function sign(offerId: string): string {
  return b64url(createHmac("sha256", secret()).update(`pool-offer:${offerId}`).digest().subarray(0, SIG_BYTES));
}

export function poolOfferToken(offerId: string): string {
  return `${offerId}.${sign(offerId)}`;
}

export function poolOfferPath(offerId: string): string {
  return `${POOL_OFFER_PATH_PREFIX}${poolOfferToken(offerId)}`;
}

/** The offer id a token names, or null when it is not one we signed. */
export function offerIdFromToken(token: string): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [offerId, sig] = parts;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(offerId) || !sig) return null;
  const want = Buffer.from(sign(offerId));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? offerId : null;
}
