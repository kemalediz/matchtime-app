/**
 * Magic-link token security.
 *
 * These pin the authority model of the signed links we DM to players:
 *   - the signature and `exp` are honoured (regression cover for what
 *     already worked);
 *   - `purpose` is ENFORCED by the consumer, not just carried along —
 *     a token minted to rate a match cannot be presented where only a
 *     sign-in token is accepted;
 *   - no purpose may outlive its policy TTL, however long the minting
 *     call site asked for (the old `permanent` preset was ~100 years,
 *     i.e. an unrevocable sign-in credential);
 *   - legacy tokens minted before the policy existed (no `iat`) keep
 *     working, but only until a fixed sunset date — so links already
 *     sitting in players' chats don't break today, and don't live
 *     forever either.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";

const SECRET = "unit-test-secret";

beforeAll(() => {
  process.env.AUTH_SECRET = SECRET;
});

afterEach(() => {
  vi.useRealTimers();
});

import {
  signMagicLinkToken,
  verifyMagicLinkToken,
  MAGIC_LINK_TTL,
  MAX_TTL_BY_PURPOSE,
  LEGACY_TOKEN_SUNSET,
  type MagicLinkPayload,
} from "@/lib/magic-link";

const DAY = 24 * 60 * 60;

/** Mint a token with an arbitrary (possibly illegal) payload, signed with
 *  the real secret — this is what an old deploy, or a bug at a call site,
 *  would have produced. */
function forge(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const sig = createHmac("sha256", SECRET)
    .update(body)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${body}.${sig}`;
}

function decode(token: string): MagicLinkPayload {
  const body = token.split(".")[0];
  const padded = body.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (body.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

describe("magic-link: signature + expiry (regression)", () => {
  it("verifies a freshly minted sign-in token", async () => {
    const t = signMagicLinkToken({ userId: "u1", purpose: "sign-in", ttlSeconds: 3600 });
    const p = await verifyMagicLinkToken(t);
    expect(p?.userId).toBe("u1");
    expect(p?.purpose).toBe("sign-in");
  });

  it("rejects a token whose exp has passed", async () => {
    const t = signMagicLinkToken({ userId: "u1", purpose: "sign-in", ttlSeconds: -60 });
    expect(await verifyMagicLinkToken(t)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const t = signMagicLinkToken({ userId: "u1", purpose: "sign-in", ttlSeconds: 3600 });
    const swapped = forge({ ...decode(t), userId: "victim" });
    // A signature that doesn't match the body is refused …
    expect(await verifyMagicLinkToken(`${t.split(".")[0]}.deadbeef`)).toBeNull();
    // … and so is a swapped body carrying the original signature.
    expect(await verifyMagicLinkToken(`${swapped.split(".")[0]}.${t.split(".")[1]}`)).toBeNull();
  });

  it("cannot be replayed once its TTL has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T10:00:00Z"));
    const t = signMagicLinkToken({ userId: "u1", purpose: "sign-in", ttlSeconds: MAGIC_LINK_TTL.signIn });
    expect(await verifyMagicLinkToken(t)).not.toBeNull();
    vi.setSystemTime(new Date("2026-09-01T11:00:01Z"));
    expect(await verifyMagicLinkToken(t)).toBeNull();
  });
});

describe("magic-link: purpose is enforced, not decorative", () => {
  it("a rate-match token is rejected where only sign-in is accepted", async () => {
    const t = signMagicLinkToken({
      userId: "u1",
      purpose: "rate-match",
      matchId: "m1",
      ttlSeconds: MAGIC_LINK_TTL.rateMatch,
    });
    expect(await verifyMagicLinkToken(t)).not.toBeNull(); // valid in general
    expect(await verifyMagicLinkToken(t, { purposes: ["sign-in"] })).toBeNull();
    expect(await verifyMagicLinkToken(t, { purposes: ["rate-match"] })).not.toBeNull();
  });

  it("rejects an unknown purpose outright", async () => {
    const t = forge({ userId: "u1", purpose: "impersonate", exp: nowSec() + 600, iat: nowSec() });
    expect(await verifyMagicLinkToken(t)).toBeNull();
  });

  it("rejects a rate-match token with no matchId", async () => {
    const t = forge({ userId: "u1", purpose: "rate-match", exp: nowSec() + 600, iat: nowSec() });
    expect(await verifyMagicLinkToken(t)).toBeNull();
  });

  it("rejects a payload with no userId", async () => {
    const t = forge({ purpose: "sign-in", exp: nowSec() + 600, iat: nowSec() });
    expect(await verifyMagicLinkToken(t)).toBeNull();
  });
});

describe("magic-link: no link outlives its purpose's policy TTL", () => {
  it("has no multi-year preset", () => {
    const longest = Math.max(...Object.values(MAGIC_LINK_TTL));
    expect(longest).toBeLessThanOrEqual(365 * DAY);
  });

  it("clamps an over-long ttl at signing time", () => {
    const t = signMagicLinkToken({ userId: "u1", purpose: "sign-in", ttlSeconds: 100 * 365 * DAY });
    const p = decode(t);
    expect(p.exp - p.iat).toBeLessThanOrEqual(MAX_TTL_BY_PURPOSE["sign-in"]);
  });

  it("rejects a token that was minted with an over-long lifetime", async () => {
    const iat = nowSec();
    const t = forge({ userId: "u1", purpose: "sign-in", iat, exp: iat + 100 * 365 * DAY });
    expect(await verifyMagicLinkToken(t)).toBeNull();
  });

  it("rejects a rate-match token stretched beyond the rating window", async () => {
    const iat = nowSec();
    const t = forge({ userId: "u1", purpose: "rate-match", matchId: "m1", iat, exp: iat + 90 * DAY });
    expect(await verifyMagicLinkToken(t)).toBeNull();
  });
});

describe("magic-link: legacy tokens (no iat) sunset instead of living forever", () => {
  const legacy = () =>
    forge({
      userId: "u1",
      purpose: "sign-in",
      nextPath: "/profile/stats",
      exp: Math.floor(Date.parse("2126-01-01T00:00:00Z") / 1000), // the old ~100y preset
    });

  it("still works before the sunset — links already in players' chats keep working", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(LEGACY_TOKEN_SUNSET * 1000 - 86_400_000));
    expect(await verifyMagicLinkToken(legacy())).not.toBeNull();
  });

  it("is dead after the sunset even though its own exp is a century out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(LEGACY_TOKEN_SUNSET * 1000 + 86_400_000));
    expect(await verifyMagicLinkToken(legacy())).toBeNull();
  });
});

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
