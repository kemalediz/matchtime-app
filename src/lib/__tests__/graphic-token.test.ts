/**
 * The short-lived signed token in a graphic's URL (2026-10-14): the Pi
 * fetches `/api/graphics/<token>` with nothing else, so the token is the
 * whole of the route's access control.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { GRAPHIC_TOKEN_MAX_TTL_SECONDS, signGraphicToken, verifyGraphicToken } from "../graphic-token";
import { signMagicLinkToken, verifyMagicLinkToken } from "../magic-link";

const NOW = new Date("2026-10-14T12:00:00Z");
const at = (secondsLater: number) => new Date(NOW.getTime() + secondsLater * 1000);

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "unit-graphic-secret";
});
afterEach(() => {
  process.env.AUTH_SECRET = saved;
});

describe("signGraphicToken / verifyGraphicToken", () => {
  it("round-trips the org, the match and the kind", () => {
    const t = signGraphicToken({ orgId: "org-1", matchId: "m-1", kind: "list", ttlSeconds: 900, now: NOW });
    expect(verifyGraphicToken(t, at(60))).toEqual({ orgId: "org-1", matchId: "m-1", kind: "list" });
    const t2 = signGraphicToken({ orgId: "org-1", matchId: "m-1", kind: "teams", ttlSeconds: 900, now: NOW });
    expect(verifyGraphicToken(t2, at(60))?.kind).toBe("teams");
  });

  it("is URL-safe", () => {
    const t = signGraphicToken({ orgId: "org-1", matchId: "m-1", kind: "list", ttlSeconds: 900, now: NOW });
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("expires", () => {
    const t = signGraphicToken({ orgId: "org-1", matchId: "m-1", kind: "list", ttlSeconds: 900, now: NOW });
    expect(verifyGraphicToken(t, at(899))).not.toBeNull();
    expect(verifyGraphicToken(t, at(901))).toBeNull();
  });

  it("a longer life than the cap is clamped to it at mint time", () => {
    const t = signGraphicToken({ orgId: "o", matchId: "m", kind: "list", ttlSeconds: 30 * 24 * 3600, now: NOW });
    expect(verifyGraphicToken(t, at(GRAPHIC_TOKEN_MAX_TTL_SECONDS - 1))).not.toBeNull();
    expect(verifyGraphicToken(t, at(GRAPHIC_TOKEN_MAX_TTL_SECONDS + 1))).toBeNull();
  });

  it("refuses a tampered payload, a tampered signature, junk and the empty string", () => {
    const t = signGraphicToken({ orgId: "org-1", matchId: "m-1", kind: "list", ttlSeconds: 900, now: NOW });
    const [p, s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ o: "org-2", m: "m-1", k: "list", exp: 9999999999, iat: 1 })).toString("base64url");
    expect(verifyGraphicToken(`${forged}.${s}`, at(1))).toBeNull();
    expect(verifyGraphicToken(`${p}.${s.slice(0, -2)}xx`, at(1))).toBeNull();
    expect(verifyGraphicToken("not-a-token", at(1))).toBeNull();
    expect(verifyGraphicToken("", at(1))).toBeNull();
    expect(verifyGraphicToken("a.b.c", at(1))).toBeNull();
  });

  it("refuses a token signed with another secret", () => {
    const t = signGraphicToken({ orgId: "org-1", matchId: "m-1", kind: "list", ttlSeconds: 900, now: NOW });
    process.env.AUTH_SECRET = "another-secret";
    expect(verifyGraphicToken(t, at(1))).toBeNull();
  });

  it("refuses an unknown kind even when correctly signed", () => {
    const payload = Buffer.from(JSON.stringify({ o: "org-1", m: "m-1", k: "ratings", exp: 1e10, iat: 1 })).toString("base64url");
    const sig = createHmac("sha256", "unit-graphic-secret").update(`matchtime-graphic-v1.${payload}`).digest("base64url");
    expect(verifyGraphicToken(`${payload}.${sig}`, at(1))).toBeNull();
  });

  it("is domain-separated from magic links: neither verifies as the other", async () => {
    const graphic = signGraphicToken({ orgId: "org-1", matchId: "m-1", kind: "list", ttlSeconds: 900, now: new Date() });
    expect(await verifyMagicLinkToken(graphic)).toBeNull();
    const magic = signMagicLinkToken({ userId: "u-1", purpose: "sign-in", ttlSeconds: 900 });
    expect(verifyGraphicToken(magic, new Date())).toBeNull();
  });
});
