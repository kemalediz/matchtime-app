/**
 * The planner behind `scripts/backfill-membership-ratings.ts`.
 *
 * Slice 1 of MDs/club-scoped-ratings-design-2026-09-18.md. The script
 * copies the two global columns `User.seedRating` and `User.matchRating`
 * onto every membership of that user, so that slice 2 can read a
 * per-club number. Nothing reads the new columns yet.
 *
 * The three things that can go wrong, and so the three things pinned
 * here:
 *
 *   1. SELECTION. It must copy onto an unset membership and must never
 *      overwrite a membership that already carries a value, because
 *      after slice 4 an admin's per-club seed is the newer opinion and
 *      the global column is the stale one.
 *   2. IDEMPOTENCY. Design section 9.2 requires that a second `--apply`
 *      is a no-op and that the verification re-run reports
 *      "will receive seedRating 0".
 *   3. FAN-OUT. One user with three memberships gets three rows written,
 *      including the memberships they have left, which keep history.
 *
 * All pure. The script does the I/O, this decides what the I/O is.
 */
import { describe, expect, it } from "vitest";
import {
  MEMBERSHIP_DEFAULT_MATCH_RATING,
  formatBackfillReport,
  planMembershipRatingBackfill,
  type BackfillRow,
} from "../membership-rating-backfill";

/** A membership row as the script reads it, with sane defaults. */
function row(over: Partial<BackfillRow> & { membershipId: string }): BackfillRow {
  return {
    userId: `u-${over.membershipId}`,
    userName: `User ${over.membershipId}`,
    orgId: "org-a",
    orgName: "Sutton Football Club",
    leftAt: null,
    userSeedRating: 6,
    userMatchRating: MEMBERSHIP_DEFAULT_MATCH_RATING,
    membershipSeedRating: null,
    membershipMatchRating: MEMBERSHIP_DEFAULT_MATCH_RATING,
    ...over,
  };
}

/** Apply a plan to its rows, the way the script's SQL would. */
function applyPlan(rows: BackfillRow[]): BackfillRow[] {
  const plan = planMembershipRatingBackfill(rows);
  const seeds = new Map(plan.seedWrites.map((w) => [w.membershipId, w.value]));
  const elos = new Map(plan.eloWrites.map((w) => [w.membershipId, w.value]));
  return rows.map((r) => ({
    ...r,
    membershipSeedRating: seeds.has(r.membershipId)
      ? (seeds.get(r.membershipId) as number)
      : r.membershipSeedRating,
    membershipMatchRating: elos.has(r.membershipId)
      ? (elos.get(r.membershipId) as number)
      : r.membershipMatchRating,
  }));
}

describe("planMembershipRatingBackfill: seed selection", () => {
  it("copies the user's seed onto a membership that has none", () => {
    const plan = planMembershipRatingBackfill([
      row({ membershipId: "m1", userSeedRating: 7.5, membershipSeedRating: null }),
    ]);
    expect(plan.seedWrites).toEqual([{ membershipId: "m1", value: 7.5 }]);
    expect(plan.willReceiveSeedRating).toBe(1);
    expect(plan.alreadyHaveSeedRating).toBe(0);
    expect(plan.sourceUserHasNoSeed).toBe(0);
  });

  it("never overwrites a membership that already carries a seed", () => {
    const plan = planMembershipRatingBackfill([
      row({ membershipId: "m1", userSeedRating: 7.5, membershipSeedRating: 4 }),
    ]);
    expect(plan.seedWrites).toEqual([]);
    expect(plan.alreadyHaveSeedRating).toBe(1);
    expect(plan.willReceiveSeedRating).toBe(0);
  });

  it("counts a membership whose user has no seed and writes nothing for it", () => {
    const plan = planMembershipRatingBackfill([
      row({ membershipId: "m1", userSeedRating: null, membershipSeedRating: null }),
    ]);
    expect(plan.seedWrites).toEqual([]);
    expect(plan.sourceUserHasNoSeed).toBe(1);
    expect(plan.willReceiveSeedRating).toBe(0);
  });

  it("treats a seed of 0 as a value, not as absent", () => {
    const plan = planMembershipRatingBackfill([
      row({ membershipId: "m1", userSeedRating: 0, membershipSeedRating: null }),
      row({ membershipId: "m2", userSeedRating: 7, membershipSeedRating: 0 }),
    ]);
    expect(plan.seedWrites).toEqual([{ membershipId: "m1", value: 0 }]);
    expect(plan.alreadyHaveSeedRating).toBe(1);
  });
});

