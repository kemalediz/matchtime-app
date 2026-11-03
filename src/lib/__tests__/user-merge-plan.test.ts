/**
 * The pure planner for folding one User into another (2026-11-03).
 *
 * Case that started it: "Uncle Najib" at FNF (no phone) is the same
 * person as "Najib" at Sutton Football Club. Every rule below is one
 * table and one collision, pinned on its own.
 */
import { describe, it, expect } from "vitest";
import {
  emptyMergeSnapshot,
  planUserMerge,
  rewriteIdSegments,
  rewriteJsonIds,
  type MergeSnapshot,
  type MergePlan,
  type MergeOp,
  type MembershipRow,
  type AttendanceRow,
  USER_MERGE_REASON,
} from "../user-merge-plan";

const S = "src_user_000000000000000001";
const T = "tgt_user_000000000000000002";
const X = "other_user_00000000000000003";
const FNF = "org_fnf";
const SUTTON = "org_sutton";
const NOW = new Date("2026-11-03T12:00:00Z");

function snap(over: Partial<MergeSnapshot> = {}): MergeSnapshot {
  const base = emptyMergeSnapshot(
    { id: S, name: "Uncle Najib", email: `provisional+uncle-najib-x@placeholder.matchtime`, phoneNumber: null },
    { id: T, name: "Najib", email: `t@placeholder.matchtime`, phoneNumber: "+447944434018" },
  );
  return { ...base, ...over, source: { ...base.source, ...over.source }, target: { ...base.target, ...over.target } };
}

function mem(over: Partial<MembershipRow> & { id: string; userId: string; orgId: string }): MembershipRow {
  return {
    role: "PLAYER",
    leftAt: null,
    removedByOrganiserAt: null,
    provisionallyAddedAt: null,
    lastSeenInGroupAt: null,
    seedRating: null,
    matchRating: 1000,
    guestFromOrgId: null,
    guestMatchId: null,
    guestVia: null,
    ...over,
  };
}

function att(over: Partial<AttendanceRow> & { id: string; userId: string; matchId: string }): AttendanceRow {
  return {
    orgId: FNF,
    status: "CONFIRMED",
    position: 1,
    paidAt: null,
    paidViaUserId: null,
    paymentMethod: null,
    paymentAmount: null,
    paymentQuantity: 1,
    stripeSessionId: null,
    directPendingAt: null,
    directConfirmedByUserId: null,
    feeWaivedAt: null,
    feeWaivedReason: null,
    feeWaivedByUserId: null,
    ...over,
  };
}

const plan = (s: MergeSnapshot): MergePlan => planUserMerge(s, { now: NOW });
const opsFor = (p: MergePlan, table: string) => p.ops.filter((o) => "table" in o && o.table === table);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const find = (p: MergePlan, table: string, id: string, kind?: MergeOp["kind"]): any =>
  p.ops.find((o) => "table" in o && o.table === table && "id" in o && o.id === id && (!kind || o.kind === kind));

describe("blockers: when the merge must not run", () => {
  it("refuses the same user twice", () => {
    const s = snap();
    s.target = { ...s.target, id: S };
    expect(plan(s).blockers).toContain("source and target are the same user");
  });
  it("refuses a superadmin source", () => {
    expect(plan(snap({ source: { isSuperadmin: true } as never })).blockers.join()).toMatch(/superadmin/);
  });
  it("refuses a source with its own sign in (a real email, an OAuth account, a password, a session, onboarded)", () => {
    for (const over of [
      { email: "najib@gmail.com" },
      { accountCount: 1 },
      { hasPassword: true },
      { sessionCount: 1 },
      { onboarded: true },
    ]) {
      expect(plan(snap({ source: over as never })).blockers.join(), JSON.stringify(over)).toMatch(/sign in/);
    }
  });
  it("refuses two different phone numbers (which one is his is a human decision)", () => {
    expect(plan(snap({ source: { phoneNumber: "+447700900111" } as never })).blockers.join()).toMatch(/phone/);
  });
  it("refuses an inactive target", () => {
    expect(plan(snap({ target: { isActive: false } as never })).blockers.join()).toMatch(/target is inactive/);
  });
  it("refuses a source already merged into somebody else", () => {
    const s = snap({ source: { isActive: false } as never, priorMerges: [{ survivorUserId: X, reason: USER_MERGE_REASON }] });
    expect(plan(s).blockers.join()).toMatch(/already merged into/);
  });
  it("refuses an inactive source with no merge record (deactivated for another reason)", () => {
    expect(plan(snap({ source: { isActive: false } as never })).blockers.join()).toMatch(/inactive/);
  });
  it("a blocked plan carries no ops", () => {
    const s = snap({ source: { isSuperadmin: true } as never, memberships: [mem({ id: "m1", userId: S, orgId: FNF })] });
    expect(plan(s).ops).toEqual([]);
  });
});

