/**
 * The player pool banner's loader (2026-10-28) with the database mocked:
 * the club gates (platform switch AND club flag, ordinary current
 * memberships only), the dismissal columns missing before the migration
 * (no banner, no crash), the share link, and the admin line for his
 * current club only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  membershipFindMany: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  poolProfileFindUnique: vi.fn(),
  sentFindUnique: vi.fn(),
  loadPoolShare: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    membership: { findMany: h.membershipFindMany },
    poolProfile: { findUnique: h.poolProfileFindUnique },
    sentNotification: { findUnique: h.sentFindUnique },
    $queryRaw: h.queryRaw,
    $executeRaw: h.executeRaw,
  },
}));
vi.mock("@/lib/pool/growth", () => ({ loadPoolShare: h.loadPoolShare }));

import { dismissPoolBanner, loadPoolBanner } from "../banner";

const OPEN = { MT_POOL_OPEN: "1" };
const CLOSED = { MT_POOL_OPEN: "0" };
const club = (orgId: string, role = "PLAYER", language = "en") => ({ orgId, role, org: { featurePlayerPool: true, language } });
const SHARE = {
  url: "https://x/play?ref=AB",
  language: "en",
  shownName: null,
  messages: { en: { text: "en", whatsApp: "https://wa.me/?text=en" }, tr: { text: "tr", whatsApp: "https://wa.me/?text=tr" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  h.membershipFindMany.mockResolvedValue([club("org1")]);
  h.queryRaw.mockResolvedValue([{ j: null, s: null }]);
  h.poolProfileFindUnique.mockResolvedValue(null);
  h.sentFindUnique.mockResolvedValue(null);
  h.loadPoolShare.mockResolvedValue(SHARE);
  h.executeRaw.mockResolvedValue(1);
});

describe("the club gates", () => {
  it("reads only his ordinary, current memberships of clubs with the flag on", async () => {
    await loadPoolBanner("me", { env: OPEN, currentOrgId: "org1" });
    expect(h.membershipFindMany.mock.calls[0][0].where).toEqual({ userId: "me", leftAt: null, guestMatchId: null, org: { featurePlayerPool: true } });
  });

  it("no club with the pool: nothing, and the dismissals are not even read", async () => {
    h.membershipFindMany.mockResolvedValue([]);
    expect(await loadPoolBanner("me", { env: OPEN, currentOrgId: null })).toBeNull();
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("the platform switch off: nothing", async () => {
    expect(await loadPoolBanner("me", { env: CLOSED, currentOrgId: "org1" })).toBeNull();
  });

  it("the platform switch unread (no key): nothing", async () => {
    expect(await loadPoolBanner("me", { env: {}, currentOrgId: "org1" })).toBeNull();
  });
});

describe("the dismissal columns not there yet", () => {
  it("the read fails: no banner, no throw", async () => {
    h.queryRaw.mockRejectedValue(new Error('column "poolBannerJoinDismissedAt" does not exist'));
    expect(await loadPoolBanner("me", { env: OPEN, currentOrgId: "org1" })).toBeNull();
  });

  it("Not interested fails softly", async () => {
    h.executeRaw.mockRejectedValue(new Error('column "poolBannerJoinDismissedAt" does not exist'));
    expect(await dismissPoolBanner("me", "join")).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("join and share", () => {
  it("not in the pool: join, in the club's language", async () => {
    h.membershipFindMany.mockResolvedValue([club("org1", "PLAYER", "tr")]);
    expect(await loadPoolBanner("me", { env: OPEN, currentOrgId: "org1" })).toEqual({ kind: "join", language: "tr", whatsApp: null, adminLine: false });
  });

  it("in the pool: share, with his own WhatsApp link in his pool language", async () => {
    h.poolProfileFindUnique.mockResolvedValue({ status: "active" });
    h.loadPoolShare.mockResolvedValue({ ...SHARE, language: "tr" });
    expect(await loadPoolBanner("me", { env: OPEN, currentOrgId: "org1" })).toEqual({ kind: "share", language: "tr", whatsApp: "https://wa.me/?text=tr", adminLine: false });
  });

  it("share dismissed: nothing, and no link is made", async () => {
    h.poolProfileFindUnique.mockResolvedValue({ status: "active" });
    h.queryRaw.mockResolvedValue([{ j: null, s: new Date() }]);
    expect(await loadPoolBanner("me", { env: OPEN, currentOrgId: "org1" })).toBeNull();
    expect(h.loadPoolShare).not.toHaveBeenCalled();
  });

  it("join dismissed: nothing", async () => {
    h.queryRaw.mockResolvedValue([{ j: new Date(), s: null }]);
    expect(await loadPoolBanner("me", { env: OPEN, currentOrgId: "org1" })).toBeNull();
  });
});

describe("the admin line", () => {
  it("owner or admin of his current open club that has not sent the post", async () => {
    for (const role of ["OWNER", "ADMIN"]) {
      h.membershipFindMany.mockResolvedValue([club("org1", role)]);
      expect((await loadPoolBanner("me", { env: OPEN, currentOrgId: "org1" }))?.adminLine).toBe(true);
    }
    expect(h.sentFindUnique).toHaveBeenCalledWith({ where: { key: "org-org1:pool-club-share" }, select: { key: true } });
  });

  it("the post already sent: no line", async () => {
    h.membershipFindMany.mockResolvedValue([club("org1", "OWNER")]);
    h.sentFindUnique.mockResolvedValue({ key: "org-org1:pool-club-share" });
    expect((await loadPoolBanner("me", { env: OPEN, currentOrgId: "org1" }))?.adminLine).toBe(false);
  });

  it("a player: no line", async () => {
    expect((await loadPoolBanner("me", { env: OPEN, currentOrgId: "org1" }))?.adminLine).toBe(false);
  });

  it("admin of an open club that is not his current club: no line (the link would open the wrong club)", async () => {
    h.membershipFindMany.mockResolvedValue([club("org1", "PLAYER"), club("org2", "OWNER")]);
    expect((await loadPoolBanner("me", { env: OPEN, currentOrgId: "org1" }))?.adminLine).toBe(false);
  });
});

describe("Not interested", () => {
  it("writes his own row, keeping the first time", async () => {
    expect(await dismissPoolBanner("me", "share")).toEqual({ ok: true });
    const sql = (h.executeRaw.mock.calls[0][0] as string[]).join("?");
    expect(sql).toContain(`"poolBannerShareDismissedAt" = COALESCE("poolBannerShareDismissedAt", ?)`);
    expect(sql).toContain("WHERE id = ?");
    expect(h.executeRaw.mock.calls[0][2]).toBe("me");
  });
});
