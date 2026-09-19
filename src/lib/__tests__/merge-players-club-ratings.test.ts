/**
 * A MERGE COMBINES TWO HISTORIES. IT MUST DO IT ONE CLUB AT A TIME.
 *
 * Slice 4 of MDs/club-scoped-ratings-design-2026-09-18.md. Until this
 * slice the merge backfilled `User.seedRating` and `User.matchRating`,
 * two global columns, from the dropped record. That is exactly wrong for
 * the case the whole design is about: a person with a row at two clubs,
 * duplicated at one of them. The old code took ONE seed off the dropped
 * record and applied it to the person everywhere, so merging a duplicate
 * at Sutton could set the number the Lads' balancer reads.
 *
 * THE RULE THIS FILE PINS, per club, never across clubs:
 *
 *   - seed: the keeper's membership wins whenever it HAS a seed. The
 *     dropped row's seed is carried over only into a membership that has
 *     none. Same rule the global column used, now applied per org, and
 *     the same "the keeper is the row with the real history" convention
 *     the rest of this function already follows for a colliding rating.
 *   - Elo: the keeper wins unless its number is still the untouched
 *     default 1000, which means "no information" and loses to a number
 *     that was actually played for.
 *   - a club where only the DROPPED row is a member: its membership row
 *     is re-pointed whole, so both numbers travel with it untouched.
 *   - neither number is ever written onto the User row again.
 *
 * The stub `tx` is the transaction client the real code is handed, so a
 * write escaping onto the module-level `db` would be a write outside the
 * transaction. The mocked `db` here has nothing but `$transaction` on
 * it, so such an escape throws rather than passing quietly.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const requireOrgAdmin = vi.fn();
const transaction = vi.fn();
const dbMembershipFindUnique = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: (...a: unknown[]) => requireOrgAdmin(...a) }));
vi.mock("@/lib/resolve-player", () => ({ findExistingOrgMember: vi.fn() }));
vi.mock("@/lib/attendance-events", () => ({ recordAttendanceEvent: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    membership: { findUnique: (...a: unknown[]) => dbMembershipFindUnique(...a) },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}));

import { mergePlayers } from "@/app/actions/players";

const ADMIN = "admin-1";
const SUTTON = "org-sutton";
const LADS = "org-lads";
const KEEP = "user-keep";
const DROP = "user-drop";

interface MembershipRow {
  id: string;
  userId: string;
  orgId: string;
  role: string;
  leftAt: Date | null;
  provisionallyAddedAt: Date | null;
  lastSeenInGroupAt: Date | null;
  seedRating: number | null;
  matchRating: number;
}

interface Recorded {
  membershipUpdates: Array<{ id: string; data: Record<string, unknown> }>;
  userUpdates: Array<Record<string, unknown>>;
}

/**
 * The whole Prisma surface `mergePlayersCore` touches, stubbed. Every
 * relation scan returns nothing except the memberships under test, so
 * the run is the membership branch and the bookkeeping either side of it.
 */
