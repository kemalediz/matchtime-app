/**
 * SLICE 5 — THE ELO IS A CLUB'S OPINION, NOT A GLOBAL ONE.
 *
 * `User.matchRating` was one Elo doing duty for every club a player is
 * in. A Sutton Lads result moved a player up the Sutton FC leaderboard,
 * which is
 * `MDs/club-scoped-ratings-design-2026-09-18.md` section 3.1 G5 and G9.
 * `Membership.matchRating` (shipped and backfilled in slice 1) is the
 * per-club home, and this file pins the four properties that make the
 * move real:
 *
 *   1. a scored match moves the Elo on the MATCH'S club's membership,
 *   2. and leaves the same player's OTHER club's membership untouched,
 *   3. a player on the team sheet with no membership at that club does
 *      not crash the apply and does not get a membership invented for
 *      them, and
 *   4. `User.matchRating` is not written by any Elo path any more.
 *
 * The path driven here is the live one: `applyScoreWrites` over
 * `buildScoreApplyDeps`, which is what the WhatsApp bot runs when
 * somebody posts a score in the group. The database is a hand-built
 * fake rather than a mock so the assertions are on the STATE that came
 * out, not on which query was issued.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildScoreApplyDeps } from "../owner-deps";
import { applyScoreWrites } from "../score-engine";
import { MEMBERSHIP_ELO_DEFAULT } from "../membership-elo";

const ORG_A = "org-sutton-fc";
const ORG_B = "org-sutton-lads";
const MATCH_A = "match-in-org-a";

type MembershipRow = { userId: string; orgId: string; matchRating: number };
type AssignmentRow = { matchId: string; userId: string; team: "RED" | "YELLOW" };

/**
 * A fake Prisma with exactly the surface the Elo path touches. `user`
 * is present and every write on it throws, because property 4 above is
 * only worth anything if breaking it is loud.
 */
function fakeWorld(args: {
  memberships: MembershipRow[];
  assignments: AssignmentRow[];
  orgByMatch?: Record<string, string>;
}) {
  const memberships = args.memberships.map((m) => ({ ...m }));
  const assignments = args.assignments.map((a) => ({ ...a }));
  const orgByMatch = args.orgByMatch ?? { [MATCH_A]: ORG_A };
  const userUpdates: unknown[] = [];
  const matchUpdates: unknown[] = [];

  const db = {
    match: {
      update: async (a: unknown) => {
        matchUpdates.push(a);
        return {};
      },
      findUnique: async (a: { where: { id: string } }) => {
        const orgId = orgByMatch[a.where.id];
        return orgId ? { activity: { orgId } } : null;
      },
    },
    teamAssignment: {
      findMany: async (a: { where: { matchId: string } }) =>
        assignments
          .filter((x) => x.matchId === a.where.matchId)
          .map((x) => ({ userId: x.userId, team: x.team })),
    },
    membership: {
      findMany: async (a: { where: { orgId: string; userId: { in: string[] } } }) =>
        memberships
          .filter((m) => m.orgId === a.where.orgId && a.where.userId.in.includes(m.userId))
          .map((m) => ({ userId: m.userId, matchRating: m.matchRating })),
      updateMany: async (a: {
        where: { userId: string; orgId: string };
        data: { matchRating: number };
      }) => {
        const hits = memberships.filter(
          (m) => m.userId === a.where.userId && m.orgId === a.where.orgId,
        );
        for (const m of hits) m.matchRating = a.data.matchRating;
        return { count: hits.length };
      },
    },
    user: {
      update: () => {
        throw new Error("User.matchRating must not be written by the Elo path any more");
      },
      updateMany: () => {
        throw new Error("User.matchRating must not be written by the Elo path any more");
      },
    },
    // Real Prisma defers these; executing eagerly is close enough for a
    // test whose assertions are on the resulting rows.
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };

  const ratingOf = (userId: string, orgId: string) =>
    memberships.find((m) => m.userId === userId && m.orgId === orgId)?.matchRating;

  return { db, memberships, ratingOf, userUpdates, matchUpdates };
}

