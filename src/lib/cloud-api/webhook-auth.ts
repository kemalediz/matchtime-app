/**
 * THE CLOUD WEBHOOK'S TWO LOCKS (WhatsApp Cloud API plan, PR C5; MDs/
 * whatsapp-cloud-api-plan-2026-11-04.md sections 1 and 5.2). Pure: no
 * database, no network, no clock.
 *
 *   GET   Meta's handshake: `hub.mode=subscribe`, `hub.verify_token` and
 *         `hub.challenge`. The challenge is answered only when the token is
 *         WA_CLOUD_VERIFY_TOKEN. Works whatever the flags say: Kemal
 *         registers the webhook before any flow is switched on.
 *   POST  `X-Hub-Signature-256: sha256=<hex>`, an HMAC SHA256 of the RAW
 *         body keyed with the app secret (WA_CLOUD_APP_SECRET). Checked
 *         before the body is parsed.
 *
 * Both compare in constant time. An unset or blank secret refuses
 * everything. Neither secret is ever logged or returned.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_RE = /^sha256=([0-9a-fA-F]{64})$/;

/** Equal strings, compared in constant time whatever their lengths. */
function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** The challenge to echo back with 200, or null for a 403. */
export function handshakeChallenge(params: URLSearchParams, verifyToken: string | undefined): string | null {
  const expected = (verifyToken ?? "").trim();
  if (!expected) return null;
  const challenge = params.get("hub.challenge");
  if (params.get("hub.mode") !== "subscribe" || !challenge) return null;
  return sameSecret(params.get("hub.verify_token") ?? "", expected) ? challenge : null;
}

/** True only for Meta's signature of exactly these bytes. */
export function validMetaSignature(rawBody: string | Buffer, header: string | null, appSecret: string | undefined): boolean {
  const secret = appSecret ?? "";
  if (!secret.trim()) return false;
  const m = SIGNATURE_RE.exec((header ?? "").trim());
  if (!m) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(m[1], "hex"), expected);
}
