/**
 * The planner behind `scripts/backfill-membership-ratings.ts`.
 *
 * Slice 1 of MDs/club-scoped-ratings-design-2026-09-18.md. `User.seedRating`
 * and `User.matchRating` are global columns that have been doing duty for
 * every club a player belongs to. They move to `Membership`, and this
 * decides which memberships receive which value.
 *
 * It is a copy, not a reconciliation. The global value is the only
 * evidence that exists, so it fans out unchanged onto every membership of
 * that user, left memberships included (they keep history). Splitting it
 * per club would be inventing data.
 *
 * Two rules do all the work, and both exist so that a re-run is a no-op:
 *
 *   SEED: write only where the membership's own seed is unset. A
 *     membership that already carries one holds the newer opinion (after
 *     slice 4 that is what an admin edited), and the global column is the
 *     stale one.
 *   ELO: write only where the membership is still at the untouched
 *     default of 1000 AND the user's own Elo has moved off it. A user who
 *     never moved needs no write, because the default already says the
 *     same thing.
 *
 * Pure on purpose. The script owns the I/O; this owns the decision, so
 * the decision is testable without a database.
 * See src/lib/__tests__/membership-rating-backfill.test.ts.
 */

/** `Membership.matchRating`'s schema default. 1000 is Elo's "no information". */
export const MEMBERSHIP_DEFAULT_MATCH_RATING = 1000;

/** One membership joined to its user and org, as the script reads it. */
export interface BackfillRow {
  membershipId: string;
  userId: string;
  userName: string | null;
  orgId: string;
  orgName: string;
  /** Non-null for a membership the player has left. Still backfilled. */
  leftAt: Date | null;
  /** `User.seedRating`, the global column being copied FROM. */
  userSeedRating: number | null;
  /** `User.matchRating`, the global Elo being copied FROM. */
  userMatchRating: number;
  /** `Membership.seedRating` today. Null means the club has no opinion yet. */
  membershipSeedRating: number | null;
  /** `Membership.matchRating` today. 1000 is the untouched default. */
  membershipMatchRating: number;
}

export interface RatingWrite {
  membershipId: string;
  value: number;
}

export interface OrgTally {
  orgId: string;
  orgName: string;
  memberships: number;
  seedWrites: number;
  eloWrites: number;
}

export interface SampleRow {
  userName: string | null;
  orgName: string;
  /** The seed this membership ends up with. Null when it stays unset. */
  seed: number | null;
  /** The Elo this membership ends up with. */
  elo: number;
}

export interface BackfillPlan {
  totalMemberships: number;
  alreadyHaveSeedRating: number;
  willReceiveSeedRating: number;
  sourceUserHasNoSeed: number;
  /** Every row, because the column has a default and so is never null. */
  alreadyHaveMatchRating: number;
  willReceiveMovedElo: number;
  usersWithMoreThanOneMembership: number;
  multiClubUsersWithMovedElo: number;
  seedWrites: RatingWrite[];
  eloWrites: RatingWrite[];
  perOrg: OrgTally[];
  sample: SampleRow[];
}

const SAMPLE_SIZE = 10;

/**
 * Up to SAMPLE_SIZE rows spread evenly across the ones being written,
 * not the first ten. Rows arrive ordered by org, so the first ten would
 * all come from whichever club sorts first and a reader would spot-check
 * one club instead of the estimate.
 */
function spread(rows: SampleRow[]): SampleRow[] {
  if (rows.length <= SAMPLE_SIZE) return rows;
  const out: SampleRow[] = [];
  for (let i = 0; i < SAMPLE_SIZE; i++) {
    out.push(rows[Math.round((i * (rows.length - 1)) / (SAMPLE_SIZE - 1))]);
  }
  return out;
}