function makeTx(args: {
  keep: { seedRating: number | null; matchRating: number };
  drop: { seedRating: number | null; matchRating: number };
  memberships: MembershipRow[];
  rec: Recorded;
}) {
  const memberships = [...args.memberships];
  const none = vi.fn().mockResolvedValue([]);
  const nothing = vi.fn().mockResolvedValue(null);
  const noop = vi.fn().mockResolvedValue({ count: 0 });
  const relation = () => ({
    findMany: none,
    findUnique: nothing,
    findFirst: nothing,
    update: vi.fn().mockResolvedValue({}),
    updateMany: noop,
    delete: vi.fn().mockResolvedValue({}),
    deleteMany: noop,
    upsert: vi.fn().mockResolvedValue({}),
  });
  return {
    user: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === KEEP
            ? { id: KEEP, name: "Keeper", email: "keep@example.com", phoneNumber: "+1", ...args.keep }
            : { id: DROP, name: "Dropped", email: "drop@example.com", phoneNumber: null, ...args.drop },
        ),
      ),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (where.id === KEEP) args.rec.userUpdates.push(data);
        return Promise.resolve({});
      }),
      delete: vi.fn().mockResolvedValue({}),
    },
    match: { findUnique: vi.fn().mockResolvedValue({ activity: { orgId: SUTTON } }) },
    attendance: relation(),
    rating: relation(),
    moMVote: relation(),
    teamAssignment: relation(),
    playerActivityPosition: relation(),
    analyzedMessage: relation(),
    ratingAdjustment: relation(),
    rosterSurveyDM: relation(),
    rosterSurveyResponse: relation(),
    userAlias: relation(),
    account: relation(),
    session: relation(),
    userMerge: { create: vi.fn().mockResolvedValue({}) },
    membership: {
      findMany: vi.fn(({ where }: { where: { userId: string } }) =>
        Promise.resolve(memberships.filter((m) => m.userId === where.userId)),
      ),
      findUnique: vi.fn(({ where }: { where: { userId_orgId: { userId: string; orgId: string } } }) =>
        Promise.resolve(
          memberships.find(
            (m) => m.userId === where.userId_orgId.userId && m.orgId === where.userId_orgId.orgId,
          ) ?? null,
        ),
      ),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        args.rec.membershipUpdates.push({ id: where.id, data });
        const row = memberships.find((m) => m.id === where.id);
        if (row) Object.assign(row, data);
        return Promise.resolve(row ?? {});
      }),
      delete: vi.fn(({ where }: { where: { id: string } }) => {
        const i = memberships.findIndex((m) => m.id === where.id);
        if (i >= 0) memberships.splice(i, 1);
        return Promise.resolve({});
      }),
    },
  };
}

function membership(over: Partial<MembershipRow> & { id: string; userId: string; orgId: string }): MembershipRow {
  return {
    role: "PLAYER",
    leftAt: null,
    provisionallyAddedAt: null,
    lastSeenInGroupAt: null,
    seedRating: null,
    matchRating: 1000,
    ...over,
  };
}

async function runMerge(args: {
  keep: { seedRating: number | null; matchRating: number };
  drop: { seedRating: number | null; matchRating: number };
  memberships: MembershipRow[];
}): Promise<Recorded & { txOptions: unknown }> {
  const rec: Recorded = { membershipUpdates: [], userUpdates: [] };
  const tx = makeTx({ ...args, rec });
  let txOptions: unknown;
  transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>, opts: unknown) => {
    txOptions = opts;
    return fn(tx);
  });
  // Both players must be members of the admin's org for the action to run.
  dbMembershipFindUnique.mockResolvedValue({ id: "any" });
  await mergePlayers(SUTTON, KEEP, DROP);
  return { ...rec, txOptions };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: ADMIN } });
  requireOrgAdmin.mockResolvedValue(undefined);
});

