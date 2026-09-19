/**
 * THE BALANCER'S INPUT IS CLUB-SCOPED, AND THE QUERY IS THE PROOF.
 *
 * Slice 2 of `MDs/club-scoped-ratings-design-2026-09-18.md`. Until
 * today `generateTeamsForMatch` asked Postgres for "this player's 60
 * most recent ratings" with no org filter at all, so a Sutton FC team
 * sheet was partly decided by Sutton Lads, a club that removed
 * MatchTime in June and will never correct itself. Nine of Sutton's 43
 * rated members were carrying a wrong number into the draft.
 *
 * The failure mode this file guards is a FORGOTTEN FILTER, not wrong
 * arithmetic, so the assertions are on the shape of the calls rather
 * than on a line-up:
 *
 *   1. `rating.findMany` carries `match: { activity: { orgId } }`, and
 *      the orgId is the match's own.
 *   2. The 60-row window is applied by the database, on the filtered
 *      set. Fetching 60 globally and filtering in JS would let a dead
 *      club EVICT this club's ratings before the code ever sees them,
 *      which is exactly what happened to Ehtisham (65 ratings, window
 *      truncated at 60, Lads rows pushing Sutton rows out).
 *   3. The seed comes from `Membership` for this org, not from `User`.
 *   4. The club mean is ONE aggregate per generation, not one per
 *      player. Fourteen identical aggregates per sheet is a bug even
 *      though it returns the right answer.
 *
 * db, the LLM adjuster and next/cache are mocked. No DB, no network,
 * no model call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const MATCH_ID = "match-1";
const ORG_ID = "org-sutton-fc";

const SQUAD = [
  { id: "u-a", name: "Ayse", seed: 9 },
  { id: "u-b", name: "Bilal", seed: 8 },
  { id: "u-c", name: "Cem", seed: 6 },
  { id: "u-d", name: "Deniz", seed: 4 },
  { id: "u-e", name: "Emre", seed: 3 },
  { id: "u-f", name: "Faruk", seed: 5 },
];

/** Every argument object the run handed to Prisma, per model+method,
 *  so a test can assert on what reached the database. */
let ratingFindManyArgs: Record<string, unknown>[] = [];
let ratingAggregateArgs: Record<string, unknown>[] = [];
let membershipFindManyArgs: Record<string, unknown>[] = [];
let userFindArgs: Record<string, unknown>[] = [];

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/rating-adjuster", () => ({
  adjustRatings: () => Promise.resolve(new Map()),
  runRatingAdjuster: () => Promise.resolve(new Map()),
}));
vi.mock("@/lib/db", () => ({
  db: {
    match: {
      findUnique: () => Promise.resolve(buildMatchRow()),
      update: () => Promise.resolve({}),
    },
    teamAssignment: {
      deleteMany: () => Promise.resolve({ count: 0 }),
      createMany: () => Promise.resolve({ count: 0 }),
    },
    rating: {
      findMany: (args: Record<string, unknown>) => {
        ratingFindManyArgs.push(args);
        return Promise.resolve([{ score: 7 }, { score: 7 }, { score: 7 }]);
      },
      aggregate: (args: Record<string, unknown>) => {
        ratingAggregateArgs.push(args);
        return Promise.resolve({ _avg: { score: 6.674 } });
      },
    },
    membership: {
      findMany: (args: Record<string, unknown>) => {
        membershipFindManyArgs.push(args);
        return Promise.resolve(
          SQUAD.map((p) => ({ userId: p.id, seedRating: p.seed })),
        );
      },
      findUnique: (args: Record<string, unknown>) => {
        membershipFindManyArgs.push(args);
        return Promise.resolve({ userId: "u-a", seedRating: 9 });
      },
    },
    // GLOBAL reads that must NOT be how the seed arrives any more.
    user: {
      findMany: (args: Record<string, unknown>) => {
        userFindArgs.push(args);
        return Promise.resolve([]);
      },
      findUnique: (args: Record<string, unknown>) => {
        userFindArgs.push(args);
        return Promise.resolve(null);
      },
    },
    analyzedMessage: { findMany: () => Promise.resolve([]) },
    ratingAdjustment: { upsert: () => Promise.resolve({}) },
    botJob: {
      create: () => Promise.resolve({}),
      createMany: () => Promise.resolve({}),
      upsert: () => Promise.resolve({}),
    },
  },
}));