describe("the two User rows", () => {
  it("deactivates the source and keeps the target's name and phone", () => {
    const p = plan(snap());
    expect(p.blockers).toEqual([]);
    expect(find(p, "user", S)).toMatchObject({ kind: "update", set: { isActive: false } });
    expect(find(p, "user", T)).toBeUndefined();
  });
  it("moves the source's phone only when the target has none, freeing it on the source first", () => {
    const s = snap({ source: { phoneNumber: "+447700900111" } as never, target: { phoneNumber: null } as never });
    const p = plan(s);
    const srcIdx = p.ops.findIndex((o) => o.kind === "update" && o.table === "user" && o.id === S);
    const tgtIdx = p.ops.findIndex((o) => o.kind === "update" && o.table === "user" && o.id === T);
    expect(p.ops[srcIdx]).toMatchObject({ set: { isActive: false, phoneNumber: null } });
    expect(p.ops[tgtIdx]).toMatchObject({ set: { phoneNumber: "+447700900111" } });
    expect(srcIdx).toBeLessThan(tgtIdx);
  });
  it("the same number on both is not a conflict", () => {
    const s = snap({ source: { phoneNumber: "+447944434018" } as never });
    // Impossible in a real DB (phone is unique), but the rule is "different numbers block".
    expect(plan(s).blockers).toEqual([]);
  });
  it("writes one tombstone per club the source was a member of", () => {
    const s = snap({ memberships: [mem({ id: "m1", userId: S, orgId: FNF }), mem({ id: "m2", userId: S, orgId: "org_vets" })] });
    expect(plan(s).tombstoneOrgIds.sort()).toEqual([FNF, "org_vets"].sort());
  });
});

