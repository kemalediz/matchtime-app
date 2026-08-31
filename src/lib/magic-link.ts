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

const KNOWN_PURPOSES: readonly MagicLinkPurpose[] = ["rate-match", "sign-in"] as const;

export interface MagicLinkPayload {
  userId: string;
  purpose: MagicLinkPurpose;
  matchId?: string; // required for purpose "rate-match"
  /** Optional deep-link path to forward to after sign-in (e.g. "/admin/players").
   *  Must start with "/" and be same-origin — the landing page ignores anything
   *  that doesn't match. Used by admin DMs that link to specific review pages. */
  nextPath?: string;
  exp: number;     // Unix seconds
  /** Issued-at, Unix seconds. Added 2026-08-31 so the verifier can tell
   *  how long a token was minted for and reject anything that outlives
   *  its purpose's policy TTL. Tokens minted before that date have no
   *  `iat` — see LEGACY_TOKEN_SUNSET. */
  iat: number;
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

export function signMagicLinkToken(
  payload: Omit<MagicLinkPayload, "exp" | "iat"> & { ttlSeconds: number },
): string {
  const { ttlSeconds, ...rest } = payload;
  const iat = Math.floor(Date.now() / 1000);
  // Clamp at mint time as well as verify time: a call site asking for a
  // longer life than the purpose allows gets a policy-length link, not a
  // link that silently fails to verify.
  const ttl = Math.min(ttlSeconds, MAX_TTL_BY_PURPOSE[rest.purpose]);
  const fullPayload: MagicLinkPayload = {
    ...rest,
    iat,
    exp: iat + ttl,
  };
  const body = b64url(JSON.stringify(fullPayload));
  const sig = b64url(
    createHmac("sha256", getSecret()).update(body).digest(),
  );
  return `${body}.${sig}`;
}

export interface VerifyMagicLinkOptions {
  /** Purposes the CONSUMER is willing to honour. The magic-link sign-in
   *  provider passes the session-granting set explicitly, so a purpose
   *  added later has to be opted in rather than silently minting
   *  sessions. */
  purposes?: readonly MagicLinkPurpose[];
}

export async function verifyMagicLinkToken(
  token: string,
  opts: VerifyMagicLinkOptions = {},
): Promise<MagicLinkPayload | null> {
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
    const now = Math.floor(Date.now() / 1000);

    // ── Shape: a valid signature is not a licence to skip validation.
    if (typeof payload?.userId !== "string" || !payload.userId) return null;
    if (typeof payload?.exp !== "number" || !isFinite(payload.exp)) return null;
    if (!KNOWN_PURPOSES.includes(payload.purpose)) return null;
    if (payload.purpose === "rate-match" && !payload.matchId) return null;

    // ── Purpose: enforced at the consumer, not just carried along.
    const allowed = opts.purposes ?? KNOWN_PURPOSES;
    if (!allowed.includes(payload.purpose)) return null;

    // ── Expiry.
    if (payload.exp < now) return null;

    // ── Lifetime policy. `iat` is present on everything minted since
    // 2026-08-31; anything older predates the policy and is honoured
    // only until the sunset, so links already sitting in players'
    // WhatsApp chats keep working today but do not live forever.
    // (The old "permanent" preset was ~100 years — effectively an
    // unrevocable sign-in credential.)
    if (typeof payload.iat === "number" && isFinite(payload.iat)) {
      if (payload.exp - payload.iat > MAX_TTL_BY_PURPOSE[payload.purpose]) return null;
    } else if (now >= LEGACY_TOKEN_SUNSET) {
      return null;
    }

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
  // Bookmarkable links: personal stats and pay links, meant to be
  // re-openable long after the DM (Kemal 2026-06-01: "magic link that
  // never expires"). This WAS ~100 years, which made every such DM an
  // unrevocable full-privilege sign-in credential for the life of
  // AUTH_SECRET — an admin's stats link was an admin session. One year
  // keeps the bookmark useful (players are DM'd a fresh link after every
  // match they play) while bounding the blast radius of a leaked URL.
  bookmark: 365 * 24 * 60 * 60,
};

/**
 * Hard ceiling on how long a token of each purpose may live, enforced at
 * BOTH mint and verify time. A token whose payload claims a longer life
 * than this is rejected outright, whatever call site produced it.
 */
export const MAX_TTL_BY_PURPOSE: Record<MagicLinkPurpose, number> = {
  "sign-in": 365 * 24 * 60 * 60, // bookmarkable stats / pay links
  "rate-match": 7 * 24 * 60 * 60, // the 5-day rating window, plus slack
};

/**
 * Tokens minted before the lifetime policy existed carry no `iat`, so
 * their real age is unknowable — including the ~100-year "permanent"
 * stats and pay links already in players' chats. They keep working until
 * this date and are refused afterwards, by which point every active
 * player has been DM'd fresh, policy-bound links. Unix seconds.
 */
export const LEGACY_TOKEN_SUNSET = Math.floor(
  Date.parse("2026-11-30T00:00:00Z") / 1000,
);