export function planMembershipRatingBackfill(rows: BackfillRow[]): BackfillPlan {
  const seedWrites: RatingWrite[] = [];
  const eloWrites: RatingWrite[] = [];
  const touched: SampleRow[] = [];
  const perOrg = new Map<string, OrgTally>();
  const membershipsByUser = new Map<string, BackfillRow[]>();

  let alreadyHaveSeedRating = 0;
  let sourceUserHasNoSeed = 0;

  for (const r of rows) {
    const byUser = membershipsByUser.get(r.userId);
    if (byUser) byUser.push(r);
    else membershipsByUser.set(r.userId, [r]);

    let tally = perOrg.get(r.orgId);
    if (!tally) {
      tally = { orgId: r.orgId, orgName: r.orgName, memberships: 0, seedWrites: 0, eloWrites: 0 };
      perOrg.set(r.orgId, tally);
    }
    tally.memberships += 1;

    let seed: number | null = r.membershipSeedRating;
    if (r.membershipSeedRating !== null) {
      alreadyHaveSeedRating += 1;
    } else if (r.userSeedRating === null) {
      sourceUserHasNoSeed += 1;
    } else {
      seedWrites.push({ membershipId: r.membershipId, value: r.userSeedRating });
      tally.seedWrites += 1;
      seed = r.userSeedRating;
    }

    let elo = r.membershipMatchRating;
    if (
      r.membershipMatchRating === MEMBERSHIP_DEFAULT_MATCH_RATING &&
      r.userMatchRating !== MEMBERSHIP_DEFAULT_MATCH_RATING
    ) {
      eloWrites.push({ membershipId: r.membershipId, value: r.userMatchRating });
      tally.eloWrites += 1;
      elo = r.userMatchRating;
    }

    if (seed !== r.membershipSeedRating || elo !== r.membershipMatchRating) {
      touched.push({ userName: r.userName, orgName: r.orgName, seed, elo });
    }
  }

  let usersWithMoreThanOneMembership = 0;
  let multiClubUsersWithMovedElo = 0;
  for (const ms of membershipsByUser.values()) {
    if (ms.length < 2) continue;
    usersWithMoreThanOneMembership += 1;
    if (ms[0].userMatchRating !== MEMBERSHIP_DEFAULT_MATCH_RATING) multiClubUsersWithMovedElo += 1;
  }

  return {
    totalMemberships: rows.length,
    alreadyHaveSeedRating,
    willReceiveSeedRating: seedWrites.length,
    sourceUserHasNoSeed,
    alreadyHaveMatchRating: rows.length,
    willReceiveMovedElo: eloWrites.length,
    usersWithMoreThanOneMembership,
    multiClubUsersWithMovedElo,
    seedWrites,
    eloWrites,
    perOrg: [...perOrg.values()].sort((a, b) => a.orgName.localeCompare(b.orgName)),
    sample: spread(touched),
  };
}

/** Label column width, so the counts line up in a single right-hand column. */
const LABEL_WIDTH = 33;

function line(label: string, n: number, note = ""): string {
  const body = label.padEnd(LABEL_WIDTH) + String(n).padStart(3);
  return note ? `${body}   ${note}` : body;
}

/** The dry-run report, shape fixed by design section 9.2. */
export function formatBackfillReport(plan: BackfillPlan): string {
  const out: string[] = [];
  out.push("MEMBERSHIP RATING BACKFILL (DRY RUN, no writes)");
  out.push("");
  out.push(
    line(
      "memberships",
      plan.totalMemberships,
      "(active and left both; left rows keep history)",
    ),
  );
  out.push(line("  already have seedRating", plan.alreadyHaveSeedRating));
  out.push(line("  will receive seedRating", plan.willReceiveSeedRating));
  out.push(line("  source user has no seed", plan.sourceUserHasNoSeed));
  out.push(line("  already have matchRating", plan.alreadyHaveMatchRating, "(column default 1000)"));
  out.push(line("  will receive a moved Elo", plan.willReceiveMovedElo));
  out.push("");
  out.push(line("users with more than one membership:", plan.usersWithMoreThanOneMembership));
  out.push(
    `${line("  of those, with a moved Elo:", plan.multiClubUsersWithMovedElo)}   ` +
      "<- these get the same Elo in both clubs",
  );
  out.push("");
  out.push("PER-ORG");
  for (const o of plan.perOrg) {
    out.push(
      `  ${o.orgName.padEnd(23)}${String(o.memberships).padStart(3)} memberships, ` +
        `${String(o.seedWrites).padStart(3)} seeds, ${String(o.eloWrites).padStart(3)} Elos`,
    );
  }
  out.push("");
  out.push(`SAMPLE (${plan.sample.length} rows)`);
  out.push(`  ${"user".padEnd(21)}${"org".padEnd(23)}${"seed".padStart(4)}  elo`);
  for (const s of plan.sample) {
    const seed = s.seed === null ? "none" : String(s.seed);
    out.push(`  ${(s.userName ?? "?").padEnd(21)}${s.orgName.padEnd(23)}${seed.padStart(4)}  ${s.elo}`);
  }
  out.push("");
  out.push("NO ROWS WRITTEN. Re-run with --apply to write.");
  return out.join("\n");
}
