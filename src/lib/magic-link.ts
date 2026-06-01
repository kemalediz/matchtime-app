/**
 * Magic-link tokens — signed short-lived URLs that let a player sign in
 * without a password.
 *
 * Primary use: after a match, the WhatsApp bot DMs each confirmed player a
 * link like `https://matchtime.app/r/<token>`. The token encodes
 * `{ userId, matchId?, purpose, exp }` and is signed with AUTH_SECRET using
 * HS256. Landing on `/r/[token]` verifies, creates a NextAuth session, and
 * forwards the user to the appropriate page (e.g. the rating UI for that
 * match).
 *
 * Uses Node's `crypto` HMAC for a zero-dependency JWT-like compact format:
 *   base64url(payload).base64url(hmac)
 * Short, URL-safe, stateless, no extra lib.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type MagicLinkPurpose = "rate-match" | "sign-in";

export interface MagicLinkPayload {
  userId: string;
  purpose: MagicLinkPurpose;
  matchId?: string; // required for purpose "rate-match"
  /** Optional deep-link path to forward to after sign-in (e.g. "/admin/players").
   *  Must start with "/" and be same-origin — the landing page ignores anything
   *  that doesn't match. Used by admin DMs that link to specific review pages. */
  nextPath?: string;
  exp: number;     // Unix seconds
}

const SECRET_ENV = "AUTH_SECRET";

function getSecret(): string {
  const s = process.env[SECRET_ENV];
  if (!s) throw new Error(`${SECRET_ENV} not set — magic links disabled`);
  // Defensive trim: a stray "\n" inherited from the Vercel dashboard
  // once made sign/verify disagree across environments. Normalise both
  // sides so they always hash the same bytes.
  return s.trim();
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64");
}

export function signMagicLinkToken(payload: Omit<MagicLinkPayload, "exp"> & { ttlSeconds: number }): string {
  const { ttlSeconds, ...rest } = payload;
  const fullPayload: MagicLinkPayload = {
    ...rest,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = b64url(JSON.stringify(fullPayload));
  const sig = b64url(
    createHmac("sha256", getSecret()).update(body).digest(),
  );
  return `${body}.${sig}`;
}

export async function verifyMagicLinkToken(token: string): Promise<MagicLinkPayload | null> {
  try {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;

    const expectedSig = b64url(
      createHmac("sha256", getSecret()).update(body).digest(),
    );
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(b64urlDecode(body).toString("utf8")) as MagicLinkPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Build a full magic-link URL. Uses the canonical production host in prod,
 * or `NEXTAUTH_URL` if set (dev override).
 */
export function buildMagicLinkUrl(token: string): string {
  const base =
    process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? "https://matchtime.ai";
  return `${base}/r/${token}`;
}

/** TTL presets in seconds. */
export const MAGIC_LINK_TTL = {
  rateMatch: 5 * 24 * 60 * 60, // 5 days — matches MoM announcement window
  signIn: 60 * 60,            // 1 hour for ad-hoc sign-in links (interactive)
  // Action nudges (switch-format, cancel, provisional-review) are DMs
  // that sit unread in an admin's chat for hours and must stay clickable
  // until the relevant deadline. The day-before nudges fire ~10:00 and
  // ~18:00 the day before a kickoff, so 48h keeps the link live right up
  // to and a little past kickoff. Kemal 2026-06-01: a switch-format link
  // received 3h earlier was already dead because it used the 1h signIn
  // TTL — the whole point of the nudge is to be actioned later.
  actionNudge: 48 * 60 * 60,  // 48 hours for async DM action links
  // Personal stats links are meant to be a permanent bookmark a player
  // can re-open any time (Kemal 2026-06-01: "magic link that never
  // expires"). 100 years ≈ never. NOTE: this is a long-lived sign-in
  // credential — anyone with the URL can sign in as that player for the
  // life of the link. Acceptable here because it only fronts /profile/
  // stats (read-only personal stats) and the DM goes only to the player.
  permanent: 100 * 365 * 24 * 60 * 60, // ~100 years
};
