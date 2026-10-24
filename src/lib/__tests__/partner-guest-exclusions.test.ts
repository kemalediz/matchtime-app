/**
 * A partner club's guest in the asking club's data (cross-club ask, slice
 * S4, plan 3.7 table; Kemal's decisions of 2026-10-16).
 *
 * Left OUT of: the rolling squad, recruit DMs (pinned in
 * recruit-dm-subscription.test.ts), badge announcements, the seed nudge,
 * the club's leaderboard, a cold DM's target, the players page's phone and
 * email (and the phones page). Kept IN: his own profile's all-clubs card
 * (a past guest's row included), and payments, which read the match's
 * attendances and never the membership.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { carryOverExclusion, type SeedSourceRow } from "../rolling-squad-rules";

const dbMock = vi.hoisted(() => ({
  membership: { findMany: vi.fn() },
  attendance: { findMany: vi.fn() },
  rating: { findMany: vi.fn() },
  match: { findMany: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));

import { loadAllClubsOverview } from "../player-stats";

const src = (f: string) => readFileSync(join(__dirname, "..", f), "utf8");

describe("rolling squad", () => {
  const row = (over: Partial<SeedSourceRow> = {}): SeedSourceRow => ({
    userId: "ali",
    status: "CONFIRMED",
    position: 1,
    phoneNumber: "+447700900111",
    email: "ali@x",
    isActive: true,
    membership: { leftAt: null, provisionallyAddedAt: null, guestFromOrgId: "sutton" },
    ...over,
  });
  it("a guest who played is never carried to next week, even before he is a past guest", () => {
    expect(carryOverExclusion(row())).toBe("partner club guest");
  });
  it("a past guest is out as anyone who has left", () => {
    expect(carryOverExclusion(row({ membership: { leftAt: new Date(), provisionallyAddedAt: null, guestFromOrgId: "sutton" } }))).toBe("left the group");
  });
  it("a POOL guest (no home club) is never carried either", () => {
    expect(
      carryOverExclusion(row({ membership: { leftAt: null, provisionallyAddedAt: null, guestFromOrgId: null, guestMatchId: "m1" } })),
    ).toBe("pool guest");
  });
  it("an ordinary member is carried as before", () => {
    expect(carryOverExclusion(row({ membership: { leftAt: null, provisionallyAddedAt: null, guestFromOrgId: null } }))).toBeNull();
  });
});

describe("his own profile lists the club he guested for (Kemal's decision 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.membership.findMany.mockResolvedValue([{ org: { id: "sutton", name: "Sutton FC" } }, { org: { id: "fnf", name: "FNF" } }]);
    dbMock.attendance.findMany.mockResolvedValue([{ match: { activity: { orgId: "fnf" } } }, { match: { activity: { orgId: "sutton" } } }]);
    dbMock.rating.findMany.mockResolvedValue([
      { score: 8, match: { activity: { orgId: "fnf" } } },
      { score: 6, match: { activity: { orgId: "fnf" } } },
      { score: 5, match: { activity: { orgId: "sutton" } } },
    ]);
    dbMock.match.findMany.mockResolvedValue([]);
  });

  it("reads live memberships AND guest ones, past guests included", async () => {
    await loadAllClubsOverview({ userId: "ali", viewerId: "ali" });
    // Any guest row, partner or pool (L5a): guestMatchId, not the home club.
    expect(dbMock.membership.findMany.mock.calls[0][0].where).toEqual({ userId: "ali", OR: [{ leftAt: null }, { guestMatchId: { not: null } }] });
  });

  it("FNF's row carries his games there and the raw mean of FNF's ratings of him", async () => {
    const o = await loadAllClubsOverview({ userId: "ali", viewerId: "ali" });
    const fnf = o.clubs.find((c) => c.orgId === "fnf")!;
    expect(fnf).toEqual({ orgId: "fnf", orgName: "FNF", games: 1, avgRating: 7, momCount: 0 });
    expect(o.clubCount).toBe(2);
  });
});

describe("the readers that leave a guest out", () => {
  it("badges: only members who are not partner guests", () => {
    expect(src("badge-announcement-scheduler.ts")).toMatch(/where: \{ orgId, leftAt: null, \.\.\.ORDINARY_MEMBER_WHERE \}/);
  });
  it("seed nudge: guests are not counted", () => {
    expect(src("seed-nudge.ts")).toMatch(/const members = all\.filter\(\(m\) => !isGuestMembership\(m\)\)/);
  });
  it("a cold DM never lands on a club he is only a guest of", () => {
    expect(src("dm-registration-target.ts")).toMatch(/where: \{ userId, leftAt: null, \.\.\.ORDINARY_MEMBER_WHERE, \.\.\.IN_LIVE_STAGE_CLUB_WHERE \}/);
  });
  it("the club's leaderboard skips a guest's ratings", () => {
    // One rule for every season table since review L3: the ranked roster.
    expect(src("player-stats.ts")).toMatch(/loadGuestUserIds\(db, orgId\)/);
  });
  it("the players API hides a guest's phone and email and never offers him for a merge", () => {
    const api = readFileSync(join(__dirname, "..", "..", "app", "api", "players", "route.ts"), "utf8");
    // Any guest, partner or pool (L5a); the behaviour is pinned in api-privacy.test.ts.
    expect(api).toMatch(/phoneNumber: isGuestMembership\(m\) \? null : m\.user\.phoneNumber/);
    expect(api).toMatch(/email: isGuestMembership\(m\) \? null : m\.user\.email/);
    expect(api).toMatch(/memberships\.filter\(\(m\) => !isGuestMembership\(m\)\)/);
  });
});

describe("payments: guests pay like members (Kemal's decision 2)", () => {
  it("pay links, the chase and the collector's list read the match's CONFIRMED attendances, never a membership", () => {
    const flow = src("payment-flow.ts");
    const release = flow.slice(flow.indexOf("export async function releaseMatchPayments"), flow.indexOf("export async function applyCheckoutEvent"));
    expect(release).toMatch(/attendances: \{\s*where: \{ status: "CONFIRMED" \}/);
    expect(release).not.toMatch(/membership|leftAt|guestFromOrgId/);
    const collect = readFileSync(join(__dirname, "..", "..", "app", "collect", "[matchId]", "page.tsx"), "utf8");
    expect(collect).not.toMatch(/guestFromOrgId|leftAt/);
  });
});