import { generateTeamsForMatch } from "@/lib/team-generation";

function buildMatchRow() {
  return {
    id: MATCH_ID,
    activityId: "act-1",
    date: new Date("2026-09-22T19:30:00Z"),
    status: "UPCOMING",
    teamLabels: [],
    activity: {
      orgId: ORG_ID,
      venue: "The Cage",
      org: { id: ORG_ID, name: "Sutton Football Club", teamLabels: [], language: "en" },
      sport: {
        name: "Football 3-a-side",
        playersPerTeam: 3,
        balancingStrategy: "rating-only",
        positionComposition: null,
        teamLabels: [],
      },
    },
    attendances: SQUAD.map((p) => ({
      userId: p.id,
      user: {
        name: p.name,
        image: null,
        // Left on the row on purpose. Slice 7 removes the column; until
        // then a regression that reads it would silently pass unless a
        // test says where the seed must come from.
        seedRating: 1,
        matchRating: 1000,
        activityPositions: [],
      },
    })),
  };
}

/** Walk a Prisma `where` object looking for the org filter, wherever
 *  the implementation chose to hang it. */
function orgIdInWhere(where: unknown): string | undefined {
  if (!where || typeof where !== "object") return undefined;
  const w = where as Record<string, unknown>;
  if (typeof w.orgId === "string") return w.orgId;
  for (const v of Object.values(w)) {
    const found = orgIdInWhere(v);
    if (found !== undefined) return found;
  }
  return undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  ratingFindManyArgs = [];
  ratingAggregateArgs = [];
  membershipFindManyArgs = [];
  userFindArgs = [];
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the balancer's rating input is club-scoped", () => {
  it("every rating.findMany filters through match.activity.orgId", async () => {
    await generateTeamsForMatch(MATCH_ID);

    expect(ratingFindManyArgs.length).toBeGreaterThan(0);
    for (const args of ratingFindManyArgs) {
      const where = args.where as Record<string, unknown> | undefined;
      const match = where?.match as { activity?: { orgId?: string } } | undefined;
      expect(match?.activity?.orgId).toBe(ORG_ID);
    }
  });

  it("one rating.findMany per confirmed player, each for that player", async () => {
    await generateTeamsForMatch(MATCH_ID);

    const playerIds = ratingFindManyArgs.map(
      (a) => (a.where as { playerId?: string }).playerId,
    );
    expect(playerIds.sort()).toEqual(SQUAD.map((p) => p.id).sort());
  });

  it("the 60-row window is applied by the database, on the club-filtered set", async () => {
    // `take: 60` next to the org filter in the same query is the whole
    // point: 60 Sutton rows, not "60 rows from anywhere, then drop the
    // ones that are not Sutton's".
    await generateTeamsForMatch(MATCH_ID);

    for (const args of ratingFindManyArgs) {
      expect(args.take).toBe(60);
      expect(args.orderBy).toEqual({ createdAt: "desc" });
      const match = (args.where as { match?: { activity?: { orgId?: string } } }).match;
      expect(match?.activity?.orgId).toBe(ORG_ID);
    }
  });

  it("the seed comes from Membership for this org, never from User", async () => {
    await generateTeamsForMatch(MATCH_ID);

    expect(membershipFindManyArgs.length).toBeGreaterThan(0);
    for (const args of membershipFindManyArgs) {
      expect(orgIdInWhere(args.where)).toBe(ORG_ID);
    }
    // The fixture's User.seedRating is 1 for everybody. A run that read
    // it would produce a flat squad; a run that read Membership gets
    // the 9/8/6/4/3/5 spread. Belt and braces on top of the call count.
    expect(userFindArgs.length).toBe(0);
  });

  it("the club mean is ONE aggregate per generation, not one per player", async () => {
    await generateTeamsForMatch(MATCH_ID);

    expect(ratingAggregateArgs.length).toBe(1);
    const where = ratingAggregateArgs[0].where as {
      match?: { activity?: { orgId?: string } };
    };
    expect(where?.match?.activity?.orgId).toBe(ORG_ID);
    expect(ratingAggregateArgs[0]._avg).toEqual({ score: true });
  });

  it("the membership seeds are read in one query, not one per player", async () => {
    await generateTeamsForMatch(MATCH_ID);
    expect(membershipFindManyArgs.length).toBe(1);
  });
});
