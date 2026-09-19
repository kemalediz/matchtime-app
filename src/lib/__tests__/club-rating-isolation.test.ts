/**
 * THE LOAD-BEARING TEST: A RATING GIVEN IN CLUB A CANNOT CHANGE A
 * PLAYER'S RATING, DRAFT POSITION OR TEAM IN CLUB B.
 *
 * Section 10.1 of `MDs/club-scoped-ratings-design-2026-09-18.md`. It is
 * written as a property, not as an example, because the property is the
 * whole design: "nothing on the right-hand side can be affected by
 * another club".
 *
 * The method is a difference, which is what makes it unmissable. Club
 * B's team sheet is generated TWICE over the same fixture: once with
 * club A's ratings present in the database, once with them deleted.
 * Every observable of club B's run must be byte-identical between the
 * two. Then the inverse, with the clubs swapped.
 *
 * ── WHAT THIS LOOKED LIKE BEFORE THE FIX ─────────────────────────────
 *
 * Under the old query (`rating.findMany({ where: { playerId }, take: 60 })`,
 * no org filter at all) the shared player P below rates
 *
 *   with club A present   (9x10 + 4x2 + 6x3) / (12 + 3) = 7.733
 *   with club A deleted   (       4x2 + 6x3) / ( 2 + 3) = 5.200
 *
 * a swing of 2.533 caused entirely by a club P does not play for, and
 * it moved P from fifth in club B's draft to third, and off one team
 * and onto the other. This is not hypothetical: Sutton Lads removed
 * MatchTime in June 2026 and its dead ratings were still picking Sutton
 * FC's Tuesday sides, worst of all for Amir (6.424 against a
 * club-only 7.037, thirtieth in the draft against a club-only
 * thirteenth).
 *
 * ── WHY THE ASSERTIONS ARE WHAT THEY ARE ─────────────────────────────
 *
 * `balancePositionAware` ends in a 1,000-iteration hill-climb driven by
 * `Math.random()`, so a partition comparison on that strategy measures
 * coin flips. The fixture therefore uses `rating-only`, which has no
 * hill-climb and is fully deterministic, and `Math.random` is stubbed
 * as belt and braces. The primary assertions are the RATING VECTOR and
 * the DRAFT ORDER, which are what a rating formula actually decides;
 * the partition is asserted on top because for this fixture it is
 * deterministic and it is the thing the club sees.
 *
 * db, the LLM adjuster and next/cache are mocked. No DB, no network,
 * no model call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PlayerWithRating } from "@/types";

// ───────────────────────── the two-club world ─────────────────────────

const ORG_A = "org-sutton-lads"; // the churned club whose ratings kept voting
const ORG_B = "org-sutton-fc"; // the live club, real money on the fixture

/** The player who is a member of both. */
const P = { id: "u-p", name: "Pelin" };

/** Club B's other five. Their ratings live only in club B. */
const B_OTHERS = [
  { id: "u-b1", name: "Bora", seed: 9, peer: 9 },
  { id: "u-b2", name: "Burak", seed: 8, peer: 8 },
  { id: "u-b3", name: "Berk", seed: 7, peer: 7 },
  { id: "u-b4", name: "Baris", seed: 6, peer: 6 },
  { id: "u-b5", name: "Baran", seed: 3, peer: 3 },
];

/** Club A's other five. Their ratings live only in club A. */
const A_OTHERS = [
  { id: "u-a1", name: "Ali", seed: 9, peer: 9 },
  { id: "u-a2", name: "Arda", seed: 8, peer: 8 },
  { id: "u-a3", name: "Alp", seed: 7, peer: 7 },
  { id: "u-a4", name: "Ayhan", seed: 6, peer: 6 },
  { id: "u-a5", name: "Asim", seed: 3, peer: 3 },
];

/** P carries the same seed at both clubs, so every difference the test
 *  can see comes from the RATINGS and not from the prior. */
const P_SEED = 6;

interface RatingRow {
  playerId: string;
  orgId: string;
  score: number;
  createdAt: Date;
}

/** The whole `Rating` table, as rows. Tests mutate this between runs to
 *  express "and now club A's ratings do not exist". */
let ratingRows: RatingRow[] = [];

function baseRatingRows(): RatingRow[] {
  const rows: RatingRow[] = [];
  let t = 0;
  const push = (playerId: string, orgId: string, score: number) => {
    rows.push({ playerId, orgId, score, createdAt: new Date(1_700_000_000_000 + t++ * 1000) });
  };
  // P: ten 9s at the club he has left, two 4s at the club he plays for.
  for (let i = 0; i < 10; i++) push(P.id, ORG_A, 9);
  for (let i = 0; i < 2; i++) push(P.id, ORG_B, 4);
  // Everyone else, three ratings each, inside their own club only.
  for (const o of B_OTHERS) for (let i = 0; i < 3; i++) push(o.id, ORG_B, o.peer);
  for (const o of A_OTHERS) for (let i = 0; i < 3; i++) push(o.id, ORG_A, o.peer);
  return rows;
}