describe("Membership: club-scoped data stays at its club", () => {
  it("a club only the source is in: the row moves whole (seed and Elo untouched), his club name becomes an alias there", () => {
    const s = snap({
      memberships: [
        mem({ id: "mS", userId: S, orgId: FNF, seedRating: 6, matchRating: 1042 }),
        mem({ id: "mT", userId: T, orgId: SUTTON, seedRating: 8, matchRating: 1100 }),
      ],
    });
    const p = plan(s);
    expect(find(p, "membership", "mS")).toEqual(expect.objectContaining({ kind: "update", set: { userId: T } }));
    // Sutton's row is not touched at all: FNF numbers never reach Sutton's.
    expect(find(p, "membership", "mT")).toBeUndefined();
    expect(p.ops).toContainEqual(
      expect.objectContaining({ kind: "create", table: "userAlias", data: { orgId: FNF, userId: T, alias: "uncle najib", source: "merge" } }),
    );
  });

  it("both in the same club: target's seed wins when it has one; else the source's", () => {
    const both = (tSeed: number | null, sSeed: number | null) =>
      plan(
        snap({
          memberships: [
            mem({ id: "mS", userId: S, orgId: FNF, seedRating: sSeed }),
            mem({ id: "mT", userId: T, orgId: FNF, seedRating: tSeed }),
          ],
        }),
      );
    expect((find(both(7, 5), "membership", "mT") as { set: { seedRating: number } }).set.seedRating).toBe(7);
    expect((find(both(null, 5), "membership", "mT") as { set: { seedRating: number } }).set.seedRating).toBe(5);
    expect(find(both(7, 5), "membership", "mS")).toMatchObject({ kind: "delete" });
  });

  it("both in the same club: target's Elo wins unless it is the untouched 1000", () => {
    const both = (tElo: number, sElo: number) =>
      (find(
        plan(snap({ memberships: [mem({ id: "mS", userId: S, orgId: FNF, matchRating: sElo }), mem({ id: "mT", userId: T, orgId: FNF, matchRating: tElo })] })),
        "membership",
        "mT",
      ) as { set: { matchRating: number } }).set.matchRating;
    expect(both(1050, 980)).toBe(1050);
    expect(both(1000, 980)).toBe(980);
  });

  it("both in the same club: the higher role wins and the raise is logged", () => {
    const p = plan(
      snap({ memberships: [mem({ id: "mS", userId: S, orgId: FNF, role: "ADMIN" }), mem({ id: "mT", userId: T, orgId: FNF, role: "PLAYER" })] }),
    );
    expect((find(p, "membership", "mT") as { set: { role: string } }).set.role).toBe("ADMIN");
    expect(p.ops).toContainEqual(
      expect.objectContaining({ kind: "create", table: "roleChange", data: expect.objectContaining({ orgId: FNF, userId: T, fromRole: "PLAYER", toRole: "ADMIN", source: "merge" }) }),
    );
  });

  it("both in the same club: still a member if either row is live; a regular row beats a guest row", () => {
    const left = new Date("2026-10-01");
    const p = plan(
      snap({
        memberships: [
          mem({ id: "mS", userId: S, orgId: FNF, leftAt: null }),
          mem({ id: "mT", userId: T, orgId: FNF, leftAt: left, guestFromOrgId: SUTTON, guestMatchId: "match1", guestVia: "partner" }),
        ],
      }),
    );
    expect((find(p, "membership", "mT") as { set: Record<string, unknown> }).set).toMatchObject({
      leftAt: null,
      guestFromOrgId: null,
      guestMatchId: null,
      guestVia: null,
    });
  });

  it("alias: skipped when another person already holds it at that club (reported), or when it is the target's own name", () => {
    const taken = plan(
      snap({
        memberships: [mem({ id: "mS", userId: S, orgId: FNF })],
        aliasesInSourceOrgs: [{ id: "a1", orgId: FNF, userId: X, alias: "uncle najib" }],
      }),
    );
    expect(opsFor(taken, "userAlias").filter((o) => o.kind === "create")).toEqual([]);
    expect(taken.conflicts.map((c) => c.table)).toContain("userAlias");

    const sameName = plan(snap({ source: { name: "Najib" } as never, memberships: [mem({ id: "mS", userId: S, orgId: FNF })] }));
    expect(opsFor(sameName, "userAlias").filter((o) => o.kind === "create")).toEqual([]);
  });
});

