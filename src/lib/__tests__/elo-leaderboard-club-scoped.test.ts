/**
 * SLICE 5, THE READ HALF — the Elo leaderboard takes its VALUE from the
 * club, not from the player.
 *
 * `loadRecentHistory` already scoped the PLAYER SET correctly: only
 * people with a `TeamAssignment` on a completed match of this org get a
 * row (`match-history.ts`, the `teamAssignmentUserIds` query). What it
 * then did was read `User.matchRating`, a single global number, so a
 * result at one club ranked the player at another. That is section 3.1
 * G5 of `MDs/club-scoped-ratings-design-2026-09-18.md`.
 *
 * The value now comes from `Membership.matchRating` for the org being
 * asked about. The backfill in slice 1 copied `User.matchRating` onto
 * every membership, so on the day this ships the live leaderboard is
 * byte-identical; these tests pin the property that makes it diverge
 * correctly from the first score after that.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const matchFindMany = vi.fn();
const orgFindUnique = vi.fn();
const attendanceFindMany = vi.fn();
const userFindMany = vi.fn();
const membershipFindMany = vi.fn();
const teamAssignmentFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    match: { findMany: (...a: unknown[]) => matchFindMany(...a) },
    organisation: { findUnique: (...a: unknown[]) => orgFindUnique(...a) },
    attendance: { findMany: (...a: unknown[]) => attendanceFindMany(...a) },
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
    membership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    teamAssignment: { findMany: (...a: unknown[]) => teamAssignmentFindMany(...a) },
  },
}));
vi.mock("@/lib/mom", () => ({ getMomSummaries: async () => new Map() }));
vi.mock("@/lib/team-labels", () => ({ resolveTeamLabels: () => ["Reds", "Yellows"] }));

import { loadRecentHistory } from "@/lib/match-history";

const ORG = "org-sutton-fc";
const OTHER_ORG = "org-sutton-lads";

/** Six completed matches, so everyone clears the bottom-N threshold. */
const MATCH_IDS = ["m1", "m2", "m3", "m4", "m5", "m6"];

function seed(args: {
  players: Array<{ id: string; name: string }>;
  /** `Membership.matchRating` rows, keyed by org. */
  memberships: Array<{ userId: string; orgId: string; matchRating: number }>;
}) {
  matchFindMany.mockImplementation(async (a: Record<string, unknown>) =>
    MATCH_IDS.map((id) =>
      a.include
        ? {
            id,
            date: new Date(2026, 0, 6),
            redScore: 3,
            yellowScore: 2,
            activity: { sport: { teamLabels: null } },
          }
        : { id },
    ),
  );
  orgFindUnique.mockResolvedValue({ teamLabels: null, language: "en" });
  attendanceFindMany.mockResolvedValue(
    args.players.flatMap((p) => MATCH_IDS.map((matchId) => ({ userId: p.id, matchId }))),
  );
  teamAssignmentFindMany.mockResolvedValue(args.players.map((p) => ({ userId: p.id })));
  userFindMany.mockImplementation(async () =>
    args.players.map((p) => ({ id: p.id, name: p.name })),
  );
  membershipFindMany.mockImplementation(async (a: Record<string, unknown>) => {
    const where = (a.where ?? {}) as { orgId?: string; userId?: { in?: string[] } };
    return args.memberships
      .filter(
        (m) =>
          m.orgId === where.orgId && (where.userId?.in ?? []).includes(m.userId),
      )
      .map((m) => ({ userId: m.userId, matchRating: m.matchRating }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the Elo leaderboard", () => {
  it("ranks by THIS club's membership Elo, not by the player's other club's", async () => {
    seed({
      players: [
        { id: "u-ann", name: "Ann" },
        { id: "u-bob", name: "Bob" },
      ],
      memberships: [
        // At this club Bob is ahead. At the other club Ann is miles ahead.
        { userId: "u-ann", orgId: ORG, matchRating: 980 },
        { userId: "u-bob", orgId: ORG, matchRating: 1120 },
        { userId: "u-ann", orgId: OTHER_ORG, matchRating: 1900 },
        { userId: "u-bob", orgId: OTHER_ORG, matchRating: 800 },
      ],
    });

    const history = await loadRecentHistory(ORG);

    expect(history?.eloTop.map((r) => [r.name, r.value])).toEqual([
      ["Bob", 1120],
      ["Ann", 980],
    ]);
  });

  it("asks the membership query for THIS org", async () => {
    seed({
      players: [{ id: "u-ann", name: "Ann" }],
      memberships: [{ userId: "u-ann", orgId: ORG, matchRating: 1010 }],
    });

    await loadRecentHistory(ORG);

    const call = membershipFindMany.mock.calls[0][0] as {
      where: { orgId: string; userId: { in: string[] } };
    };
    expect(call.where.orgId).toBe(ORG);
    expect(call.where.userId.in).toEqual(["u-ann"]);
  });

  it("keeps a player with no membership at this club on the board, at the Elo default", async () => {
    seed({
      players: [
        { id: "u-ann", name: "Ann" },
        { id: "u-ghost", name: "Ghost" },
      ],
      // Ghost played but has no Membership row here. Dropping them
      // would silently shrink the board; inventing a membership is
      // forbidden. 1000 is Elo's "no information".
      memberships: [
        { userId: "u-ann", orgId: ORG, matchRating: 1010 },
        { userId: "u-ghost", orgId: OTHER_ORG, matchRating: 1500 },
      ],
    });

    const history = await loadRecentHistory(ORG);

    expect(history?.eloTop.map((r) => [r.name, r.value])).toEqual([
      ["Ann", 1010],
      ["Ghost", 1000],
    ]);
  });

  it("does not read matchRating off User any more", async () => {
    seed({
      players: [{ id: "u-ann", name: "Ann" }],
      memberships: [{ userId: "u-ann", orgId: ORG, matchRating: 1010 }],
    });

    await loadRecentHistory(ORG);

    for (const call of userFindMany.mock.calls) {
      const select = (call[0] as { select?: Record<string, unknown> }).select ?? {};
      expect(select).not.toHaveProperty("matchRating");
    }
  });

  it("still ranks the bottom board off the club's value", async () => {
    seed({
      players: [
        { id: "u-ann", name: "Ann" },
        { id: "u-bob", name: "Bob" },
        { id: "u-cal", name: "Cal" },
      ],
      memberships: [
        { userId: "u-ann", orgId: ORG, matchRating: 980 },
        { userId: "u-bob", orgId: ORG, matchRating: 1120 },
        { userId: "u-cal", orgId: ORG, matchRating: 900 },
        { userId: "u-cal", orgId: OTHER_ORG, matchRating: 2000 },
      ],
    });

    const history = await loadRecentHistory(ORG);

    expect(history?.eloBottom.map((r) => [r.name, r.value])).toEqual([
      ["Cal", 900],
      ["Ann", 980],
      ["Bob", 1120],
    ]);
  });
});