describe("the merge carries the seed per club", () => {
  it("fills an unseeded keeper membership from the dropped one, at that club only", async () => {
    const rec = await runMerge({
      keep: { seedRating: null, matchRating: 1000 },
      drop: { seedRating: null, matchRating: 1000 },
      memberships: [
        membership({ id: "k-sutton", userId: KEEP, orgId: SUTTON, seedRating: null }),
        membership({ id: "d-sutton", userId: DROP, orgId: SUTTON, seedRating: 8 }),
        membership({ id: "k-lads", userId: KEEP, orgId: LADS, seedRating: 4 }),
      ],
      });

    const sutton = rec.membershipUpdates.find((u) => u.id === "k-sutton");
    expect(sutton?.data).toMatchObject({ seedRating: 8 });
    // The Lads membership is not in the merge at all: the dropped record
    // was never a member there, so nothing about it may move.
    expect(rec.membershipUpdates.some((u) => u.id === "k-lads")).toBe(false);
  });

  it("keeps the keeper's own seed when both clubs' rows have one", async () => {
    const rec = await runMerge({
      keep: { seedRating: null, matchRating: 1000 },
      drop: { seedRating: null, matchRating: 1000 },
      memberships: [
        membership({ id: "k-sutton", userId: KEEP, orgId: SUTTON, seedRating: 6 }),
        membership({ id: "d-sutton", userId: DROP, orgId: SUTTON, seedRating: 9 }),
      ],
    });

    const sutton = rec.membershipUpdates.find((u) => u.id === "k-sutton");
    expect(sutton?.data.seedRating).toBe(6);
  });

  it("re-points a whole membership row at a club where only the dropped record was a member", async () => {
    const rec = await runMerge({
      keep: { seedRating: null, matchRating: 1000 },
      drop: { seedRating: null, matchRating: 1000 },
      memberships: [
        membership({ id: "k-sutton", userId: KEEP, orgId: SUTTON }),
        membership({ id: "d-sutton", userId: DROP, orgId: SUTTON }),
        membership({ id: "d-lads", userId: DROP, orgId: LADS, seedRating: 7, matchRating: 1180 }),
      ],
    });

    const lads = rec.membershipUpdates.find((u) => u.id === "d-lads");
    expect(lads?.data).toEqual({ userId: KEEP });
    // Carried whole, so the Lads' opinion of this person is untouched.
    expect(lads?.data).not.toHaveProperty("seedRating");
  });
});

describe("the merge carries the Elo per club", () => {
  it("takes the dropped club Elo when the keeper's is still the 1000 default", async () => {
    const rec = await runMerge({
      keep: { seedRating: null, matchRating: 1000 },
      drop: { seedRating: null, matchRating: 1000 },
      memberships: [
        membership({ id: "k-sutton", userId: KEEP, orgId: SUTTON, matchRating: 1000 }),
        membership({ id: "d-sutton", userId: DROP, orgId: SUTTON, matchRating: 1240 }),
      ],
    });

    expect(rec.membershipUpdates.find((u) => u.id === "k-sutton")?.data).toMatchObject({
      matchRating: 1240,
    });
  });

  it("keeps the keeper's club Elo once it has moved off 1000", async () => {
    const rec = await runMerge({
      keep: { seedRating: null, matchRating: 1000 },
      drop: { seedRating: null, matchRating: 1000 },
      memberships: [
        membership({ id: "k-sutton", userId: KEEP, orgId: SUTTON, matchRating: 1060 }),
        membership({ id: "d-sutton", userId: DROP, orgId: SUTTON, matchRating: 1240 }),
      ],
    });

    expect(rec.membershipUpdates.find((u) => u.id === "k-sutton")?.data.matchRating).toBe(1060);
  });
});

describe("the merge stops writing the global columns", () => {
  it("never patches User.seedRating or User.matchRating, even when the drop record has both", async () => {
    const rec = await runMerge({
      keep: { seedRating: null, matchRating: 1000 },
      drop: { seedRating: 9, matchRating: 1400 },
      memberships: [
        membership({ id: "k-sutton", userId: KEEP, orgId: SUTTON }),
        membership({ id: "d-sutton", userId: DROP, orgId: SUTTON }),
      ],
    });

    for (const patch of rec.userUpdates) {
      expect(patch).not.toHaveProperty("seedRating");
      expect(patch).not.toHaveProperty("matchRating");
    }
  });

  it("still runs inside one interactive transaction with the 60s timeout", async () => {
    const rec = await runMerge({
      keep: { seedRating: null, matchRating: 1000 },
      drop: { seedRating: null, matchRating: 1000 },
      memberships: [
        membership({ id: "k-sutton", userId: KEEP, orgId: SUTTON }),
        membership({ id: "d-sutton", userId: DROP, orgId: SUTTON }),
      ],
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(rec.txOptions).toEqual({ timeout: 60_000 });
  });
});
