/**
 * The offer's tap link (slice L5a): `/play/offer/<token>`, the token a
 * signature of the offer id. Stateless (no column), unguessable, and it
 * names nothing about the person.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POOL_OFFER_PATH_PREFIX, offerIdFromToken, poolOfferPath, poolOfferToken } from "../offer-token";
import { isPublicPath } from "../../public-paths";
import { shouldShowSidebar } from "../../app-shell-sidebar";

const SECRET = process.env.AUTH_SECRET;
beforeEach(() => {
  process.env.AUTH_SECRET = "test-secret-for-offer-tokens";
});
afterEach(() => {
  process.env.AUTH_SECRET = SECRET;
});

describe("the offer token", () => {
  it("round-trips an offer id", () => {
    const token = poolOfferToken("cmoffer123");
    expect(offerIdFromToken(token)).toBe("cmoffer123");
  });

  it("is URL-safe and carries no phone, name or user id", () => {
    const token = poolOfferToken("cmoffer123");
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(poolOfferPath("cmoffer123")).toBe(`/play/offer/${token}`);
  });

  it("refuses a forged, truncated or altered token", () => {
    const token = poolOfferToken("cmoffer123");
    const [id, sig] = token.split(".");
    expect(offerIdFromToken(`${id}.${sig.slice(0, -1)}x`)).toBeNull();
    expect(offerIdFromToken(`${id}.`)).toBeNull();
    expect(offerIdFromToken(id)).toBeNull();
    expect(offerIdFromToken(`cmotheroffer.${sig}`)).toBeNull();
    expect(offerIdFromToken("")).toBeNull();
    expect(offerIdFromToken("a.b.c")).toBeNull();
  });

  it("a token signed with another secret does not verify", () => {
    const token = poolOfferToken("cmoffer123");
    process.env.AUTH_SECRET = "another-secret";
    expect(offerIdFromToken(token)).toBeNull();
  });
});

describe("the offer page is public and full-bleed", () => {
  it("no session is needed to open it, and it has no app sidebar", () => {
    const path = poolOfferPath("cmoffer123");
    expect(path.startsWith(POOL_OFFER_PATH_PREFIX)).toBe(true);
    expect(isPublicPath(path)).toBe(true);
    expect(isPublicPath("/play/offerx")).toBe(false);
    expect(shouldShowSidebar(path, "unauthenticated")).toBe(false);
    expect(shouldShowSidebar(path, "authenticated")).toBe(false);
  });
});
