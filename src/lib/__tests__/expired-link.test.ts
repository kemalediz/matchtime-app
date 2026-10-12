/**
 * An EXPIRED signed link (the setup DM's and the reminder's last 7 days):
 * where the organiser is sent instead of a dead end. db is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  shortLink: { findUnique: vi.fn() },
  organisation: { findUnique: vi.fn() },
  membership: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { signMagicLinkToken } from "../magic-link";
import { expiredLinkDestination, expiredLinkInfo, expiredLoginPath } from "../expired-link";

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "unit-test-secret";

const expired = (over: Record<string, unknown> = {}) =>
  signMagicLinkToken({ userId: "u-hana", purpose: "sign-in", nextPath: "/admin/settings", ttlSeconds: -60, ...over } as never);
const live = () => signMagicLinkToken({ userId: "u-hana", purpose: "sign-in", nextPath: "/admin/settings", ttlSeconds: 600 });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.shortLink.findUnique.mockResolvedValue(null);
  dbMock.organisation.findUnique.mockResolvedValue(null);
  dbMock.membership.findFirst.mockResolvedValue(null);
});

describe("expiredLinkDestination", () => {
  it("the page the link was for, when it is a path on this site", () => {
    expect(expiredLinkDestination({ purpose: "sign-in", nextPath: "/admin/settings#go-live" })).toBe("/admin/settings#go-live");
    expect(expiredLinkDestination({ purpose: "rate-match", matchId: "m1" })).toBe("/matches/m1/rate");
  });

  it("nothing for a link with no page, or a path that is not ours", () => {
    expect(expiredLinkDestination({ purpose: "sign-in" })).toBeNull();
    expect(expiredLinkDestination({ purpose: "sign-in", nextPath: "//evil.example" })).toBeNull();
    expect(expiredLinkDestination({ purpose: "sign-in", nextPath: "https://evil.example/admin" })).toBeNull();
    expect(expiredLinkDestination({ purpose: "sign-in", nextPath: "/\\evil.example" })).toBeNull();
  });
});

describe("expiredLinkInfo", () => {
  it("an expired long token: where it was going, in English when no club is known", async () => {
    expect(await expiredLinkInfo(expired())).toEqual({ nextPath: "/admin/settings", lang: "en" });
  });

  it("an expired short code: the same, through its stored token", async () => {
    const token = expired();
    dbMock.shortLink.findUnique.mockResolvedValue({ token });
    expect(await expiredLinkInfo("k7Qp2m9")).toEqual({ nextPath: "/admin/settings", lang: "en" });
    expect(dbMock.shortLink.findUnique).toHaveBeenCalledWith({ where: { code: "k7Qp2m9" }, select: { token: true } });
  });

  it("the notice is in the club's language: the link's own club first, else the person's oldest club", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ language: "tr" });
    expect(await expiredLinkInfo(expired({ orgId: "o-kiyi" }))).toEqual({ nextPath: "/admin/settings", lang: "tr" });
    expect(dbMock.organisation.findUnique).toHaveBeenCalledWith({ where: { id: "o-kiyi" }, select: { language: true } });

    dbMock.membership.findFirst.mockResolvedValue({ org: { language: "tr" } });
    expect(await expiredLinkInfo(expired())).toEqual({ nextPath: "/admin/settings", lang: "tr" });
  });

  it("it says NOTHING about who the link was for", async () => {
    dbMock.membership.findFirst.mockResolvedValue({ org: { language: "tr" } });
    const info = await expiredLinkInfo(expired());
    expect(Object.keys(info!).sort()).toEqual(["lang", "nextPath"]);
    expect(JSON.stringify(info)).not.toContain("u-hana");
  });

  it("a link that still works is not 'expired'", async () => {
    expect(await expiredLinkInfo(live())).toBeNull();
  });

  it("a forged or unknown link is not 'expired': nothing is read from an unsigned payload", async () => {
    const [body] = expired().split(".");
    expect(await expiredLinkInfo(`${body}.AAAA`)).toBeNull();
    expect(await expiredLinkInfo("not-a-code")).toBeNull();
    expect(await expiredLinkInfo("")).toBeNull();
    expect(dbMock.organisation.findUnique).not.toHaveBeenCalled();
    expect(dbMock.membership.findFirst).not.toHaveBeenCalled();
  });

  it("a database failure reads as 'not expired', never as an error", async () => {
    dbMock.shortLink.findUnique.mockRejectedValue(new Error("down"));
    expect(await expiredLinkInfo("k7Qp2m9")).toBeNull();
  });
});

describe("expiredLoginPath", () => {
  it("the sign-in page, saying the link expired, carrying the page to carry on to", () => {
    expect(expiredLoginPath({ nextPath: "/admin/settings#go-live", lang: "en" })).toBe(
      "/login?expired=1&callbackUrl=%2Fadmin%2Fsettings%23go-live",
    );
    expect(expiredLoginPath({ nextPath: null, lang: "tr" })).toBe("/login?expired=1&lang=tr");
    expect(expiredLoginPath({ nextPath: "/admin", lang: "tr" })).toBe("/login?expired=1&lang=tr&callbackUrl=%2Fadmin");
  });
});
