/**
 * A POOL guest is a guest everywhere (local player pool, slice L5a).
 *
 * His membership row has `guestVia` "pool", `guestMatchId` set and
 * `guestFromOrgId` NULL (no home club). Every reader that used to ask
 * "is he a guest?" through `guestFromOrgId` would have treated him as an
 * ordinary member. These cases pin the readers that act on the answer:
 * club access, the leaderboard's guest set, and the organisers' pick list
 * and pick DM. The rest read the shared where-fragment, which the source
 * guard (guest-membership-source-guard.test.ts) holds in place.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn() },
  membership: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  organisation: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  playerActivityPosition: { findMany: vi.fn() },
  rating: { findMany: vi.fn() },
  match: { findUnique: vi.fn() },
  attendance: { count: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "club" }), set: vi.fn() }) }));
const loadGuestStandings = vi.hoisted(() => vi.fn(async () => new Map()));
vi.mock("../partner-guest-standing", () => ({ loadGuestStandings }));
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: vi.fn() }));
vi.mock("@/lib/admin-channel", () => ({ sendAdminNotice: vi.fn(), loadAdminChannel: vi.fn() }));

import { findOrgAdminsWithPhone, getUserOrg, isOrgAdmin } from "../org";
import { loadGuestUserIds } from "../ranked-table-activity";
import { announcePickToGroupAndPlayers, loadPickListRows } from "../organiser-pick";

const POOL = { guestVia: "pool", guestFromOrgId: null, guestMatchId: "m1", leftAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.user.findUnique.mockResolvedValue({ isSuperadmin: false });
});

describe("club access (org.ts)", () => {
  it("a pool guest's row never opens the club to him", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ id: "mp", userId: "ali", orgId: "club", role: "PLAYER", org: { id: "club" }, ...POOL });
    dbMock.membership.findFirst.mockResolvedValue(null);
    expect(await getUserOrg("ali")).toBeNull();
    // The fallback reads ordinary memberships only, by guestMatchId.
    expect(dbMock.membership.findFirst.mock.calls[0][0].where).toEqual({ userId: "ali", leftAt: null, guestMatchId: null });
  });

  it("an ordinary member still gets his club", async () => {
    const row = { id: "m", userId: "bob", orgId: "club", role: "PLAYER", org: { id: "club" }, leftAt: null, guestFromOrgId: null, guestMatchId: null, guestVia: null };
    dbMock.membership.findUnique.mockResolvedValue(row);
    expect(await getUserOrg("bob")).toBe(row);
  });
});

describe("the leaderboard's guest set (ranked-table-activity.ts)", () => {
  it("includes a pool guest, read by guestMatchId", async () => {
    const findMany = vi.fn(async () => [
      { userId: "ali", guestMatchId: "m1" },
      { userId: "cem", guestMatchId: "m2" },
    ]);
    const ids = await loadGuestUserIds({ membership: { findMany } }, "club");
    expect([...ids].sort()).toEqual(["ali", "cem"]);
    expect(findMany).toHaveBeenCalledWith({ where: { orgId: "club", guestMatchId: { not: null } }, select: { userId: true, guestMatchId: true } });
  });
});

describe("the organisers' pick list (organiser-pick.ts)", () => {
  it("marks a pool guest fromPool, with no club name and no standing lookup", async () => {
    dbMock.playerActivityPosition.findMany.mockResolvedValue([]);
    dbMock.rating.findMany.mockResolvedValue([]);
    dbMock.membership.findMany.mockResolvedValue([
      { userId: "ali", guestFromOrgId: null, guestMatchId: "m1" },
      { userId: "cem", guestFromOrgId: "sutton", guestMatchId: "m1" },
    ]);
    dbMock.organisation.findMany.mockResolvedValue([{ id: "sutton", name: "Sutton FC" }]);
    const rows = await loadPickListRows("club", "act", [
      { userId: "ali", name: "Ali K" },
      { userId: "cem", name: "Cem" },
      { userId: "bob", name: "Bob" },
    ] as never);
    expect(rows[0]).toMatchObject({ name: "Ali K", fromPool: true });
    expect(rows[0]).not.toHaveProperty("fromClub");
    expect(rows[1]).toMatchObject({ name: "Cem", fromClub: "Sutton FC" });
    expect(rows[1]).not.toHaveProperty("fromPool");
    expect(rows[2]).not.toHaveProperty("fromPool");
    expect(rows[2]).not.toHaveProperty("fromClub");
    // Guests are read by guestMatchId; the standing is a partner guest's only.
    expect(dbMock.membership.findMany.mock.calls[0][0].where).toMatchObject({ guestMatchId: { not: null } });
    expect(loadGuestStandings).toHaveBeenCalledWith([{ userId: "cem", homeOrgId: "sutton" }]);
  });

  it("a picked pool guest's DM is the guest DM, in the match club's language", async () => {
    dbMock.match.findUnique.mockResolvedValue({
      id: "m1",
      maxPlayers: 18,
      date: new Date("2026-10-16T19:30:00Z"),
      teamLabels: [],
      activity: { venue: "Powerleague", sport: { teamLabels: [] }, org: { id: "club", name: "FNF", teamLabels: [], language: "tr", listAnnouncer: "organisers" } },
    });
    dbMock.attendance.count.mockResolvedValue(17);
    dbMock.user.findMany.mockResolvedValue([
      { id: "ali", phoneNumber: "+447700900123", memberships: [{ subMatchInviteDm: true, guestFromOrgId: null, guestMatchId: "m1" }] },
    ]);
    await announcePickToGroupAndPlayers("m1", {
      applied: [{ userId: "ali", name: "Ali K", team: null, replacedName: null }],
      alreadyIn: [],
      notOnWaitingList: [],
      noPlaceFor: [],
      confirmedAfter: 17,
      maxPlayers: 18,
      filled: false,
    } as never);
    const dm = dbMock.botJob.create.mock.calls.map((c) => c[0].data).find((d) => d.kind === "dm");
    // xask_picked_dm in Turkish: names the club he plays for; no home club looked up.
    expect(dm.text).toContain("*FNF* için oynuyorsun");
    expect(dbMock.organisation.findUnique).not.toHaveBeenCalled();
  });
});

describe("M1 (review of #400): a guest row with an old OWNER/ADMIN role is never an organiser", () => {
  it("isOrgAdmin is false for a live guest whose row still says ADMIN", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ ...POOL, role: "ADMIN" });
    expect(await isOrgAdmin("ali", "fnf")).toBe(false);
    dbMock.membership.findUnique.mockResolvedValue({ guestVia: "partner", guestFromOrgId: "sutton", guestMatchId: "m1", leftAt: null, role: "OWNER" });
    expect(await isOrgAdmin("ali", "fnf")).toBe(false);
    dbMock.membership.findUnique.mockResolvedValue({ guestVia: null, guestFromOrgId: null, guestMatchId: null, leftAt: null, role: "ADMIN" });
    expect(await isOrgAdmin("ali", "fnf")).toBe(true);
  });
  it("findOrgAdminsWithPhone asks for ordinary members only", async () => {
    dbMock.membership.findMany.mockResolvedValue([]);
    await findOrgAdminsWithPhone("fnf");
    expect(dbMock.membership.findMany.mock.calls.at(-1)![0].where).toMatchObject({ orgId: "fnf", leftAt: null, guestMatchId: null, role: { in: ["OWNER", "ADMIN"] } });
  });
});