/** RED beat YELLOW 5-0 in `MATCH_A`, through the live apply layer. */
async function runScore(world: ReturnType<typeof fakeWorld>) {
  return applyScoreWrites({
    writes: [
      {
        kind: "score",
        matchId: MATCH_A,
        red: 5,
        yellow: 0,
        sourceMessageId: "wa-we-won-5-0",
        reason: "the group reported the final score",
      },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps: buildScoreApplyDeps({ db: world.db as any }),
  });
}

describe("a scored match moves the Elo on the match's club only", () => {
  it("writes the winner's new Elo to the membership for the MATCH's org", async () => {
    const world = fakeWorld({
      memberships: [
        { userId: "u-shared", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-shared", orgId: ORG_B, matchRating: 1000 },
        { userId: "u-a1", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-a2", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-a3", orgId: ORG_A, matchRating: 1000 },
      ],
      assignments: [
        { matchId: MATCH_A, userId: "u-shared", team: "RED" },
        { matchId: MATCH_A, userId: "u-a1", team: "RED" },
        { matchId: MATCH_A, userId: "u-a2", team: "YELLOW" },
        { matchId: MATCH_A, userId: "u-a3", team: "YELLOW" },
      ],
    });

    const [result] = await runScore(world);

    expect(result.ok).toBe(true);
    expect(result.eloError).toBeUndefined();
    expect(result.eloApplied).toBe(4);
    // Even teams, RED won 5-0: K = 32 * (1 + 5/5) = 64, expected 0.5,
    // so +32 to each winner and -32 to each loser.
    expect(world.ratingOf("u-shared", ORG_A)).toBe(1032);
    expect(world.ratingOf("u-a1", ORG_A)).toBe(1032);
    expect(world.ratingOf("u-a2", ORG_A)).toBe(968);
    expect(world.ratingOf("u-a3", ORG_A)).toBe(968);
  });

  it("leaves the same player's OTHER club's Elo exactly where it was", async () => {
    const world = fakeWorld({
      memberships: [
        { userId: "u-shared", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-shared", orgId: ORG_B, matchRating: 1234 },
        { userId: "u-a1", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-a2", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-a3", orgId: ORG_A, matchRating: 1000 },
      ],
      assignments: [
        { matchId: MATCH_A, userId: "u-shared", team: "RED" },
        { matchId: MATCH_A, userId: "u-a1", team: "RED" },
        { matchId: MATCH_A, userId: "u-a2", team: "YELLOW" },
        { matchId: MATCH_A, userId: "u-a3", team: "YELLOW" },
      ],
    });

    await runScore(world);

    expect(world.ratingOf("u-shared", ORG_A)).toBe(1032);
    expect(world.ratingOf("u-shared", ORG_B)).toBe(1234);
  });

  it("reads the STARTING Elo from the match's club, not from the other one", async () => {
    // The shared player is strong at club B and average at club A. If
    // the load leaked club B's 1600 into club A's team average, RED
    // would be the heavy favourite and its win would earn far less
    // than the +32 an even match pays.
    const world = fakeWorld({
      memberships: [
        { userId: "u-shared", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-shared", orgId: ORG_B, matchRating: 1600 },
        { userId: "u-a1", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-a2", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-a3", orgId: ORG_A, matchRating: 1000 },
      ],
      assignments: [
        { matchId: MATCH_A, userId: "u-shared", team: "RED" },
        { matchId: MATCH_A, userId: "u-a1", team: "RED" },
        { matchId: MATCH_A, userId: "u-a2", team: "YELLOW" },
        { matchId: MATCH_A, userId: "u-a3", team: "YELLOW" },
      ],
    });

    await runScore(world);

    expect(world.ratingOf("u-shared", ORG_A)).toBe(1032);
    expect(world.ratingOf("u-shared", ORG_B)).toBe(1600);
  });
});

describe("a player on the team sheet with no membership at that club", () => {
  it("does not crash the apply and does not get a membership invented", async () => {
    const world = fakeWorld({
      memberships: [
        { userId: "u-a1", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-a2", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-a3", orgId: ORG_A, matchRating: 1000 },
        // `u-guest` plays but belongs to the OTHER club only.
        { userId: "u-guest", orgId: ORG_B, matchRating: 1400 },
      ],
      assignments: [
        { matchId: MATCH_A, userId: "u-guest", team: "RED" },
        { matchId: MATCH_A, userId: "u-a1", team: "RED" },
        { matchId: MATCH_A, userId: "u-a2", team: "YELLOW" },
        { matchId: MATCH_A, userId: "u-a3", team: "YELLOW" },
      ],
    });

    const [result] = await runScore(world);

    expect(result.ok).toBe(true);
    expect(result.eloError).toBeUndefined();
    // No row created for (u-guest, ORG_A).
    expect(world.memberships).toHaveLength(4);
    expect(world.ratingOf("u-guest", ORG_A)).toBeUndefined();
    // Their other club is untouched too.
    expect(world.ratingOf("u-guest", ORG_B)).toBe(1400);
  });

  it("still counts them in the team average at the default, so nobody else's delta moves", async () => {
    const withGuest = fakeWorld({
      memberships: [
        { userId: "u-a1", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-a2", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-a3", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-guest", orgId: ORG_B, matchRating: 1400 },
      ],
      assignments: [
        { matchId: MATCH_A, userId: "u-guest", team: "RED" },
        { matchId: MATCH_A, userId: "u-a1", team: "RED" },
        { matchId: MATCH_A, userId: "u-a2", team: "YELLOW" },
        { matchId: MATCH_A, userId: "u-a3", team: "YELLOW" },
      ],
    });
    const withMember = fakeWorld({
      memberships: [
        { userId: "u-a1", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-a2", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-a3", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-guest", orgId: ORG_A, matchRating: MEMBERSHIP_ELO_DEFAULT },
      ],
      assignments: [
        { matchId: MATCH_A, userId: "u-guest", team: "RED" },
        { matchId: MATCH_A, userId: "u-a1", team: "RED" },
        { matchId: MATCH_A, userId: "u-a2", team: "YELLOW" },
        { matchId: MATCH_A, userId: "u-a3", team: "YELLOW" },
      ],
    });

    await runScore(withGuest);
    await runScore(withMember);

    for (const u of ["u-a1", "u-a2", "u-a3"]) {
      expect(withGuest.ratingOf(u, ORG_A)).toBe(withMember.ratingOf(u, ORG_A));
    }
  });
});

describe("User.matchRating is not written any more", () => {
  it("applies a whole score without touching db.user at all", async () => {
    // The fake's `user.update` throws. A green result IS the assertion.
    const world = fakeWorld({
      memberships: [
        { userId: "u-a1", orgId: ORG_A, matchRating: 1000 },
        { userId: "u-a2", orgId: ORG_A, matchRating: 1000 },
      ],
      assignments: [
        { matchId: MATCH_A, userId: "u-a1", team: "RED" },
        { matchId: MATCH_A, userId: "u-a2", team: "YELLOW" },
      ],
    });

    const [result] = await runScore(world);

    expect(result.ok).toBe(true);
    expect(result.eloError).toBeUndefined();
    expect(world.ratingOf("u-a1", ORG_A)).toBe(1032);
  });

  /**
   * Grep-shaped on purpose. The four Elo write sites and the one read
   * site are the whole of `matchRating`'s application surface, and the
   * failure mode this guards is a future edit re-adding
   * `db.user.update({ data: { matchRating } })` on a path no unit test
   * drives (the cron, an admin action). A behavioural test cannot see
   * a site nobody calls; a file scan can.
   */
  it("leaves no db.user write in any of the Elo write or read sites", () => {
    const root = join(__dirname, "..", "..", "..");
    const sites = [
      "src/lib/match-completion.ts",
      "src/app/api/whatsapp/score/route.ts",
      "src/app/actions/matches.ts",
      "src/lib/owner-deps.ts",
      "src/lib/match-history.ts",
    ];
    const offenders = sites.filter((rel) =>
      /\b(db|tx)\s*\.\s*user\s*\.\s*(update|updateMany|upsert)\s*\(/.test(
        readFileSync(join(root, rel), "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