describe("planMembershipRatingBackfill: Elo selection", () => {
  it("copies a moved Elo onto a membership still at the untouched default", () => {
    const plan = planMembershipRatingBackfill([
      row({ membershipId: "m1", userMatchRating: 1042 }),
    ]);
    expect(plan.eloWrites).toEqual([{ membershipId: "m1", value: 1042 }]);
    expect(plan.willReceiveMovedElo).toBe(1);
  });

  it("writes nothing when the user's Elo has never moved off the default", () => {
    const plan = planMembershipRatingBackfill([
      row({ membershipId: "m1", userMatchRating: MEMBERSHIP_DEFAULT_MATCH_RATING }),
    ]);
    expect(plan.eloWrites).toEqual([]);
    expect(plan.willReceiveMovedElo).toBe(0);
  });

  it("never overwrites a membership whose Elo has already moved", () => {
    const plan = planMembershipRatingBackfill([
      row({ membershipId: "m1", userMatchRating: 1042, membershipMatchRating: 980 }),
    ]);
    expect(plan.eloWrites).toEqual([]);
    expect(plan.willReceiveMovedElo).toBe(0);
  });

  it("reports every membership as already carrying a matchRating, because the column has a default", () => {
    const plan = planMembershipRatingBackfill([
      row({ membershipId: "m1" }),
      row({ membershipId: "m2", userMatchRating: 1042 }),
    ]);
    expect(plan.alreadyHaveMatchRating).toBe(2);
  });
});

describe("planMembershipRatingBackfill: fan-out across a user's memberships", () => {
  const multi: BackfillRow[] = [
    row({
      membershipId: "m1",
      userId: "u-shared",
      userName: "Amir",
      orgId: "org-a",
      orgName: "Sutton Football Club",
      userSeedRating: 7,
      userMatchRating: 1042,
    }),
    row({
      membershipId: "m2",
      userId: "u-shared",
      userName: "Amir",
      orgId: "org-b",
      orgName: "Sutton Lads",
      userSeedRating: 7,
      userMatchRating: 1042,
      leftAt: new Date("2026-06-18T00:00:00Z"),
    }),
    row({
      membershipId: "m3",
      userId: "u-shared",
      userName: "Amir",
      orgId: "org-c",
      orgName: "Friday Night Football",
      userSeedRating: 7,
      userMatchRating: 1042,
    }),
    row({ membershipId: "m4", userId: "u-solo", userName: "Solo", userSeedRating: 5 }),
  ];

  it("writes the same seed onto every membership of one user, left rows included", () => {
    const plan = planMembershipRatingBackfill(multi);
    expect(plan.seedWrites).toEqual([
      { membershipId: "m1", value: 7 },
      { membershipId: "m2", value: 7 },
      { membershipId: "m3", value: 7 },
      { membershipId: "m4", value: 5 },
    ]);
  });

  it("writes the same Elo onto every membership of one user", () => {
    const plan = planMembershipRatingBackfill(multi);
    expect(plan.eloWrites).toEqual([
      { membershipId: "m1", value: 1042 },
      { membershipId: "m2", value: 1042 },
      { membershipId: "m3", value: 1042 },
    ]);
  });

  it("counts the multi-club users, and how many of them carry a moved Elo", () => {
    const plan = planMembershipRatingBackfill(multi);
    expect(plan.usersWithMoreThanOneMembership).toBe(1);
    expect(plan.multiClubUsersWithMovedElo).toBe(1);
  });

  it("tallies per org", () => {
    const plan = planMembershipRatingBackfill(multi);
    expect(plan.perOrg).toEqual([
      {
        orgId: "org-c",
        orgName: "Friday Night Football",
        memberships: 1,
        seedWrites: 1,
        eloWrites: 1,
      },
      {
        orgId: "org-a",
        orgName: "Sutton Football Club",
        memberships: 2,
        seedWrites: 2,
        eloWrites: 1,
      },
      { orgId: "org-b", orgName: "Sutton Lads", memberships: 1, seedWrites: 1, eloWrites: 1 },
    ]);
  });
});

