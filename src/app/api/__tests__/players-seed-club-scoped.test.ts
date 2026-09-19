/**
 * THE ADMIN SEED EDITOR READS THE CLUB'S NUMBER.
 *
 * Slice 4 of MDs/club-scoped-ratings-design-2026-09-18.md, section 8.3.
 * `/admin/players` and `/admin/players/ratings` are both fed by
 * `GET /api/players`, which was already scoped to the caller's org for
 * every field except the one that mattered: `seedRating` came off
 * `m.user`, the global column. An admin could open their club's seed
 * editor and be shown a number another club had typed, then "correct"
 * it and move that other club's balancer.
 *
 * The route now reads `m.seedRating`, the membership it is already
 * iterating. `next/server` is stubbed so the handler can be called
 * directly; auth / db / org are mocked. No live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const getUserOrg = vi.fn();
const membershipFindMany = vi.fn();

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
  },
}));

import { GET } from "@/app/api/players/route";

const SUTTON = "org-sutton";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "admin-1" } });
  getUserOrg.mockResolvedValue({ orgId: SUTTON });
});

/** A two-club player: 7 at this club, 3 on the deprecated global column
 *  because another club typed it there before the split. */
function twoClubPlayer() {
  return [
    {
      role: "PLAYER",
      leftAt: null,
      provisionallyAddedAt: null,
      seedRating: 7,
      user: {
        id: "user-1",
        name: "Erdal",
        email: "e@example.com",
        image: null,
        phoneNumber: null,
        seedRating: 3,
        isActive: true,
        activityPositions: [],
        _count: { attendances: 4 },
      },
    },
  ];
}

describe("GET /api/players", () => {
  it("returns this club's seed, not the global one", async () => {
    membershipFindMany.mockResolvedValue(twoClubPlayer());

    const res = (await GET(new Request("http://localhost/api/players"))) as unknown as {
      body: { players: Array<{ seedRating: number | null }> };
    };

    expect(res.body.players[0].seedRating).toBe(7);
  });

  it("reports an unseeded member as null rather than borrowing the global column", async () => {
    const rows = twoClubPlayer();
    rows[0].seedRating = null as unknown as number;
    membershipFindMany.mockResolvedValue(rows);

    const res = (await GET(new Request("http://localhost/api/players"))) as unknown as {
      body: { players: Array<{ seedRating: number | null }> };
    };

    expect(res.body.players[0].seedRating).toBeNull();
  });
});
