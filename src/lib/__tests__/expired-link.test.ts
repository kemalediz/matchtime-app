/**
 * An EXPIRED signed link (the setup DM's and the reminder's last 7 days):
 * what the server reads from it, and how little the browser is told.
 * db is mocked; the tokens are real ones, signed with the test secret.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  shortLink: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "unit-test-secret";

import { readExpiredMagicLink, signMagicLinkToken } from "../magic-link";
import { expiredLinkDestination, expiredLoginPath, isLinkHandle, resolveExpiredLink } from "../expired-link";

const expired = (over: Record<string, unknown> = {}) =>
  signMagicLinkToken({ userId: "u-hana", purpose: "sign-in", nextPath: "/admin/settings", ttlSeconds: -60, ...over } as never);
const live = () => signMagicLinkToken({ userId: "u-hana", purpose: "sign-in", nextPath: "/admin/settings", ttlSeconds: 600 });

/** A token with OUR signature over any payload at all. */
function signRaw(payload: Record<string, unknown>): string {
  const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(createHmac("sha256", process.env.AUTH_SECRET!.trim()).update(body).digest())}`;
}
const PAST = Math.floor(Date.now() / 1000) - 600;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.shortLink.findUnique.mockResolvedValue(null);
});

describe("readExpiredMagicLink: as strict on shape as the verifier", () => {
  it("reads an expired token of ours", () => {
    expect(readExpiredMagicLink(expired({ orgId: "o-b" }))).toMatchObject({
      userId: "u-hana",
      purpose: "sign-in",
      nextPath: "/admin/settings",
      orgId: "o-b",
    });
  });

  it("a token that still works is not 'expired'", () => {
    expect(readExpiredMagicLink(live())).toBeNull();
  });

  it("a forged signature says nothing", () => {
    const [body] = expired().split(".");
    expect(readExpiredMagicLink(`${body}.AAAA`)).toBeNull();
    expect(readExpiredMagicLink("nonsense")).toBeNull();
    expect(readExpiredMagicLink("")).toBeNull();
  });

  it.each([
    ["no user", { purpose: "sign-in", exp: PAST, iat: PAST - 60 }],
    ["an empty user", { userId: "", purpose: "sign-in", exp: PAST, iat: PAST - 60 }],
    ["an unknown purpose", { userId: "u", purpose: "rsvp", exp: PAST, iat: PAST - 60 }],
    ["a rating link with no match", { userId: "u", purpose: "rate-match", exp: PAST, iat: PAST - 60 }],
    ["a club that is not a string", { userId: "u", purpose: "sign-in", orgId: 7, exp: PAST, iat: PAST - 60 }],
    ["an empty club", { userId: "u", purpose: "sign-in", orgId: "", exp: PAST, iat: PAST - 60 }],
    ["a page that is not a string", { userId: "u", purpose: "sign-in", nextPath: { a: 1 }, exp: PAST, iat: PAST - 60 }],
    ["a match that is not a string", { userId: "u", purpose: "rate-match", matchId: 5, exp: PAST, iat: PAST - 60 }],
    ["no expiry", { userId: "u", purpose: "sign-in", iat: PAST - 60 }],
    ["an expiry that is not a number", { userId: "u", purpose: "sign-in", exp: "soon", iat: PAST - 60 }],
  ])("a correctly SIGNED token with %s is refused all the same", (_label, payload) => {
    expect(readExpiredMagicLink(signRaw(payload))).toBeNull();
  });
});

describe("expiredLinkDestination", () => {
  it("the page the link was for, when it is a path on this site", () => {
    expect(expiredLinkDestination({ purpose: "sign-in", nextPath: "/admin/settings#go-live" })).toBe("/admin/settings#go-live");
    expect(expiredLinkDestination({ purpose: "rate-match", matchId: "m1" })).toBe("/matches/m1/rate");
  });

  it("nothing for a link with no page, or a page the validator refuses", () => {
    expect(expiredLinkDestination({ purpose: "sign-in" })).toBeNull();
    expect(expiredLinkDestination({ purpose: "sign-in", nextPath: "//evil.example" })).toBeNull();
    expect(expiredLinkDestination({ purpose: "sign-in", nextPath: "/.//evil.example" })).toBeNull();
    expect(expiredLinkDestination({ purpose: "sign-in", nextPath: "/r/k7Qp2m9" })).toBeNull();
    expect(expiredLinkDestination({ purpose: "rate-match", matchId: "../../r/k7Qp2m9" })).toBeNull();
  });
});

describe("resolveExpiredLink (server only: its answer never goes to the browser)", () => {
  it("an expired long token: its payload", async () => {
    expect(await resolveExpiredLink(expired({ orgId: "o-b" }))).toMatchObject({ userId: "u-hana", orgId: "o-b" });
    expect(dbMock.shortLink.findUnique).not.toHaveBeenCalled();
  });

  it("an expired short code: the same, through its stored token, whatever the row's own expiry says", async () => {
    dbMock.shortLink.findUnique.mockResolvedValue({ token: expired() });
    expect(await resolveExpiredLink("k7Qp2m9")).toMatchObject({ userId: "u-hana", nextPath: "/admin/settings" });
    expect(dbMock.shortLink.findUnique).toHaveBeenCalledWith({ where: { code: "k7Qp2m9" }, select: { token: true } });
  });

  it("a link that still works, an unknown code and a forged token are not 'expired'", async () => {
    expect(await resolveExpiredLink(live())).toBeNull();
    expect(await resolveExpiredLink("neverACode")).toBeNull();
    expect(await resolveExpiredLink(`${expired().split(".")[0]}.AAAA`)).toBeNull();
  });

  it("anything that is not shaped like a code or a token is never looked up", async () => {
    for (const bad of ["", "has space", "a/b", "a?b=1", "x".repeat(3000), "%2e%2e"]) {
      expect(await resolveExpiredLink(bad), bad).toBeNull();
    }
    expect(dbMock.shortLink.findUnique).not.toHaveBeenCalled();
  });

  it("a database failure reads as 'not expired', never as an error", async () => {
    dbMock.shortLink.findUnique.mockRejectedValue(new Error("down"));
    expect(await resolveExpiredLink("k7Qp2m9")).toBeNull();
  });
});

describe("the sign-in page for an expired link", () => {
  it("carries the link itself as an opaque handle: no page, no club, no language", () => {
    expect(expiredLoginPath("k7Qp2m9")).toBe("/login?expired=1&link=k7Qp2m9");
    const token = expired();
    expect(expiredLoginPath(token)).toBe(`/login?expired=1&link=${encodeURIComponent(token)}`);
    expect(expiredLoginPath("k7Qp2m9")).not.toMatch(/callbackUrl|lang|admin/);
  });

  it("isLinkHandle: a short code or a token, nothing else", () => {
    expect(isLinkHandle("k7Qp2m9")).toBe(true);
    expect(isLinkHandle(expired())).toBe(true);
    for (const bad of ["", "a b", "a/b", "../x", "x".repeat(3000), 42, null]) expect(isLinkHandle(bad), String(bad)).toBe(false);
  });
});
