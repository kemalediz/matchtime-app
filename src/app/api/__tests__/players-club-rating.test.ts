/**
 * GET /api/players CARRIES EACH PLAYER'S CLUB RATING, FOR ADMINS ONLY.
 *
 * The admin roster (`/admin/players`) shows the club rating beside the
 * seed. Two rules pinned here:
 *
 *   - the ratings are read through the club: every rating query is
 *     filtered by `match.activity.orgId` = the caller's club, so a
 *     player's ratings at another club can never reach this page;
 *   - only an OWNER or ADMIN gets the numbers. A plain member calling
 *     the endpoint gets `clubRating: null` and no rating query runs.
 *
 * `next/server` is stubbed so the handler can be called directly; auth,
 * db and org are mocked. No live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const getUserOrg = vi.fn();
const membershipFindMany = vi.fn();
const ratingFindMany = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({ getUserOrg: (...a: unknown[]) => getUserOrg(...a) }));
vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) },
}));
vi.mock("@/lib/db", () => ({
  db: {
    activity: { findFirst: vi.fn().mockResolvedValue(null) },
    membership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    userAlias: { findMany: vi.fn().mockResolvedValue([]) },
    organisation: { findUnique: vi.fn().mockResolvedValue({ lastParticipantSweepAt: null }) },
    rating: { findMany: (...a: unknown[]) => ratingFindMany(...a) },
  },
}));

import { GET } from "@/app/api/players/route";

const CLUB = "org-sutton";

function member(id: string, name: string, seedRating: number | null) {
  return {
    role: "PLAYER",
    leftAt: null,
    provisionallyAddedAt: null,
    seedRating,
    user: {
      id,
      name,
      email: `${id}@example.com`,
      image: null,
      phoneNumber: null,
      isActive: true,
      activityPositions: [],
      _count: { attendances: 3 },
    },
  };
}

type Body = {
  players: Array<{ id: string; seedRating: number | null; clubRating: { rating: number | null; ratedGames: number } | null }>;
};

async function call(): Promise<Body> {
  const res = (await GET(new Request("http://localhost/api/players"))) as unknown as { body: Body };
  return res.body;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "admin-1" } });
  membershipFindMany.mockResolvedValue([member("riley", "Riley", 6), member("walt", "Walt", 8)]);
  ratingFindMany.mockResolvedValue([
    { playerId: "riley", matchId: "m1", score: 8 },
    { playerId: "riley", matchId: "m1", score: 7 },
  ]);
});

describe("GET /api/players: club rating", () => {
  for (const role of ["OWNER", "ADMIN"] as const) {
    it(`gives an ${role} each player's club rating beside the seed`, async () => {
      getUserOrg.mockResolvedValue({ orgId: CLUB, role });
      const body = await call();
      const riley = body.players.find((p) => p.id === "riley")!;
      const walt = body.players.find((p) => p.id === "walt")!;
      expect(riley.clubRating).toEqual({ rating: 7.5, ratedGames: 1 });
      expect(riley.seedRating).toBe(6);
      // Seeded 8 but never rated: the seed is not a rating.
      expect(walt.clubRating).toEqual({ rating: null, ratedGames: 0 });
      expect(walt.seedRating).toBe(8);
    });
  }

  it("reads ratings from the caller's club only", async () => {
    getUserOrg.mockResolvedValue({ orgId: CLUB, role: "OWNER" });
    await call();
    expect(ratingFindMany).toHaveBeenCalledTimes(1);
    const where = ratingFindMany.mock.calls[0][0].where;
    expect(where.match).toEqual({ activity: { orgId: CLUB } });
    expect(where.playerId).toEqual({ in: ["riley", "walt"] });
  });

  it("gives a plain member no ratings and runs no rating query", async () => {
    getUserOrg.mockResolvedValue({ orgId: CLUB, role: "PLAYER" });
    const body = await call();
    expect(body.players.every((p) => p.clubRating === null)).toBe(true);
    expect(ratingFindMany).not.toHaveBeenCalled();
  });
});
