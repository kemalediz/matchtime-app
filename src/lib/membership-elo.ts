/**
 * THE ELO'S CLUB-SCOPED HOME.
 *
 * `computeEloDeltas` in `elo.ts` is the arithmetic. This file is the
 * only place the numbers it works on are read from and written back to
 * the database, and the only signature in which they appear carries an
 * `orgId`. That is the whole point: until 2026-09-19 the Elo lived on
 * `User.matchRating`, a single global integer, and four separate call
 * sites each carried their own copy of "read it off the user, write it
 * back to the user". A player in two clubs had one Elo doing duty for
 * both, so a result at one club moved them up the other's leaderboard
 * (`MDs/club-scoped-ratings-design-2026-09-18.md` sections 3.1 G5 and
 * G9, slice 5 of section 11).
 *
 * `Membership.matchRating` is the per-club home. It shipped in slice 1
 * and was backfilled from `User.matchRating` for all 155 memberships,
 * so every club's leaderboard reads the same numbers on the day this
 * lands and only starts diverging from the next score.
 *
 * ── A PLAYER WITH NO MEMBERSHIP AT THE MATCH'S CLUB ──────────────────
 *
 * One rule, applied on both halves: NO MEMBERSHIP MEANS NO CLUB
 * OPINION, WHICH IS 1000, AND THERE IS NOWHERE TO PERSIST A CHANGE.
 *
 *   - Reading, they enter the maths at `MEMBERSHIP_ELO_DEFAULT`. Not
 *     excluded: the Elo judges each team against the OTHER team's
 *     average, so dropping a player from the inputs would silently
 *     change every other player's delta.
 *   - Writing, their row is simply not there, so `updateMany` matches
 *     nothing and the write is a no-op. It does not throw the way
 *     `update` would, and it does not invent a membership the way
 *     `upsert` would. Inventing one would make a guest a member of the
 *     club on the strength of a scoreline.
 *
 * Both halves report the affected ids so the caller can say so out
 * loud rather than the club quietly having a player who never moves.
 *
 * Note the deliberate absence of a `leftAt: null` filter. A player who
 * has left still has a membership row, that row is still where their
 * history at this club lives, and a completed match they played in is
 * still a result. Filtering them out would strand the row mid-history.
 */
import { db as defaultDb } from "./db";
import type { EloDelta, PlayerEloInput } from "./elo";

/** The Prisma surface this file touches. Typed as the real client by
 *  default; widened only so a unit test can hand in a stub. Same shape
 *  of escape hatch as `owner-deps.ts`. */
type Db = typeof defaultDb;

/**
 * `Membership.matchRating`'s schema default, and Elo's genuine "no
 * information" value. Unlike a seed rating, 1000 is not somebody's
 * opinion carried over from elsewhere, so unlike `Membership.seedRating`
 * this column keeps a default.
 */
export const MEMBERSHIP_ELO_DEFAULT = 1000;

export interface MembershipEloLoad {
  /** One entry per assignment, in the order given. */
  inputs: PlayerEloInput[];
  /** Players on the sheet with no `Membership` row for this club. They
   *  are in `inputs` at the default; they will not be written. */
  unmemberedUserIds: string[];
}

/**
 * Resolve the club a match belongs to, through the chain that cannot
 * change after creation: `Match.activityId` to `Activity.orgId`.
 *
 * Returns null rather than throwing for a match that has gone, because
 * every caller is on the derived half of a score write, where a failure
 * must not unmake the score that already landed.
 */
export async function orgIdForMatch(db: Db, matchId: string): Promise<string | null> {
  const row = await db.match.findUnique({
    where: { id: matchId },
    select: { activity: { select: { orgId: true } } },
  });
  return row?.activity.orgId ?? null;
}

/**
 * Each player's CURRENT Elo at this club, ready for `computeEloDeltas`.
 *
 * Read at apply time rather than carried from whatever the caller
 * loaded earlier: a rating that moved in between would make the delta
 * compound.
 */
export async function loadMembershipEloInputs(args: {
  db?: Db;
  orgId: string;
  assignments: ReadonlyArray<{ userId: string; team: "RED" | "YELLOW" }>;
}): Promise<MembershipEloLoad> {
  const db = args.db ?? defaultDb;
  if (args.assignments.length === 0) return { inputs: [], unmemberedUserIds: [] };

  const rows = await db.membership.findMany({
    where: { orgId: args.orgId, userId: { in: args.assignments.map((a) => a.userId) } },
    select: { userId: true, matchRating: true },
  });
  const byUser = new Map(rows.map((r) => [r.userId, r.matchRating]));

  const unmemberedUserIds: string[] = [];
  const inputs = args.assignments.map((a) => {
    const rating = byUser.get(a.userId);
    if (rating === undefined) unmemberedUserIds.push(a.userId);
    return {
      userId: a.userId,
      team: a.team,
      matchRating: rating ?? MEMBERSHIP_ELO_DEFAULT,
    };
  });

  return { inputs, unmemberedUserIds };
}

/**
 * Persist the computed deltas onto this club's memberships. One
 * transaction, as every one of the four call sites did before.
 *
 * `updateMany` rather than `update` is load-bearing and not a style
 * choice: `Membership` is unique on `[userId, orgId]` so it can match
 * at most one row, and when it matches none it reports `count: 0`
 * instead of throwing `P2025` at a player who is not a member. See the
 * header.
 */
export async function applyMembershipEloDeltas(args: {
  db?: Db;
  orgId: string;
  deltas: readonly EloDelta[];
}): Promise<{ written: number; unmemberedUserIds: string[] }> {
  const db = args.db ?? defaultDb;
  const { deltas, orgId } = args;
  // `computeEloDeltas` returns [] for a match whose teams were never
  // generated, and an empty `$transaction([])` is a pointless round trip.
  if (deltas.length === 0) return { written: 0, unmemberedUserIds: [] };

  const results = await db.$transaction(
    deltas.map((d) =>
      db.membership.updateMany({
        where: { userId: d.userId, orgId },
        data: { matchRating: d.after },
      }),
    ),
  );

  const unmemberedUserIds = deltas
    .filter((_, i) => (results[i]?.count ?? 0) === 0)
    .map((d) => d.userId);
  if (unmemberedUserIds.length > 0) {
    console.warn(
      `[membership-elo] ${unmemberedUserIds.length} player(s) on a scored match have no membership at org ${orgId}, so their Elo was not persisted:`,
      unmemberedUserIds.join(", "),
    );
  }

  return { written: deltas.length - unmemberedUserIds.length, unmemberedUserIds };
}