describe("Attendance: moves with its events, never rewriting the append-only log", () => {
  it("no collision: the row moves and two events record it (source loses, target gains)", () => {
    const p = plan(snap({ attendance: [att({ id: "a1", userId: S, matchId: "m1", status: "BENCH", position: 3 })] }));
    expect(find(p, "attendance", "a1")).toMatchObject({ kind: "update", set: { userId: T } });
    const ev = p.ops.filter((o) => o.kind === "event");
    expect(ev).toEqual([
      expect.objectContaining({ transition: expect.objectContaining({ matchId: "m1", userId: S, orgId: FNF, fromStatus: "BENCH", toStatus: null }) }),
      expect.objectContaining({ transition: expect.objectContaining({ matchId: "m1", userId: T, fromStatus: null, toStatus: "BENCH", toPosition: 3 }) }),
    ]);
    expect(p.ops.some((o) => "table" in o && o.table === "attendanceEvent")).toBe(false);
  });

  it("collision, source ranks higher (CONFIRMED beats BENCH): the target's row takes the status; source row deleted", () => {
    const p = plan(
      snap({
        attendance: [
          att({ id: "aS", userId: S, matchId: "m1", status: "CONFIRMED", position: 2 }),
          att({ id: "aT", userId: T, matchId: "m1", status: "BENCH", position: 9 }),
        ],
      }),
    );
    expect(find(p, "attendance", "aT")).toMatchObject({ kind: "update", set: { status: "CONFIRMED", position: 2 } });
    expect(find(p, "attendance", "aS")).toMatchObject({ kind: "delete" });
    const ev = p.ops.filter((o) => o.kind === "event").map((o) => (o as { transition: { userId: string; fromStatus: string | null; toStatus: string | null } }).transition);
    expect(ev).toContainEqual(expect.objectContaining({ userId: T, fromStatus: "BENCH", toStatus: "CONFIRMED" }));
    expect(ev).toContainEqual(expect.objectContaining({ userId: S, fromStatus: "CONFIRMED", toStatus: null }));
  });

  it("collision, target ranks equal or higher: target's place kept, but a payment on the source row is never lost", () => {
    const paid = new Date("2026-10-30T19:00:00Z");
    const p = plan(
      snap({
        attendance: [
          att({ id: "aS", userId: S, matchId: "m1", status: "DROPPED", paidAt: paid, paymentMethod: "direct", paidViaUserId: S }),
          att({ id: "aT", userId: T, matchId: "m1", status: "CONFIRMED" }),
        ],
      }),
    );
    const upd = find(p, "attendance", "aT") as { set: Record<string, unknown> };
    expect(upd.set).toMatchObject({ paidAt: paid, paymentMethod: "direct", paidViaUserId: T });
    expect(upd.set.status).toBeUndefined();
    expect(find(p, "attendance", "aS")).toMatchObject({ kind: "delete" });
  });

  it("someone else's row paid for by the source now says paid by the target", () => {
    const p = plan(snap({ refs: [{ table: "attendance", column: "paidViaUserId", kind: "scalar", id: "aX", value: S }] }));
    expect(find(p, "attendance", "aX")).toMatchObject({ kind: "update", set: { paidViaUserId: T } });
  });
});

describe("Rating and MoMVote", () => {
  it("given: moves; a rating the target already gave the same player in that match wins", () => {
    const p = plan(
      snap({
        ratings: [
          { id: "r1", matchId: "m1", raterId: S, playerId: X },
          { id: "r2", matchId: "m2", raterId: S, playerId: X },
          { id: "r3", matchId: "m2", raterId: T, playerId: X },
        ],
      }),
    );
    expect(find(p, "rating", "r1")).toMatchObject({ kind: "update", set: { raterId: T } });
    expect(find(p, "rating", "r2")).toMatchObject({ kind: "delete" });
    expect(find(p, "rating", "r3")).toBeUndefined();
  });
  it("received: moves; the same rater rating both records in one match keeps the target's", () => {
    const p = plan(
      snap({
        ratings: [
          { id: "r1", matchId: "m1", raterId: X, playerId: S },
          { id: "r2", matchId: "m1", raterId: X, playerId: T },
        ],
      }),
    );
    expect(find(p, "rating", "r1")).toMatchObject({ kind: "delete" });
  });
  it("a rating between the two records would become a self-rating: deleted", () => {
    const p = plan(snap({ ratings: [{ id: "r1", matchId: "m1", raterId: S, playerId: T }, { id: "r2", matchId: "m1", raterId: T, playerId: S }] }));
    expect(find(p, "rating", "r1")).toMatchObject({ kind: "delete" });
    expect(find(p, "rating", "r2")).toMatchObject({ kind: "delete" });
  });
  it("MoM: one vote per voter per match (target's wins), votes received move, a vote for oneself is deleted", () => {
    const p = plan(
      snap({
        momVotes: [
          { id: "v1", matchId: "m1", voterId: S, playerId: X },
          { id: "v2", matchId: "m1", voterId: T, playerId: X },
          { id: "v3", matchId: "m2", voterId: X, playerId: S },
          { id: "v4", matchId: "m3", voterId: S, playerId: T },
        ],
      }),
    );
    expect(find(p, "moMVote", "v1")).toMatchObject({ kind: "delete" });
    expect(find(p, "moMVote", "v3")).toMatchObject({ kind: "update", set: { playerId: T } });
    expect(find(p, "moMVote", "v4")).toMatchObject({ kind: "delete" });
  });
});

