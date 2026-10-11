/**
 * GOOGLE IS THE OWNER'S FALLBACK, NOT A WAY IN (2026-10-11).
 *
 * WhatsApp is the only sign-in the product shows. Google stays reachable
 * at /login?via=google for one reason: WhatsApp codes need the Pi bot to
 * be up, and the owner must be able to open /admin/health when it is
 * down. So it may only sign in an account that ALREADY has that Google
 * account linked.
 *
 * Without this gate Auth.js, with the Prisma adapter, answers an unknown
 * Google account by CREATING a User and an Account
 * (@auth/core/lib/actions/callback/handle-login.js). The `signIn`
 * callback runs before that (callback/index.js, handleAuthorized), so
 * refusing here means nothing is written.
 *
 * db is mocked. No network, no model.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  account: { findUnique: vi.fn() },
  user: { create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { GOOGLE_NOT_LINKED_URL, gateSignIn } from "../google-signin-gate";

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.account.findUnique.mockResolvedValue(null);
});

const google = (providerAccountId = "g-123") => ({ provider: "google", providerAccountId, type: "oidc" });

describe("gateSignIn", () => {
  it("a Google account already linked to a user signs in", async () => {
    dbMock.account.findUnique.mockResolvedValue({ userId: "u-owner" });
    expect(await gateSignIn({ account: google("g-owner") })).toBe(true);
    expect(dbMock.account.findUnique).toHaveBeenCalledWith({
      where: { provider_providerAccountId: { provider: "google", providerAccountId: "g-owner" } },
      select: { userId: true },
    });
  });

  it("an unknown Google account is refused, and no user is created", async () => {
    const res = await gateSignIn({ account: google("g-stranger") });
    expect(res).toBe(GOOGLE_NOT_LINKED_URL);
    expect(res).toBe("/login?via=google&error=not-linked");
    expect(dbMock.user.create).not.toHaveBeenCalled();
    expect(dbMock.user.upsert).not.toHaveBeenCalled();
    expect(dbMock.user.update).not.toHaveBeenCalled();
  });

  it("an unknown Google account is refused even when its email matches an existing user", async () => {
    // The gate never looks at the email, so there is nothing to match on:
    // only the stored link counts.
    const res = await gateSignIn({
      account: google("g-lookalike"),
      user: { email: "owner@example.com" },
      profile: { email: "owner@example.com", email_verified: true },
    });
    expect(res).toBe(GOOGLE_NOT_LINKED_URL);
  });

  it("a Google sign-in with no account id is refused", async () => {
    expect(await gateSignIn({ account: google("") })).toBe(GOOGLE_NOT_LINKED_URL);
    expect(dbMock.account.findUnique).not.toHaveBeenCalled();
  });

  it("if the lookup fails the answer is no", async () => {
    dbMock.account.findUnique.mockRejectedValue(new Error("db down"));
    expect(await gateSignIn({ account: google() })).toBe(GOOGLE_NOT_LINKED_URL);
  });

  it("the WhatsApp code and DM link sign-ins are not touched", async () => {
    expect(await gateSignIn({ account: { provider: "magic-link", providerAccountId: "u1", type: "credentials" } })).toBe(true);
    expect(dbMock.account.findUnique).not.toHaveBeenCalled();
  });

  it("any provider other than those two is refused", async () => {
    expect(await gateSignIn({ account: { provider: "credentials", providerAccountId: "u1", type: "credentials" } })).toBe(false);
    expect(await gateSignIn({ account: { provider: "github", providerAccountId: "x", type: "oauth" } })).toBe(false);
    expect(await gateSignIn({ account: null })).toBe(false);
  });
});

describe("auth.ts wiring", () => {
  const src = readFileSync(path.join(__dirname, "..", "auth.ts"), "utf8");

  it("uses the gate as its signIn callback", () => {
    expect(src).toMatch(/signIn:\s*gateSignIn/);
    expect(src).not.toMatch(/allowDangerousEmailAccountLinking/);
  });

  it("offers no email + password sign-in: the one Credentials provider left is magic-link", () => {
    expect(src).not.toMatch(/bcrypt/);
    expect(src.match(/Credentials\(\{/g)).toHaveLength(1);
    expect(src).toMatch(/id:\s*"magic-link"/);
  });
});
