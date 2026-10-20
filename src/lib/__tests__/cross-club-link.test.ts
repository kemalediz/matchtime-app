/**
 * Cross-club phone link: the database side (FNF incident 2026-10-18).
 *
 *   - the facts are read for the right ids, and only the other club's
 *     NAME is read from the existing account's memberships;
 *   - a link runs the shared `mergePlayersCore` (no second merge), with
 *     the alias and tombstone scoped to club A only, kept = the existing
 *     account, dropped = club A's row;
 *   - the tombstone is tagged with the actor and the reason (audit);
 *   - a refusal writes nothing at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mergePlayersCore = vi.fn();
vi.mock("@/lib/merge-players-core", () => ({
  mergePlayersCore: (...a: unknown[]) => mergePlayersCore(...a),
}));

import { linkAcrossClubsCore, loadCrossClubLinkFacts } from "../cross-club-link";

const A = "fnf";
const PHONE = "+447404111243";

type Count = ReturnType<typeof vi.fn>;
function makeTx(over: {
  keep?: { id: string; name: string | null; isSuperadmin: boolean } | null;
  keepMems?: Array<{ orgId: string; leftAt: Date | null; guestFromOrgId: string | null; org: { name: string } }>;
  dropUser?: {
    id: string;
    email: string | null;
    password: string | null;
    onboarded?: boolean;
    emailVerified?: Date | null;
    isSuperadmin?: boolean;
  } | null;
  dropMem?: { guestFromOrgId: string | null } | null;
  otherClubMemberships?: number;
  outside?: number;
  accounts?: number;
  sessions?: number;
} = {}) {
  const outside = over.outside ?? 0;
  const c = (n: number): Count => vi.fn().mockResolvedValue(n);
  const tx = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { phoneNumber?: string; id?: string } }) => {
        if (where.phoneNumber) return over.keep === undefined ? { id: "keep", name: "Habib Rahman", isSuperadmin: false } : over.keep;
        return over.dropUser === undefined
          ? { id: "drop", email: "manual-x@placeholder.matchtime", password: null, onboarded: false, emailVerified: null, isSuperadmin: false }
          : over.dropUser;
      }),
    },
    membership: {
      findMany: vi.fn().mockResolvedValue(
        over.keepMems ?? [{ orgId: "sutton", leftAt: null, guestFromOrgId: null, org: { name: "Sutton Football Club" } }],
      ),
      findUnique: vi.fn().mockResolvedValue(over.dropMem === undefined ? { guestFromOrgId: null } : over.dropMem),
      count: c(over.otherClubMemberships ?? 0),
    },
    attendance: { count: c(outside) },
    rating: { count: c(0) },
    moMVote: { count: c(0) },
    teamAssignment: { count: c(0) },
    ratingAdjustment: { count: c(0) },
    playerActivityPosition: { count: c(0) },
    analyzedMessage: { count: c(0) },
    userAlias: { count: c(0) },
    rosterSurveyDM: { count: c(0) },
    rosterSurveyResponse: { count: c(0) },
    squadMonthMember: { count: c(0) },
    squadCredit: { count: c(0) },
    account: { count: c(over.accounts ?? 0) },
    session: { count: c(over.sessions ?? 0) },
    userMerge: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  return tx;
}

beforeEach(() => {
  mergePlayersCore.mockReset().mockResolvedValue(undefined);
});

describe("loadCrossClubLinkFacts", () => {
  it("reads the existing account by the typed phone and only the other club's name", async () => {
    const tx = makeTx();
    const f = await loadCrossClubLinkFacts(tx, { orgId: A, dropUserId: "drop", phone: PHONE });
    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { phoneNumber: PHONE },
      select: { id: true, name: true, isSuperadmin: true },
    });
    expect(tx.membership.findMany).toHaveBeenCalledWith({
      where: { userId: "keep" },
      select: { orgId: true, leftAt: true, guestFromOrgId: true, org: { select: { name: true } } },
    });
    expect(f.keep).toEqual({
      id: "keep",
      name: "Habib Rahman",
      isSuperadmin: false,
      hasMembershipInOrg: false,
      clubNames: ["Sutton Football Club"],
    });
    expect(f.drop).toEqual({
      id: "drop",
      membershipInOrg: { guestFromOrgId: null },
      otherClubMemberships: 0,
      rowsOutsideOrg: 0,
      hasOwnSignIn: false,
    });
    // Club A's player's other-club memberships are counted against A.
    expect(tx.membership.count).toHaveBeenCalledWith({ where: { userId: "drop", orgId: { not: A } } });
    // Rows in another club's matches.
    expect(tx.attendance.count).toHaveBeenCalledWith({
      where: { userId: "drop", match: { activity: { orgId: { not: A } } } },
    });
  });

  it("lists active clubs before ones they have left", async () => {
    const tx = makeTx({
      keepMems: [
        { orgId: "old", leftAt: new Date(), guestFromOrgId: null, org: { name: "Old Club" } },
        { orgId: "sutton", leftAt: null, guestFromOrgId: null, org: { name: "Sutton Football Club" } },
      ],
    });
    const f = await loadCrossClubLinkFacts(tx, { orgId: A, dropUserId: "drop", phone: PHONE });
    expect(f.keep?.clubNames).toEqual(["Sutton Football Club", "Old Club"]);
  });

  it("sees a membership of club A on the existing account (same-club, not cross-club)", async () => {
    const tx = makeTx({
      keepMems: [{ orgId: A, leftAt: new Date(), guestFromOrgId: null, org: { name: "FNF" } }],
    });
    const f = await loadCrossClubLinkFacts(tx, { orgId: A, dropUserId: "drop", phone: PHONE });
    expect(f.keep?.hasMembershipInOrg).toBe(true);
  });

  it("counts a sign in of club A's player's own", async () => {
    for (const over of [{ accounts: 1 }, { sessions: 1 }, { dropUser: { id: "drop", email: "habib@gmail.com", password: null } }, { dropUser: { id: "drop", email: "manual-x@placeholder.matchtime", password: "hash" } }]) {
      const f = await loadCrossClubLinkFacts(makeTx(over), { orgId: A, dropUserId: "drop", phone: PHONE });
      expect(f.drop.hasOwnSignIn).toBe(true);
    }
  });

  // #314's definition of "has signed in" (player-account-guard.ts) is the
  // one the link uses too: a record somebody signed in on by phone
  // (onboarded), a verified email or a superadmin is never merged away.
  it.each([
    ["signed in by phone (onboarded)", { onboarded: true }],
    ["verified an email", { emailVerified: new Date() }],
    ["is a platform superadmin", { isSuperadmin: true }],
  ])("counts a record that %s as its own sign in", async (_l, extra) => {
    const dropUser = { id: "drop", email: "manual-x@placeholder.matchtime", password: null, onboarded: false, emailVerified: null, isSuperadmin: false, ...extra };
    const f = await loadCrossClubLinkFacts(makeTx({ dropUser }), { orgId: A, dropUserId: "drop", phone: PHONE });
    expect(f.drop.hasOwnSignIn).toBe(true);
  });
});

describe("linkAcrossClubsCore", () => {
  it("merges club A's row INTO the existing account, scoped to club A, and tags the audit row", async () => {
    const tx = makeTx();
    const r = await linkAcrossClubsCore(tx, { orgId: A, dropUserId: "drop", phone: PHONE, actorUserId: "admin-a" });
    expect(r).toEqual({ ok: true, keptUserId: "keep" });
    expect(mergePlayersCore).toHaveBeenCalledTimes(1);
    // keepIdentity: the existing account belongs to another club, so its
    // global name and image are never filled from club A's row (#314).
    expect(mergePlayersCore).toHaveBeenCalledWith(tx, "keep", "drop", { saveAliasInOrgIds: [A], keepIdentity: true, actorUserId: "admin-a" });
    expect(tx.userMerge.updateMany).toHaveBeenCalledWith({
      where: { oldUserId: "drop", survivorUserId: "keep", orgId: A },
      data: { actorUserId: "admin-a", reason: "cross-club-phone-link" },
    });
  });

  it("writes nothing when the rules refuse", async () => {
    const cases = [
      makeTx({ otherClubMemberships: 1 }),
      makeTx({ outside: 2 }),
      makeTx({ accounts: 1 }),
      makeTx({ dropUser: { id: "drop", email: "manual-x@placeholder.matchtime", password: null, onboarded: true } }),
      makeTx({ keep: { id: "keep", name: "K", isSuperadmin: true } }),
      makeTx({ dropMem: null }),
      makeTx({ dropMem: { guestFromOrgId: "x" } }),
      makeTx({ keep: null }),
    ];
    for (const tx of cases) {
      const r = await linkAcrossClubsCore(tx, { orgId: A, dropUserId: "drop", phone: PHONE, actorUserId: "admin-a" });
      expect(r.ok).toBe(false);
      expect(tx.userMerge.updateMany).not.toHaveBeenCalled();
    }
    expect(mergePlayersCore).not.toHaveBeenCalled();
  });

  it("does not link when the existing account is already in club A (that is the same-club merge)", async () => {
    const tx = makeTx({ keepMems: [{ orgId: A, leftAt: null, guestFromOrgId: null, org: { name: "FNF" } }] });
    const r = await linkAcrossClubsCore(tx, { orgId: A, dropUserId: "drop", phone: PHONE, actorUserId: "admin-a" });
    expect(r).toEqual({ ok: false, verdict: { kind: "not-cross-club" } });
    expect(mergePlayersCore).not.toHaveBeenCalled();
  });
});
