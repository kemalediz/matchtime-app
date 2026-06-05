/**
 * Short magic links (2026-06-05).
 *
 * Wraps the existing signed magic-link token in a short DB-backed code so
 * the URL we DM is `…/r/k7Qp2m9` (~30 chars) instead of `…/r/<250-char
 * token>`. Deliberately a SEPARATE file from magic-link.ts so the
 * battle-tested sign/verify logic is untouched.
 *
 * SAFETY:
 *   - Legacy long-token links (the token contains a ".") are NOT affected
 *     — the /r page detects them and uses them directly. Every link
 *     already sitting in players' chats keeps working.
 *   - buildShortMagicLinkUrl FALLS BACK to the long URL if the row can't
 *     be written, so a DB hiccup never breaks link generation.
 *   - The code carries no signed data; it's an opaque random secret that
 *     maps to the same expiring, signed token. Same security as before.
 */
import { randomBytes } from "node:crypto";
import { db } from "./db";
import { buildMagicLinkUrl } from "./magic-link";

/** ~11 chars of URL-safe randomness (base64url of 8 bytes, alnum only). */
function genCode(): string {
  return randomBytes(8)
    .toString("base64")
    .replace(/[+/=]/g, "")
    .slice(0, 10) || randomBytes(8).toString("hex").slice(0, 10);
}

/** Pull the `exp` (unix seconds) out of a token's payload, without
 *  verifying — only used to set the row's expiry to match the token. */
function tokenExpiry(token: string): Date {
  try {
    const body = token.split(".")[0];
    const padded = body.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (body.length % 4)) % 4);
    const json = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    if (typeof json.exp === "number" && isFinite(json.exp)) return new Date(json.exp * 1000);
  } catch {
    // fall through
  }
  // Token had no readable exp — keep the code alive a long time so it
  // never dies before the token would. (Permanent-stats links use a
  // ~100-year exp; default to the same ballpark.)
  return new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
}

/**
 * Store `token` under a fresh short code and return the full short URL.
 * On ANY failure, returns the normal (long) magic-link URL so the caller
 * always gets a working link.
 */
export async function buildShortMagicLinkUrl(token: string): Promise<string> {
  try {
    let code = genCode();
    // Vanishingly unlikely collision, but check a few times to be safe.
    for (let i = 0; i < 5; i++) {
      const existing = await db.shortLink.findUnique({ where: { code }, select: { code: true } });
      if (!existing) break;
      code = genCode();
    }
    await db.shortLink.create({ data: { code, token, expiresAt: tokenExpiry(token) } });
    return buildMagicLinkUrl(code);
  } catch (err) {
    console.error("[short-link] create failed — falling back to long URL:", err);
    return buildMagicLinkUrl(token);
  }
}

/**
 * Resolve a short code back to its token. Returns null if unknown or
 * expired. (The token itself is also still verified + expiry-checked
 * downstream by the magic-link provider, so this is belt-and-braces.)
 */
export async function resolveShortLink(code: string): Promise<string | null> {
  const row = await db.shortLink.findUnique({
    where: { code },
    select: { token: true, expiresAt: true },
  });
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row.token;
}