const MATCH_B = "match-b";
const MATCH_A = "match-a";

/** What the balancer was handed, captured per run. */
let balancerInput: PlayerWithRating[] = [];

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/rating-adjuster", () => ({
  // The adjuster is an LLM margin on top of the base vector and it
  // would drown the signal. Neutralised, not stubbed away: the base
  // vector IS the claim.
  adjustRatings: () => Promise.resolve(new Map()),
  runRatingAdjuster: () => Promise.resolve(new Map()),
}));
vi.mock("@/lib/team-balancer", async () => {
  const actual = await vi.importActual<typeof import("@/lib/team-balancer")>(
    "@/lib/team-balancer",
  );
  return {
    ...actual,
    balanceTeams: (opts: Parameters<typeof actual.balanceTeams>[0]) => {
      balancerInput = opts.players.map((p) => ({ ...p }));
      return actual.balanceTeams(opts);
    },
  };
});
vi.mock("@/lib/db", () => ({
  db: {
    match: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(args.where.id === MATCH_A ? buildMatch(ORG_A) : buildMatch(ORG_B)),
      update: () => Promise.resolve({}),
    },
    teamAssignment: {
      deleteMany: () => Promise.resolve({ count: 0 }),
      createMany: (args: unknown) => {
        teamWrites.push(args);
        return Promise.resolve({ count: 0 });
      },
    },
    rating: {
      // A faithful little Prisma: it honours `where.playerId`, the
      // optional `where.match.activity.orgId`, `orderBy.createdAt` and
      // `take`. The ORDER of those last two is the point: `take`
      // applies AFTER the org filter, exactly as Postgres would, so a
      // dead club cannot evict a live one from the 60-row window.
      findMany: (args: {
        where: { playerId?: string; match?: { activity?: { orgId?: string } } };
        orderBy?: { createdAt?: "asc" | "desc" };
        take?: number;
      }) => {
        const orgId = args.where?.match?.activity?.orgId;
        let rows = ratingRows.filter((r) => r.playerId === args.where?.playerId);
        if (orgId) rows = rows.filter((r) => r.orgId === orgId);
        rows = [...rows].sort(
          (a, b) =>
            args.orderBy?.createdAt === "asc"
              ? a.createdAt.getTime() - b.createdAt.getTime()
              : b.createdAt.getTime() - a.createdAt.getTime(),
        );
        if (args.take) rows = rows.slice(0, args.take);
        return Promise.resolve(rows.map((r) => ({ score: r.score, createdAt: r.createdAt })));
      },
      aggregate: (args: { where?: { match?: { activity?: { orgId?: string } } } }) => {
        const orgId = args.where?.match?.activity?.orgId;
        const rows = orgId ? ratingRows.filter((r) => r.orgId === orgId) : ratingRows;
        const avg = rows.length
          ? rows.reduce((s, r) => s + r.score, 0) / rows.length
          : null;
        return Promise.resolve({ _avg: { score: avg } });
      },
    },
    membership: {
      findMany: (args: { where: { orgId?: string; userId?: { in?: string[] } } }) => {
        const orgId = args.where?.orgId;
        const wanted = args.where?.userId?.in;
        const all = [
          { userId: P.id, orgId: ORG_A, seedRating: P_SEED },
          { userId: P.id, orgId: ORG_B, seedRating: P_SEED },
          ...B_OTHERS.map((o) => ({ userId: o.id, orgId: ORG_B, seedRating: o.seed })),
          ...A_OTHERS.map((o) => ({ userId: o.id, orgId: ORG_A, seedRating: o.seed })),
        ];
        return Promise.resolve(
          all
            .filter((m) => (orgId ? m.orgId === orgId : true))
            .filter((m) => (wanted ? wanted.includes(m.userId) : true))
            .map((m) => ({ userId: m.userId, seedRating: m.seedRating })),
        );
      },
    },
    user: { findMany: () => Promise.resolve([]), findUnique: () => Promise.resolve(null) },
    analyzedMessage: { findMany: () => Promise.resolve([]) },
    ratingAdjustment: { upsert: () => Promise.resolve({}) },
    botJob: {
      create: () => Promise.resolve({}),
      createMany: () => Promise.resolve({}),
      upsert: () => Promise.resolve({}),
    },
  },
}));

let teamWrites: unknown[] = [];

import { generateTeamsForMatch } from "@/lib/team-generation";

