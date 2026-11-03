/**
 * Adversarial review of PR #508 (2026-11-03). Each test pins one gap the
 * review found in the planner; each failed on the branch as reviewed and
 * passes with the fixes. The reclaim test is adapted: the planner now
 * reads the source's event history, and the target inherits it.
 */
import { describe, it, expect } from "vitest";
import { emptyMergeSnapshot, planUserMerge, type MergeSnapshot, type MergePlan, type AttendanceRow, type MembershipRow } from "../user-merge-plan";

const S = "src_user_000000000000000001";
const T = "tgt_user_000000000000000002";
const FNF = "org_fnf";
const NOW = new Date("2026-11-03T12:00:00Z");

function snap(over: Partial<MergeSnapshot> = {}): MergeSnapshot {
  const base = emptyMergeSnapshot(
    { id: S, name: "Uncle Najib", email: `provisional+uncle-najib-x@placeholder.matchtime`, phoneNumber: null },
    { id: T, name: "Najib", email: `t@placeholder.matchtime`, phoneNumber: "+447944434018" },
  );
  return { ...base, ...over, source: { ...base.source, ...over.source }, target: { ...base.target, ...over.target } };
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

const plan = (s: MergeSnapshot): MergePlan => planUserMerge(s, { now: NOW });
const deletes = (p: MergePlan, table: string, id: string) => p.ops.some((o) => o.kind === "delete" && o.table === table && o.id === id);

describe("review: money is never silently dropped on a collision", () => {
  it("both rows paid for the same match: the source's payment record must not be deleted without a stop", () => {
    const p = plan(
      snap({
        attendance: [
          att({ id: "aS", userId: S, matchId: "m1", paidAt: new Date("2026-10-30T20:00:00Z"), paymentMethod: "card", paymentAmount: 500, stripeSessionId: "cs_S" }),
          att({ id: "aT", userId: T, matchId: "m1", paidAt: new Date("2026-10-30T21:00:00Z"), paymentMethod: "card", paymentAmount: 500, stripeSessionId: "cs_T" }),
        ],
      }),
    );
    // On the branch: no blocker, aS (with cs_S and its £5) is deleted.
    expect(p.blockers.length > 0 || !deletes(p, "attendance", "aS")).toBe(true);
  });

  it("target only PENDING a direct payment, source actually PAID: the confirmed payment must survive", () => {
    const paid = new Date("2026-10-30T20:00:00Z");
    const p = plan(
      snap({
        attendance: [
          att({ id: "aS", userId: S, matchId: "m1", paidAt: paid, paymentMethod: "direct" }),
          att({ id: "aT", userId: T, matchId: "m1", directPendingAt: new Date("2026-10-30T19:00:00Z"), paymentMethod: "direct" }),
        ],
      }),
    );
    const upd = p.ops.find((o) => o.kind === "update" && o.table === "attendance" && o.id === "aT") as { set: Record<string, unknown> } | undefined;
    // On the branch: hasPay(aT) is true (directPendingAt), so aS's paidAt is dropped with aS.
    expect(p.blockers.length > 0 || upd?.set.paidAt === paid).toBe(true);
  });

  it("source has an OPEN Stripe checkout (session id, not yet paid): refuse, the webhook finds the row by metadata.userId", () => {
    const p = plan(snap({ attendance: [att({ id: "aS", userId: S, matchId: "m1", stripeSessionId: "cs_open" })] }));
    // payment-flow.ts updates WHERE matchId AND userId = metadata.userId (the source).
    // After the move that row says userId = T, so the payment lands nowhere.
    expect(p.blockers.length).toBeGreaterThan(0);
  });

  it("both on one month's list and both PAID: the source's month payment must not be deleted without a stop", () => {
    const p = plan(
      snap({
        squadMembers: [
          { id: "s1", monthId: "mo1", userId: S, paidAt: new Date("2026-10-01"), paidClaimedAt: null },
          { id: "t1", monthId: "mo1", userId: T, paidAt: new Date("2026-10-02"), paidClaimedAt: null },
        ],
      }),
    );
    expect(p.blockers.length > 0 || !deletes(p, "squadMonthMember", "s1")).toBe(true);
  });
});

describe("review: JSON rewrites must not merge two people's entries silently", () => {
  it("Match.eloApplied naming both: the rewrite yields two deltas for the target (undo would take both back from one rating)", () => {
    const value = { target: { red: 3, yellow: 2 }, applied: { red: 3, yellow: 2, deltas: [{ userId: S, delta: 12 }, { userId: T, delta: 12 }] } };
    const p = plan(snap({ refs: [{ table: "match", column: "eloApplied", kind: "json", id: "m1", value }] }));
    const upd = p.ops.find((o) => o.kind === "update" && o.table === "match" && o.id === "m1") as { set: { eloApplied: typeof value } } | undefined;
    const tDeltas = upd?.set.eloApplied.applied.deltas.filter((d) => d.userId === T).length ?? 0;
    expect(p.blockers.length > 0 || tDeltas <= 1).toBe(true);
  });

  it("an object keyed by both ids: the source's key overwrites the target's value", () => {
    const value = { [T]: { team: "RED" }, [S]: { team: "YELLOW" } };
    const p = plan(snap({ refs: [{ table: "groupPostState", column: "heldAdd", kind: "json", id: "g1", value }] }));
    const upd = p.ops.find((o) => o.kind === "update" && o.table === "groupPostState") as { set: { heldAdd: Record<string, { team: string }> } } | undefined;
    // On the branch: { [T]: { team: "YELLOW" } }: the target's own entry is gone, no conflict reported.
    expect(p.blockers.length > 0 || p.conflicts.some((c) => c.table === "groupPostState") || upd?.set.heldAdd[T]?.team === "RED").toBe(true);
  });

  it("same club, both have Elo: the target's rating is kept but the source's match deltas are re-pointed onto it", () => {
    const value = { target: { red: 3, yellow: 2 }, applied: { red: 3, yellow: 2, deltas: [{ userId: S, delta: 15 }] } };
    const p = plan(
      snap({
        memberships: [mem({ id: "ms", userId: S, orgId: FNF, matchRating: 1015 }), mem({ id: "mt", userId: T, orgId: FNF, matchRating: 1040 })],
        refs: [{ table: "match", column: "eloApplied", kind: "json", id: "m1", value }],
      }),
    );
    // On the branch: matchRating stays 1040 (never had the +15) while m1's deltas now
    // say T got +15, so a score correction on m1 takes 15 off a number that never had it.
    expect(p.blockers.length > 0 || p.conflicts.some((c) => c.table === "match")).toBe(true);
  });
});

describe("review: the compensating events feed readers that derive state from the log", () => {
  it("a moved DROPPED place keeps its reclaim right (organiser-pick: last move CONFIRMED -> DROPPED)", () => {
    // FNF prod, match cmvu7hx1c (6 Nov, TEAMS_PUBLISHED): source Habib's last event is
    // CONFIRMED -> DROPPED. squad-reclaim.ts reads the newest toStatus=DROPPED event's
    // fromStatus for the CURRENT userId. The target must inherit that event.
    const at = new Date("2026-11-01T10:00:00Z");
    const p = plan(
      snap({
        attendance: [att({ id: "aS", userId: S, matchId: "m1", status: "DROPPED", position: 4 })],
        sourceEvents: [
          { id: "e1", matchId: "m1", userId: S, orgId: FNF, fromStatus: null, toStatus: "CONFIRMED", fromPosition: null, toPosition: 4, cause: "registration", actorKind: "player", actorUserId: S, sourceRef: "wa:1", note: null, at: new Date("2026-10-30T10:00:00Z") },
          { id: "e2", matchId: "m1", userId: S, orgId: FNF, fromStatus: "CONFIRMED", toStatus: "DROPPED", fromPosition: 4, toPosition: 4, cause: "self-out", actorKind: "player", actorUserId: S, sourceRef: "wa:2", note: null, at },
        ],
      }),
    );
    const tEvents = p.ops.filter((o) => (o.kind === "copyEvent" && o.data.userId === T) || (o.kind === "event" && o.transition.userId === T));
    // Newest DROPPED event for T, as squad-reclaim reads it.
    const newestDrop = tEvents
      .map((o) => (o.kind === "copyEvent" ? { from: o.data.fromStatus, to: o.data.toStatus, at: o.data.at } : o.kind === "event" ? { from: o.transition.fromStatus, to: o.transition.toStatus, at: new Date(8.64e15) } : null))
      .filter((e): e is { from: string | null; to: string | null; at: Date } => !!e && e.to === "DROPPED")
      .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    expect(newestDrop?.from).toBe("CONFIRMED");
    expect(newestDrop?.at).toEqual(at);
  });
});
