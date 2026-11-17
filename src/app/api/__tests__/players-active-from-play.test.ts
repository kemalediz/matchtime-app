/**
 * GET /api/players: `isActive` IS THIS CLUB'S REAL PLAY, NOT `User.isActive`.
 *
 * Sutton, 2026-11-17: Ersan Arik and Recai Gunay played that night and the
 * admin player pages still badged them "Inactive", because the field read
 * `User.isActive`, a global flag a rebuild script wrote once in April.
 * Pinned here, for admins and plain members alike:
 *
 *   - a member with a game at this club inside the window is active, even
 *     when his stale global flag says false;
 *   - a long-standing member with no game in the window is inactive, even
 *     when his global flag says true;
 *   - a member who joined inside the window and has not played yet is not
 *     inactive;
 *   - the whole roster costs ONE grouped attendance query.
 *
 * `next/server` is stubbed; auth, db and org are mocked. No live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const getUserOrg = vi.fn();
const membershipFindMany = vi.fn();
const attendanceGroupBy = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({
  getUserOrg: (...a: unknown[]) => getUserOrg(...a),
  isSuperadmin: vi.fn().mockResolvedValue(false),
}));
vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) },
}));
vi.mock("@/lib/db", () => ({
  db: {
    activity: { findFirst: vi.fn().mockResolvedValue(null) },
    membership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    attendance: { groupBy: (...a: unknown[]) => attendanceGroupBy(...a) },
    userAlias: { findMany: vi.fn().mockResolvedValue([]) },
    organisation: { findUnique: vi.fn().mockResolvedValue({ lastParticipantSweepAt: null }) },
    rating: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { GET } from "@/app/api/players/route";

const CLUB = "org-sutton";
const LONG_AGO = new Date("2026-04-18T22:25:04Z");

function member(id: string, globalIsActive: boolean, joinedAt: Date) {
  return {
    role: "PLAYER",
    leftAt: null,
    provisionallyAddedAt: null,
    createdAt: joinedAt,
    seedRating: null,
    user: {
      id,
      name: id,
      email: `${id}@example.com`,
      image: null,
      phoneNumber: null,
      isActive: globalIsActive,
      activityPositions: [],
      _count: { attendances: 3, memberships: 1 },
    },
  };
}

type Body = { players: Array<{ id: string; isActive: boolean }> };

async function call(): Promise<Body> {
  const res = (await GET(new Request("http://localhost/api/players"))) as unknown as { body: Body };
  return res.body;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "admin-1" } });
  membershipFindMany.mockResolvedValue([
    member("ersan", false, LONG_AGO), // stale global false, played this week
    member("akin", true, LONG_AGO), // global true, no game in months
    member("newbie", true, new Date(Date.now() - 2 * 86_400_000)), // joined 2 days ago
  ]);
  attendanceGroupBy.mockResolvedValue([{ userId: "ersan" }]);
});

describe("GET /api/players: isActive from this club's real play", () => {
  for (const role of ["OWNER", "PLAYER"] as const) {
    it(`derives it per club for a ${role}`, async () => {
      getUserOrg.mockResolvedValue({ orgId: CLUB, role });
      const body = await call();
      const active = Object.fromEntries(body.players.map((p) => [p.id, p.isActive]));
      expect(active).toEqual({ ersan: true, akin: false, newbie: true });
    });
  }

  it("asks one grouped attendance query for the roster, in this club only", async () => {
    getUserOrg.mockResolvedValue({ orgId: CLUB, role: "OWNER" });
    await call();
    expect(attendanceGroupBy).toHaveBeenCalledTimes(1);
    const where = attendanceGroupBy.mock.calls[0][0].where;
    expect(where.userId).toEqual({ in: ["ersan", "akin", "newbie"] });
    expect(where.match.activity).toEqual({ orgId: CLUB });
  });
});
