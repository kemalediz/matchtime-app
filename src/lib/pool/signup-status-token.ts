/**
 * THE /play REMINDER'S STATUS TOKEN (2026-10-31). SERVER ONLY.
 *
 * Handed to the browser with a fresh sign-up, kept there with the code
 * (`pending-signup.ts`), and sent back to POST /api/play/signup/status. It is
 * the sign-up's id and an HMAC (AUTH_SECRET, `offer-token.ts`) over the id
 * AND the code, so it needs no column, cannot be guessed, and cannot be
 * pointed at another sign-up or another code. Without it the status check
 * answers "gone" and never reads the database: a guessed code alone learns
 * nothing, so the check is no oracle for confirm codes (which the WhatsApp
 * confirm caps at POOL_CONFIRM.wrongCodesPerDay).
 *
 * The id lets the check tell "confirmed" from "gone" after the code is
 * cleared on confirmation. It is only ever given to the browser that made
 * the sign-up, and nothing public is keyed by a pool profile's id alone.
 */
import { timingSafeEqual } from "node:crypto";
import { poolSignature } from "./offer-token";

const PURPOSE = "pool-signup-status";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function poolSignupStatusToken(profileId: string, code: string): string {
  return `${profileId}.${poolSignature(PURPOSE, `${profileId}:${code}`)}`;
}

/** The sign-up id the token names for this code, or null when we did not sign it. */
export function readPoolSignupStatusToken(token: unknown, code: unknown): string | null {
  if (typeof token !== "string" || typeof code !== "string" || token.length > 200 || code.length > 20) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [id, sig] = parts;
  if (!ID_RE.test(id) || !sig) return null;
  const want = Buffer.from(poolSignature(PURPOSE, `${id}:${code}`));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}
