/**
 * A MatchTime staff test sign-up (`PoolProfile.staffTest`, 2026-11-16) that
 * came through a member's friend link never counts toward that member's
 * referral badge, which is posted in the club's group (round 2 of #607):
 * the cron never stamps it, and the badge counts never read it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  db: {
    poolProfile: { findMany: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    guestPlace: { findMany: vi.fn() },
    attendance: { findMany: vi.fn(), count: vi.fn() },
    membership: { findMany: vi.fn() },
    badgeAnnouncement: { findMany: vi.fn() },
  },
}));
vi.mock("../../db", () => dbMock);

import { loadClubReferralAwards, stampPlayedReferrals } from "../referrals";

const whereOf = (i: number) => (dbMock.db.poolProfile.findMany.mock.calls[i][0] as { where: Record<string, unknown> }).where;

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(dbMock.db)) for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  dbMock.db.poolProfile.updateMany.mockResolvedValue({ count: 1 });
});

describe("staff tests and referral badges", () => {
  it("the cron never stamps a staff test as a friend who has played", async () => {
    await stampPlayedReferrals(new Date("2026-11-16T12:00:00Z"));
    expect(whereOf(0)).toMatchObject({ referrerUserId: { not: null }, referralCountedAt: null, staffTest: false });
  });

  it("the club's badges read only friends who are not staff tests", async () => {
    dbMock.db.poolProfile.findMany
      .mockResolvedValueOnce([{ referrerUserId: "ali" }]) // members with a friend who played
      .mockResolvedValueOnce([]) // those friends
      .mockResolvedValueOnce([{ userId: "ali", status: "active", showRecognition: true, referrerUserId: null }]); // the members' own profiles
    await loadClubReferralAwards("org-1", new Set(["ali"]));
    expect(whereOf(0)).toMatchObject({ referrerUserId: { in: ["ali"] }, referralCountedAt: { not: null }, staffTest: false });
    const friends = dbMock.db.poolProfile.findMany.mock.calls.map((c) => (c[0] as { where: Record<string, unknown> }).where).find((w) => "referralCountedAt" in w && w !== whereOf(0));
    expect(friends).toMatchObject({ referrerUserId: { in: ["ali"] }, referralCountedAt: { not: null }, staffTest: false });
  });
});