describe("one-row-per-(thing, user) tables: target's row wins a collision, otherwise the row moves", () => {
  const cases: Array<{ table: keyof MergeSnapshot; delegate: string; row: (id: string, userId: string, k: string) => Record<string, unknown> }> = [
    { table: "teamAssignments", delegate: "teamAssignment", row: (id, userId, k) => ({ id, userId, matchId: k }) },
    { table: "activityPositions", delegate: "playerActivityPosition", row: (id, userId, k) => ({ id, userId, activityId: k }) },
    { table: "ratingAdjustments", delegate: "ratingAdjustment", row: (id, userId, k) => ({ id, userId, matchId: k }) },
    { table: "rosterSurveyDMs", delegate: "rosterSurveyDM", row: (id, userId, k) => ({ id, userId, surveyId: k }) },
    { table: "tentatives", delegate: "tentativeAvailability", row: (id, userId, k) => ({ id, userId, matchId: k }) },
    { table: "pendingBench", delegate: "pendingBenchConfirmation", row: (id, userId, k) => ({ id, userId, matchId: k }) },
    { table: "badges", delegate: "badgeAnnouncement", row: (id, userId, k) => ({ id, userId, orgId: FNF, badgeKey: k }) },
    { table: "poolOffers", delegate: "poolOffer", row: (id, userId, k) => ({ id, userId, matchId: k }) },
    { table: "poolBlocks", delegate: "poolBlock", row: (id, userId, k) => ({ id, userId, orgId: FNF, by: k }) },
    { table: "guestPlaces", delegate: "guestPlace", row: (id, userId, k) => ({ id, userId, matchId: k }) },
  ];
  for (const c of cases) {
    it(c.delegate, () => {
      const p = plan(snap({ [c.table]: [c.row("s1", S, "k1"), c.row("s2", S, "k2"), c.row("t2", T, "k2")] } as Partial<MergeSnapshot>));
      expect(find(p, c.delegate, "s1")).toMatchObject({ kind: "update", set: { userId: T } });
      expect(find(p, c.delegate, "s2")).toMatchObject({ kind: "delete" });
      expect(find(p, c.delegate, "t2")).toBeUndefined();
      expect(p.conflicts.some((x) => x.table === c.delegate && x.rowId === "s2")).toBe(true);
    });
  }

  it("RosterSurveyResponse: the newer reply wins", () => {
    const older = new Date("2026-10-01"), newer = new Date("2026-10-02");
    const p = plan(
      snap({
        rosterSurveyResponses: [
          { id: "s1", surveyId: "q1", userId: S, response: "in", rawReply: "in", classifiedAt: newer, adminOverride: false },
          { id: "t1", surveyId: "q1", userId: T, response: "out", rawReply: "no", classifiedAt: older, adminOverride: false },
        ],
      }),
    );
    expect(find(p, "rosterSurveyResponse", "t1")).toMatchObject({ kind: "update", set: { response: "in", rawReply: "in" } });
    expect(find(p, "rosterSurveyResponse", "s1")).toMatchObject({ kind: "delete" });
  });

  it("SquadMonthMember: the row with more payment evidence wins (confirmed > claimed > none)", () => {
    const p = plan(
      snap({
        squadMembers: [
          { id: "s1", monthId: "mo1", userId: S, paidAt: new Date(), paidClaimedAt: null },
          { id: "t1", monthId: "mo1", userId: T, paidAt: null, paidClaimedAt: null },
          { id: "s2", monthId: "mo2", userId: S, paidAt: null, paidClaimedAt: null },
          { id: "t2", monthId: "mo2", userId: T, paidAt: null, paidClaimedAt: null },
        ],
      }),
    );
    expect(find(p, "squadMonthMember", "t1")).toMatchObject({ kind: "delete" });
    expect(find(p, "squadMonthMember", "s1")).toMatchObject({ kind: "update", set: { userId: T } });
    expect(find(p, "squadMonthMember", "s2")).toMatchObject({ kind: "delete" });
    expect(find(p, "squadMonthMember", "t2")).toBeUndefined();
  });

  it("SquadCredit: moves; a second LIVE credit for the same game is voided, not deleted (the ledger keeps it)", () => {
    const p = plan(
      snap({
        squadCredits: [
          { id: "s1", orgId: FNF, userId: S, earnedMatchId: "g1", voidedAt: null },
          { id: "t1", orgId: FNF, userId: T, earnedMatchId: "g1", voidedAt: null },
          { id: "s2", orgId: FNF, userId: S, earnedMatchId: "g2", voidedAt: null },
        ],
      }),
    );
    expect(find(p, "squadCredit", "s1")).toMatchObject({ kind: "update", set: { userId: T, voidedAt: NOW } });
    expect(find(p, "squadCredit", "s2")).toMatchObject({ kind: "update", set: { userId: T } });
    expect((find(p, "squadCredit", "s2") as { set: Record<string, unknown> }).set.voidedAt).toBeUndefined();
  });

  it("PoolProfile: moves when the target has none; when both have one, the source's is stopped and stays on the source", () => {
    const moved = plan(snap({ poolProfiles: [{ id: "p1", userId: S, status: "active" }] }));
    expect(find(moved, "poolProfile", "p1")).toMatchObject({ kind: "update", set: { userId: T } });
    const both = plan(snap({ poolProfiles: [{ id: "p1", userId: S, status: "active" }, { id: "p2", userId: T, status: "active" }] }));
    expect(find(both, "poolProfile", "p1")).toMatchObject({ kind: "update", set: { status: "stopped", stoppedAt: NOW } });
    expect((find(both, "poolProfile", "p1") as { set: Record<string, unknown> }).set.userId).toBeUndefined();
    const again = plan(snap({ poolProfiles: [{ id: "p1", userId: S, status: "stopped" }, { id: "p2", userId: T, status: "active" }] }));
    expect(find(again, "poolProfile", "p1")).toBeUndefined();
  });

  it("ClubInvitation: moves; two OPEN invitations at one club: the source's is withdrawn", () => {
    const p = plan(
      snap({
        clubInvitations: [
          { id: "s1", orgId: FNF, userId: S, status: "open" },
          { id: "t1", orgId: FNF, userId: T, status: "open" },
          { id: "s2", orgId: SUTTON, userId: S, status: "declined" },
        ],
      }),
    );
    expect(find(p, "clubInvitation", "s1")).toMatchObject({ kind: "update", set: { userId: T, status: "withdrawn", closedAt: NOW } });
    expect(find(p, "clubInvitation", "s2")).toMatchObject({ kind: "update", set: { userId: T } });
  });
});

