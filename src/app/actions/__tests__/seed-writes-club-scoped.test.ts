/**
 * SEED WRITES BELONG TO A CLUB, NOT TO A PERSON.
 *
 * Slice 4 of MDs/club-scoped-ratings-design-2026-09-18.md. Slice 2 moved
 * the READ side onto `Membership.seedRating`; until this slice the WRITE
 * side still put the number on `User.seedRating`, a single global column.
 * The two halves disagreeing is worse than either being wrong on its own:
 * an admin typed a 7 into their club's seed editor, the global column
 * took it, and their club's balancer went on reading a membership row
 * that never changed.
 *
 * What these tests pin, in the order the design argues it:
 *
 *   1. `seedPlayerRating` writes the membership of the org it was
 *      authorised against, and no user row at all. Seeding a player at
 *      club A leaves club B's input untouched, which is decision 5 of
 *      section 2 in one sentence.
 *   2. A newly created player arrives with NO seed anywhere.
 *      `DEFAULT_SEED_RATING = 6` is gone (section 4.3): a new member
 *      carries no opinion, and the club-mean prior that slice 2 already
 *      ships is what stands in for one.
 *
 * auth / db / org / resolve-player / next-cache are mocked. No live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const requireOrgAdmin = vi.fn();
const userCreate = vi.fn();
const userUpdate = vi.fn();
const userUpdateMany = vi.fn();
const userFindUnique = vi.fn();
const membershipCreate = vi.fn();
const membershipUpdate = vi.fn();
const membershipUpdateMany = vi.fn();
const membershipFindUnique = vi.fn();
const findExistingOrgMember = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({
  requireOrgAdmin: (...a: unknown[]) => requireOrgAdmin(...a),
}));
vi.mock("@/lib/resolve-player", () => ({
  findExistingOrgMember: (...a: unknown[]) => findExistingOrgMember(...a),
}));
vi.mock("@/lib/merge-players-core", () => ({ mergePlayersCore: vi.fn() }));
vi.mock("@/lib/attendance-events", () => ({ recordAttendanceEvent: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    user: {
      create: (...a: unknown[]) => userCreate(...a),
      update: (...a: unknown[]) => userUpdate(...a),
      updateMany: (...a: unknown[]) => userUpdateMany(...a),
      findUnique: (...a: unknown[]) => userFindUnique(...a),
    },
    membership: {
      create: (...a: unknown[]) => membershipCreate(...a),
      update: (...a: unknown[]) => membershipUpdate(...a),
      updateMany: (...a: unknown[]) => membershipUpdateMany(...a),
      findUnique: (...a: unknown[]) => membershipFindUnique(...a),
    },
  },
}));

import { createPlayer, seedPlayerRating } from "@/app/actions/players";

const ADMIN = "admin-1";
const CLUB_A = "org-sutton";
const CLUB_B = "org-lads";
const PLAYER = "user-two-clubs";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: ADMIN } });
  requireOrgAdmin.mockResolvedValue(undefined);
  userCreate.mockResolvedValue({ id: "user-new" });
  userUpdate.mockResolvedValue({});
  userUpdateMany.mockResolvedValue({ count: 0 });
  userFindUnique.mockResolvedValue(null);
  membershipCreate.mockResolvedValue({ id: "mem-new" });
  membershipUpdate.mockResolvedValue({});
  membershipUpdateMany.mockResolvedValue({ count: 1 });
  membershipFindUnique.mockResolvedValue(null);
  findExistingOrgMember.mockResolvedValue(null);
});

/** Every `data` payload handed to any membership write, flattened. */
function membershipWrites(): Array<Record<string, unknown>> {
  return [...membershipCreate.mock.calls, ...membershipUpdate.mock.calls, ...membershipUpdateMany.mock.calls]
    .map((c) => c[0] as { data?: Record<string, unknown>; create?: Record<string, unknown> })
    .flatMap((a) => [a?.data, a?.create].filter(Boolean) as Array<Record<string, unknown>>);
}

/** Every `data` payload handed to any user write, flattened. */
function userWrites(): Array<Record<string, unknown>> {
  return [...userCreate.mock.calls, ...userUpdate.mock.calls, ...userUpdateMany.mock.calls]
    .map((c) => (c[0] as { data?: Record<string, unknown> })?.data)
    .filter(Boolean) as Array<Record<string, unknown>>;
}

describe("seedPlayerRating writes the club's opinion, not the person's", () => {
  it("writes Membership.seedRating for the org it authorised against", async () => {
    await seedPlayerRating(PLAYER, CLUB_A, 7);

    expect(requireOrgAdmin).toHaveBeenCalledWith(ADMIN, CLUB_A);
    const writes = membershipWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ seedRating: 7 });
  });

  it("scopes the write by BOTH userId and orgId, so club B cannot be hit", async () => {
    await seedPlayerRating(PLAYER, CLUB_A, 7);

    const call = (membershipUpdateMany.mock.calls[0]?.[0] ?? membershipUpdate.mock.calls[0]?.[0]) as {
      where: Record<string, unknown>;
    };
    // Either shape is acceptable: a flat {userId, orgId} filter or the
    // compound unique key. What is not acceptable is a filter that names
    // only the user, because that is the global column with extra steps.
    const where = JSON.stringify(call.where);
    expect(where).toContain(PLAYER);
    expect(where).toContain(CLUB_A);
    expect(where).not.toContain(CLUB_B);
  });

  it("never touches the User row", async () => {
    await seedPlayerRating(PLAYER, CLUB_A, 7);

    expect(userUpdate).not.toHaveBeenCalled();
    expect(userUpdateMany).not.toHaveBeenCalled();
    expect(userWrites()).toEqual([]);
  });

  it("rejects a player who is not a member of this club rather than writing nothing quietly", async () => {
    membershipUpdateMany.mockResolvedValue({ count: 0 });

    await expect(seedPlayerRating(PLAYER, CLUB_A, 7)).rejects.toThrow(/member/i);
  });

  it("still refuses a rating outside 1 to 10, before any write", async () => {
    await expect(seedPlayerRating(PLAYER, CLUB_A, 11)).rejects.toThrow(/between 1 and 10/);
    expect(membershipWrites()).toEqual([]);
  });
});

describe("a new player arrives with no seed anywhere", () => {
  it("creates a phone-identified player with no seedRating on the user and none on the membership", async () => {
    const res = await createPlayer(CLUB_A, "Yeni Oyuncu", "+447700900123");

    expect(res.ok).toBe(true);
    for (const data of userWrites()) {
      expect(data).not.toHaveProperty("seedRating");
      expect(data).not.toHaveProperty("matchRating");
    }
    for (const data of membershipWrites()) {
      expect(data).not.toHaveProperty("seedRating");
    }
  });

  it("creates a name-only guest with no seedRating either", async () => {
    const res = await createPlayer(CLUB_A, "Name Only Guest");

    expect(res.ok).toBe(true);
    for (const data of userWrites()) {
      expect(data).not.toHaveProperty("seedRating");
    }
    for (const data of membershipWrites()) {
      expect(data).not.toHaveProperty("seedRating");
    }
  });
});