describe("planMembershipRatingBackfill: idempotency", () => {
  const rows: BackfillRow[] = [
    row({ membershipId: "m1", userSeedRating: 7, userMatchRating: 1042 }),
    row({ membershipId: "m2", userId: "u-shared", userSeedRating: 6.5, userMatchRating: 1042 }),
    row({ membershipId: "m3", userId: "u-shared", userSeedRating: 6.5, userMatchRating: 1042 }),
    row({ membershipId: "m4", userSeedRating: null }),
  ];

  it("plans no second write once the first has been applied", () => {
    const first = planMembershipRatingBackfill(rows);
    expect(first.seedWrites.length).toBe(3);
    expect(first.eloWrites.length).toBe(3);

    const second = planMembershipRatingBackfill(applyPlan(rows));
    expect(second.seedWrites).toEqual([]);
    expect(second.eloWrites).toEqual([]);
    expect(second.willReceiveSeedRating).toBe(0);
    expect(second.willReceiveMovedElo).toBe(0);
  });

  it("reports 'will receive seedRating 0' on the verification re-run", () => {
    const report = formatBackfillReport(planMembershipRatingBackfill(applyPlan(rows)));
    expect(report).toContain("will receive seedRating          0");
  });

  it("keeps the rows it never had a source for out of the second plan too", () => {
    const second = planMembershipRatingBackfill(applyPlan(rows));
    expect(second.sourceUserHasNoSeed).toBe(1);
  });
});

describe("formatBackfillReport", () => {
  const rows: BackfillRow[] = [
    row({ membershipId: "m1", userName: "Amir", userSeedRating: 7, userMatchRating: 1042 }),
    row({ membershipId: "m2", userName: "Faris", userSeedRating: 6 }),
  ];

  it("prints the dry-run header, the counts, the per-org block and the sample", () => {
    const report = formatBackfillReport(planMembershipRatingBackfill(rows));
    expect(report).toContain("MEMBERSHIP RATING BACKFILL (DRY RUN, no writes)");
    expect(report).toContain("memberships                        2");
    expect(report).toContain("will receive seedRating          2");
    expect(report).toContain("will receive a moved Elo         1");
    expect(report).toContain("PER-ORG");
    expect(report).toContain("Sutton Football Club");
    expect(report).toContain("SAMPLE");
    expect(report).toContain("NO ROWS WRITTEN. Re-run with --apply to write.");
  });

  it("samples at most 10 rows", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      row({ membershipId: `m${i}`, userSeedRating: 6 }),
    );
    expect(planMembershipRatingBackfill(many).sample.length).toBe(10);
  });

  it("shows the value each sampled membership will end up with", () => {
    const plan = planMembershipRatingBackfill(rows);
    expect(plan.sample[0]).toEqual({
      userName: "Amir",
      orgName: "Sutton Football Club",
      seed: 7,
      elo: 1042,
    });
    expect(plan.sample[1]).toEqual({
      userName: "Faris",
      orgName: "Sutton Football Club",
      seed: 6,
      elo: MEMBERSHIP_DEFAULT_MATCH_RATING,
    });
  });

  it("carries no dash punctuation, house style", () => {
    const report = formatBackfillReport(planMembershipRatingBackfill(rows));
    expect(report).not.toContain("—");
    expect(report).not.toContain("–");
  });
});