describe("SentNotification: the dedupe key carries the user id", () => {
  it("rewrites '<matchId>:rate-dm:<source>' to the target; when the target already has that key, the source's row goes", () => {
    const p = plan(
      snap({
        sentNotifications: [
          { id: "n1", key: `m1:rate-dm:${S}`, targetUser: S },
          { id: "n2", key: `m2:rate-dm:${S}`, targetUser: S },
        ],
        occupiedNotificationKeys: [`m2:rate-dm:${T}`],
      }),
    );
    expect(find(p, "sentNotification", "n1")).toMatchObject({ kind: "update", set: { key: `m1:rate-dm:${T}`, targetUser: T } });
    expect(find(p, "sentNotification", "n2")).toMatchObject({ kind: "delete" });
  });
});

describe("generic references (who-did-it columns, id lists, JSON)", () => {
  it("rewrites whole ':'-separated segments only", () => {
    expect(rewriteIdSegments(S, S, T)).toBe(T);
    expect(rewriteIdSegments(`owner:${S}`, S, T)).toBe(`owner:${T}`);
    expect(rewriteIdSegments(`m1:pay-chase:${S}:2026-11-01`, S, T)).toBe(`m1:pay-chase:${T}:2026-11-01`);
    expect(rewriteIdSegments(`x${S}`, S, T)).toBe(`x${S}`);
  });
  it("rewrites JSON values and keys, deeply", () => {
    expect(rewriteJsonIds({ deltas: [{ userId: S, delta: 3 }], byUser: { [S]: 1 } }, S, T)).toEqual({ deltas: [{ userId: T, delta: 3 }], byUser: { [T]: 1 } });
  });
  it("id arrays: replaced and de-duplicated", () => {
    const p = plan(snap({ refs: [{ table: "organiserPickRound", column: "listUserIds", kind: "array", id: "r1", value: [X, S, T] }] }));
    expect(find(p, "organiserPickRound", "r1")).toMatchObject({ set: { listUserIds: [X, T] } });
  });
  it("a ref on a row that is being deleted is dropped, and refs on one row are folded into one update", () => {
    const p = plan(
      snap({
        teamAssignments: [{ id: "s1", userId: S, matchId: "k" }, { id: "t1", userId: T, matchId: "k" }],
        refs: [
          { table: "teamAssignment", column: "userId", kind: "scalar", id: "s1", value: S },
          { table: "adminFeeProposal", column: "proposedByUserId", kind: "scalar", id: "f1", value: S },
          { table: "adminFeeProposal", column: "userIds", kind: "array", id: "f1", value: [S] },
        ],
      }),
    );
    expect(opsFor(p, "teamAssignment").filter((o) => o.kind === "update")).toEqual([]);
    expect(opsFor(p, "adminFeeProposal")).toEqual([
      expect.objectContaining({ kind: "update", id: "f1", set: { proposedByUserId: T, userIds: [T] } }),
    ]);
  });
});

