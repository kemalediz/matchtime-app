/**
 * The /play staff cookie lasts no longer than a staff session (round 7 of
 * #607): both read the one session length in `auth-session.ts`, so a browser
 * whose session simply ran out stops hiding its /play visits at the same
 * time. Auth.js's own default (30 days) is kept, now stated where we use it.
 */
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ config: undefined as undefined | { session?: { strategy?: string; maxAge?: number } } }));
vi.mock("next-auth", () => ({
  default: (config: typeof captured.config) => {
    captured.config = config;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock("next-auth/providers/google", () => ({ default: () => ({ id: "google" }) }));
vi.mock("next-auth/providers/credentials", () => ({ default: () => ({ id: "magic-link" }) }));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));
vi.mock("../db", () => ({ db: {} }));
vi.mock("../magic-link", () => ({ verifyMagicLinkToken: vi.fn() }));
vi.mock("../google-signin-gate", () => ({ gateSignIn: vi.fn() }));

import "../auth";
import { AUTH_SESSION_MAX_AGE_SECONDS } from "../auth-session";
import { poolStaffCookieOptions } from "../pool/visit-rules";

describe("the session length", () => {
  it("is Auth.js's own 30 days, set explicitly on the session", () => {
    expect(AUTH_SESSION_MAX_AGE_SECONDS).toBe(30 * 24 * 3600);
    expect(captured.config?.session).toEqual({ strategy: "jwt", maxAge: AUTH_SESSION_MAX_AGE_SECONDS });
  });

  it("the staff cookie lasts exactly as long, never longer", () => {
    expect(poolStaffCookieOptions({ secure: true }).maxAge).toBe(captured.config?.session?.maxAge);
  });
});
