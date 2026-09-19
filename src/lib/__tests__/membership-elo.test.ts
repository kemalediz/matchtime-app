/**
 * `membership-elo.ts` — the one place the per-club Elo is read and
 * written, unit-tested directly.
 *
 * Four call sites share it (`match-completion.ts`,
 * `api/whatsapp/score/route.ts`, `actions/matches.ts` and
 * `owner-deps.ts`'s `ScoreApplyDeps`). Before slice 5 each of those
 * carried its own copy of "read `user.matchRating`, write
 * `user.matchRating`", which is four chances to forget the org. Here
 * the org is a required argument, so forgetting it does not compile.
 */
import { describe, it, expect, vi } from "vitest";
import {
  MEMBERSHIP_ELO_DEFAULT,
  loadMembershipEloInputs,
  applyMembershipEloDeltas,
  orgIdForMatch,
} from "../membership-elo";

function fakeDb(args: {
  memberships?: Array<{ userId: string; orgId: string; matchRating: number }>;
  orgByMatch?: Record<string, string>;
} = {}) {
  const memberships = (args.memberships ?? []).map((m) => ({ ...m }));
  const updateMany = vi.fn(
    async (a: { where: { userId: string; orgId: string }; data: { matchRating: number } }) => {
      const hits = memberships.filter(
        (m) => m.userId === a.where.userId && m.orgId === a.where.orgId,
      );
      for (const m of hits) m.matchRating = a.data.matchRating;
      return { count: hits.length };
    },
  );
  const transaction = vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops));
  const db = {
    membership: {
      findMany: async (a: { where: { orgId: string; userId: { in: string[] } } }) =>
        memberships
          .filter((m) => m.orgId === a.where.orgId && a.where.userId.in.includes(m.userId))
          .map((m) => ({ userId: m.userId, matchRating: m.matchRating })),
      updateMany,
    },
    match: {
      findUnique: async (a: { where: { id: string } }) => {
        const orgId = (args.orgByMatch ?? {})[a.where.id];
        return orgId ? { activity: { orgId } } : null;
      },
    },
    $transaction: transaction,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, memberships, updateMany, transaction };
}

describe("MEMBERSHIP_ELO_DEFAULT", () => {
  it("is Elo's 'no information' value and matches the column default", () => {
    expect(MEMBERSHIP_ELO_DEFAULT).toBe(1000);
  });
});

describe("loadMembershipEloInputs", () => {
  it("takes each player's rating from the given org's membership", async () => {
    const { db } = fakeDb({
      memberships: [
        { userId: "u1", orgId: "org-a", matchRating: 1200 },
        { userId: "u1", orgId: "org-b", matchRating: 800 },
        { userId: "u2", orgId: "org-a", matchRating: 1300 },
      ],
    });

    const out = await loadMembershipEloInputs({
      db,
      orgId: "org-a",
      assignments: [
        { userId: "u1", team: "RED" },
        { userId: "u2", team: "YELLOW" },
      ],
    });

    expect(out.inputs).toEqual([
      { userId: "u1", team: "RED", matchRating: 1200 },
      { userId: "u2", team: "YELLOW", matchRating: 1300 },
    ]);
    expect(out.unmemberedUserIds).toEqual([]);
  });

  it("falls back to the default for a player with no membership, and names them", async () => {
    const { db } = fakeDb({
      memberships: [{ userId: "u1", orgId: "org-a", matchRating: 1200 }],
    });

    const out = await loadMembershipEloInputs({
      db,
      orgId: "org-a",
      assignments: [
        { userId: "u1", team: "RED" },
        { userId: "u-guest", team: "YELLOW" },
      ],
    });

    expect(out.inputs).toEqual([
      { userId: "u1", team: "RED", matchRating: 1200 },
      { userId: "u-guest", team: "YELLOW", matchRating: MEMBERSHIP_ELO_DEFAULT },
    ]);
    expect(out.unmemberedUserIds).toEqual(["u-guest"]);
  });

  it("issues no query at all for an empty team sheet", async () => {
    const { db } = fakeDb();
    const findMany = vi.fn();
    db.membership.findMany = findMany;

    const out = await loadMembershipEloInputs({ db, orgId: "org-a", assignments: [] });

    expect(out.inputs).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("applyMembershipEloDeltas", () => {
  it("writes every delta to the org's membership in ONE transaction", async () => {
    const f = fakeDb({
      memberships: [
        { userId: "u1", orgId: "org-a", matchRating: 1200 },
        { userId: "u2", orgId: "org-a", matchRating: 1300 },
      ],
    });

    const out = await applyMembershipEloDeltas({
      db: f.db,
      orgId: "org-a",
      deltas: [
        { userId: "u1", before: 1200, after: 1210, delta: 10 },
        { userId: "u2", before: 1300, after: 1290, delta: -10 },
      ],
    });

    expect(f.transaction).toHaveBeenCalledOnce();
    expect(out.written).toBe(2);
    expect(out.unmemberedUserIds).toEqual([]);
    expect(f.memberships).toEqual([
      { userId: "u1", orgId: "org-a", matchRating: 1210 },
      { userId: "u2", orgId: "org-a", matchRating: 1290 },
    ]);
    expect(f.updateMany.mock.calls[0][0]).toEqual({
      where: { userId: "u1", orgId: "org-a" },
      data: { matchRating: 1210 },
    });
  });

  it("never touches another org's row for the same player", async () => {
    const f = fakeDb({
      memberships: [
        { userId: "u1", orgId: "org-a", matchRating: 1200 },
        { userId: "u1", orgId: "org-b", matchRating: 1200 },
      ],
    });

    await applyMembershipEloDeltas({
      db: f.db,
      orgId: "org-a",
      deltas: [{ userId: "u1", before: 1200, after: 1210, delta: 10 }],
    });

    expect(f.memberships).toEqual([
      { userId: "u1", orgId: "org-a", matchRating: 1210 },
      { userId: "u1", orgId: "org-b", matchRating: 1200 },
    ]);
  });

  it("reports a missing membership rather than creating one", async () => {
    const f = fakeDb({ memberships: [{ userId: "u1", orgId: "org-a", matchRating: 1200 }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await applyMembershipEloDeltas({
      db: f.db,
      orgId: "org-a",
      deltas: [
        { userId: "u1", before: 1200, after: 1210, delta: 10 },
        { userId: "u-guest", before: 1000, after: 990, delta: -10 },
      ],
    });

    expect(out.written).toBe(1);
    expect(out.unmemberedUserIds).toEqual(["u-guest"]);
    expect(f.memberships).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("writes nothing at all when there are no deltas", async () => {
    const f = fakeDb();
    const out = await applyMembershipEloDeltas({ db: f.db, orgId: "org-a", deltas: [] });
    expect(f.transaction).not.toHaveBeenCalled();
    expect(out.written).toBe(0);
  });
});

describe("orgIdForMatch", () => {
  it("walks match to activity to org", async () => {
    const { db } = fakeDb({ orgByMatch: { m1: "org-a" } });
    expect(await orgIdForMatch(db, "m1")).toBe("org-a");
  });

  it("returns null for a match that is gone, rather than throwing", async () => {
    const { db } = fakeDb({ orgByMatch: {} });
    expect(await orgIdForMatch(db, "nope")).toBeNull();
  });
});