function buildMatch(orgId: string) {
  const others = orgId === ORG_A ? A_OTHERS : B_OTHERS;
  return {
    id: orgId === ORG_A ? MATCH_A : MATCH_B,
    activityId: orgId === ORG_A ? "act-a" : "act-b",
    date: new Date("2026-09-22T19:30:00Z"),
    status: "UPCOMING",
    teamLabels: [],
    activity: {
      orgId,
      venue: "The Cage",
      org: { id: orgId, name: orgId, teamLabels: [], language: "en" },
      sport: {
        name: "Football 3-a-side",
        playersPerTeam: 3,
        // No hill-climb: the sheet is a function of the ratings alone.
        balancingStrategy: "rating-only",
        positionComposition: null,
        teamLabels: [],
      },
    },
    attendances: [P, ...others].map((p) => ({
      userId: p.id,
      user: {
        name: p.name,
        image: null,
        // The old GLOBAL column, still present until slice 7. Set to the
        // same value the membership carries so that if a regression
        // reads it the test fails on the RATINGS, which is the claim,
        // rather than on an unrelated seed mismatch.
        seedRating: "seed" in p ? (p as { seed: number }).seed : P_SEED,
        matchRating: 1000,
        activityPositions: [],
      },
    })),
  };
}

/** One run of club X's generation, reduced to the three observables. */
async function runSheet(matchId: string) {
  balancerInput = [];
  teamWrites = [];
  await generateTeamsForMatch(matchId);
  const ratings = new Map(balancerInput.map((p) => [p.name, p.rating] as const));
  const draftOrder = [...balancerInput]
    .sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name))
    .map((p) => p.name);
  const create = teamWrites[0] as { data: { userId: string; team: string }[] } | undefined;
  const nameOf = (id: string) =>
    id === P.id ? P.name : [...B_OTHERS, ...A_OTHERS].find((o) => o.id === id)!.name;
  const partition = (create?.data ?? [])
    .map((r) => `${nameOf(r.userId)}:${r.team}`)
    .sort();
  return { ratings, draftOrder, partition };
}

beforeEach(() => {
  vi.clearAllMocks();
  ratingRows = baseRatingRows();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a rating given in club A cannot change a player's team sheet in club B", () => {
  it("club B's rating vector, draft order and partition are identical with and without club A's ratings", async () => {
    const withA = await runSheet(MATCH_B);

    // Club A's ratings never happened.
    ratingRows = ratingRows.filter((r) => r.orgId !== ORG_A);
    const withoutA = await runSheet(MATCH_B);

    expect(Object.fromEntries(withoutA.ratings)).toEqual(
      Object.fromEntries(withA.ratings),
    );
    expect(withoutA.draftOrder).toEqual(withA.draftOrder);
    expect(withoutA.partition).toEqual(withA.partition);
  });

  it("the shared player's club B number is the club B arithmetic and nothing else", async () => {
    const { ratings } = await runSheet(MATCH_B);
    // (4 + 4 + 6*3) / (2 + 3) = 5.2. Under the old global query it was
    // 7.733, because ten 9s from a club he left outvoted his own club.
    expect(ratings.get(P.name)).toBeCloseTo(5.2, 10);
  });

  it("the inverse: deleting club B's ratings does not change club A's sheet", async () => {
    const withB = await runSheet(MATCH_A);

    ratingRows = ratingRows.filter((r) => r.orgId !== ORG_B);
    const withoutB = await runSheet(MATCH_A);

    expect(Object.fromEntries(withoutB.ratings)).toEqual(
      Object.fromEntries(withB.ratings),
    );
    expect(withoutB.draftOrder).toEqual(withB.draftOrder);
    expect(withoutB.partition).toEqual(withB.partition);
  });

  it("the same player carries a different number at each club, and both are that club's own", async () => {
    const atB = (await runSheet(MATCH_B)).ratings.get(P.name)!;
    const atA = (await runSheet(MATCH_A)).ratings.get(P.name)!;
    // Club A: (9*10 + 6*3) / (10 + 3) = 108/13 = 8.3077
    expect(atA).toBeCloseTo(108 / 13, 10);
    expect(atB).toBeCloseTo(5.2, 10);
    expect(atA).not.toBeCloseTo(atB, 3);
  });

  it("the 60-row window is per club, so a dead club cannot evict a live one", async () => {
    // Ehtisham's case, in miniature: 60 ratings at the club he plays
    // for, all NEWER rows belonging to the club he left. A global
    // `take: 60` would hand the balancer sixty foreign 9s and not one
    // of his own scores.
    ratingRows = [];
    let t = 0;
    for (let i = 0; i < 60; i++) {
      ratingRows.push({
        playerId: P.id,
        orgId: ORG_B,
        score: 4,
        createdAt: new Date(1_700_000_000_000 + t++ * 1000),
      });
    }
    for (let i = 0; i < 60; i++) {
      ratingRows.push({
        playerId: P.id,
        orgId: ORG_A,
        score: 9,
        createdAt: new Date(1_700_000_000_000 + t++ * 1000),
      });
    }
    for (const o of B_OTHERS)
      for (let i = 0; i < 3; i++)
        ratingRows.push({
          playerId: o.id,
          orgId: ORG_B,
          score: o.peer,
          createdAt: new Date(1_700_000_000_000 + t++ * 1000),
        });

    const { ratings } = await runSheet(MATCH_B);
    // (4*60 + 6*3) / (60 + 3) = 258/63 = 4.0952. A global window would
    // have returned 9.0 here.
    expect(ratings.get(P.name)).toBeCloseTo(258 / 63, 10);
  });
});