describe("ordering and idempotency", () => {
  it("deletes come before updates, user rows before other updates, creates and events last", () => {
    const p = plan(
      snap({
        squadMembers: [
          { id: "s1", monthId: "mo1", userId: S, paidAt: new Date(), paidClaimedAt: null },
          { id: "t1", monthId: "mo1", userId: T, paidAt: null, paidClaimedAt: null },
        ],
        memberships: [mem({ id: "mS", userId: S, orgId: FNF })],
        attendance: [att({ id: "a1", userId: S, matchId: "m1" })],
      }),
    );
    const rank = (o: MergeOp) => (o.kind === "delete" ? 0 : o.kind === "update" && o.table === "user" ? 1 : o.kind === "update" ? 2 : 3);
    const ranks = p.ops.map(rank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it("a second run over the merged state is a no-op", () => {
    const after = snap({
      source: { isActive: false } as never,
      priorMerges: [{ survivorUserId: T, reason: USER_MERGE_REASON }],
      aliasesInSourceOrgs: [],
      memberships: [],
    });
    const p = plan(after);
    expect(p.blockers).toEqual([]);
    expect(p.noop).toBe(true);
    expect(p.ops).toEqual([]);
    expect(p.tombstoneOrgIds).toEqual([]);
  });

  it("an already-merged source with rows that appeared since: they move, no second tombstone, no re-deactivation", () => {
    const p = plan(
      snap({
        source: { isActive: false } as never,
        priorMerges: [{ survivorUserId: T, reason: USER_MERGE_REASON }],
        teamAssignments: [{ id: "s1", userId: S, matchId: "k" }],
      }),
    );
    expect(p.noop).toBe(false);
    expect(find(p, "user", S)).toBeUndefined();
    expect(p.tombstoneOrgIds).toEqual([]);
  });
});
