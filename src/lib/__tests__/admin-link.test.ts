/**
 * Links in organiser DMs are tappable, signed in, and open the right club.
 *
 * 2026-09-30, "MT Test": the organiser was DMed
 *   "Please set their name:\n/admin/players/phones"
 * A bare path is not a link on WhatsApp, and even typed into a browser it
 * lands on a sign-in page the organiser has no password for. Every
 * organiser DM that points at an admin page now goes through
 * `buildAdminLink`, which mints a sign-in magic link that names the page
 * AND the club (see `magic-link.ts`, `orgId`).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const shortUrl = vi.fn();
vi.mock("@/lib/short-link", () => ({
  buildShortMagicLinkUrl: (...a: unknown[]) => shortUrl(...a),
}));

beforeAll(() => {
  process.env.AUTH_SECRET = "unit-test-secret";
});

import { buildAdminLink, appUrl } from "@/lib/admin-link";
import { verifyMagicLinkToken, MAGIC_LINK_TTL } from "@/lib/magic-link";

beforeEach(() => {
  shortUrl.mockReset();
  shortUrl.mockImplementation(async () => "https://matchtime.ai/r/abc123");
});

describe("buildAdminLink", () => {
  it("returns the short link for a sign-in token naming the page and the club", async () => {
    const url = await buildAdminLink({ userId: "u-admin", orgId: "org-1", nextPath: "/admin/players/phones" });
    expect(url).toBe("https://matchtime.ai/r/abc123");
    const token = shortUrl.mock.calls[0][0] as string;
    const p = await verifyMagicLinkToken(token);
    expect(p).toMatchObject({
      userId: "u-admin",
      purpose: "sign-in",
      nextPath: "/admin/players/phones",
      orgId: "org-1",
    });
  });

  it("defaults to the 48h action-nudge lifetime", async () => {
    await buildAdminLink({ userId: "u", orgId: "o", nextPath: "/admin" });
    const p = await verifyMagicLinkToken(shortUrl.mock.calls[0][0] as string);
    expect(p!.exp - p!.iat).toBe(MAGIC_LINK_TTL.actionNudge);
  });

  it("refuses a path that is not same-origin", async () => {
    await expect(buildAdminLink({ userId: "u", orgId: "o", nextPath: "https://evil.example" })).rejects.toThrow();
    await expect(buildAdminLink({ userId: "u", orgId: "o", nextPath: "//evil.example" })).rejects.toThrow();
  });
});

describe("appUrl", () => {
  it("makes an absolute URL on the app's host", () => {
    const before = process.env.NEXTAUTH_URL;
    process.env.NEXTAUTH_URL = "https://mt.example/";
    expect(appUrl("/admin/settings")).toBe("https://mt.example/admin/settings");
    delete process.env.NEXTAUTH_URL;
    expect(appUrl("/admin/settings")).toBe("https://matchtime.ai/admin/settings");
    if (before !== undefined) process.env.NEXTAUTH_URL = before;
  });
});
