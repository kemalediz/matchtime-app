/**
 * `lib/user-merge.ts` against the REAL embedded Postgres, under tsx (the
 * lib imports the Prisma 7 generated client, which Playwright's
 * transpiler cannot load). Invoked by e2e/api/user-merge.spec.ts, which
 * arms the AttendanceEvent COVERAGE gate first, so every attendance move
 * here must have its event in the same transaction or COMMIT fails.
 *
 * What a real database shows that the planner's unit suite cannot:
 *   - the Najib shape: a phoneless player at club A folded into the same
 *     person at club B. Club A's membership moves whole (its seed and Elo
 *     untouched), club B's numbers are untouched, the club A name becomes
 *     an alias at club A, attendance, ratings, team places, MoM votes and
 *     the rate-dm marker move; the source is deactivated, not deleted;
 *     the old events stay and new ones are appended; one UserMerge row
 *     with its detail;
 *   - the dry run writes nothing and plans exactly what the apply does;
 *   - a second apply is a no-op that writes nothing;
 *   - both in the same club: rows combined under the real unique keys,
 *     the higher role kept and logged, the higher squad status kept;
 *   - a blocked merge (source has a real email) writes nothing.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";
import { MATCH, ORG_ID, U } from "./constants";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;

  const { db } = await import("@/lib/db");
  const { applyUserMerge, dryRunUserMerge } = await import("@/lib/user-merge");
  const { recordAttendanceEvent } = await import("@/lib/attendance-events");
  const { USER_MERGE_REASON } = await import("@/lib/user-merge-plan");
  const { loadReclaimUserIds } = await import("@/lib/squad-reclaim");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ✓ ${label}`);
  };

  const P = "e2e-umerge";
  const OTHER = `${P}-org-other`;
  const count = async () => ({
    events: await db.attendanceEvent.count(),
    merges: await db.userMerge.count(),
    aliases: await db.userAlias.count(),
    roleChanges: await db.roleChange.count(),
  });
  const place = async (userId: string, matchId: string, status: "CONFIRMED" | "BENCH", position: number) =>
    db.$transaction(async (tx) => {
      await tx.attendance.create({ data: { matchId, userId, status, position } });
      await recordAttendanceEvent(
        tx,
        { matchId, userId, orgId: ORG_ID, fromStatus: null, toStatus: status, fromPosition: null, toPosition: position },
        { cause: "test-fixture", actorKind: "script" },
      );
    });

  // ── The Najib shape ──
  await db.organisation.create({ data: { id: OTHER, name: "E2E Other FC", slug: `${P}-other`, inviteCode: `${P}-invite` } });
  const src = `${P}-src`;
  const tgt = `${P}-tgt`;
  await db.user.create({ data: { id: src, name: "Uncle Nabz", email: `provisional+uncle-nabz-x@placeholder.matchtime` } });
  await db.user.create({ data: { id: tgt, name: "Nabz", email: `${P}-tgt@placeholder.matchtime`, phoneNumber: "+447700900991" } });
  await db.membership.create({ data: { id: `${P}-m-src`, userId: src, orgId: ORG_ID, seedRating: 6, matchRating: 1042 } });
  await db.membership.create({ data: { id: `${P}-m-tgt`, userId: tgt, orgId: OTHER, seedRating: 8, matchRating: 1100 } });
  await place(src, MATCH.upcoming, "CONFIRMED", 7);
  await place(src, MATCH.rate, "CONFIRMED", 7);
  await db.rating.create({ data: { matchId: MATCH.rate, raterId: src, playerId: U.player, score: 7 } });
  await db.rating.create({ data: { matchId: MATCH.rate, raterId: U.third, playerId: src, score: 6 } });
  await db.teamAssignment.create({ data: { matchId: MATCH.rate, userId: src, team: "RED" } });
  await db.moMVote.create({ data: { matchId: MATCH.rate, voterId: U.player, playerId: src } });
  await db.sentNotification.create({ data: { key: `${MATCH.rate}:rate-dm:${src}`, kind: "rate-dm", matchId: MATCH.rate, targetUser: src } });
  await db.adminFeeProposal.create({
    data: { orgId: ORG_ID, matchId: MATCH.pay, waMessageId: `${P}-fee`, proposedByUserId: U.admin, userIds: [src, U.player], expiresAt: new Date(Date.now() + 3600_000) },
  });

  // History on a match where the source no longer holds a row (removed):
  // still inherited, and only once across re-runs.
  await place(src, MATCH.pay, "CONFIRMED", 9);
  await db.$transaction(async (tx) => {
    await tx.attendance.delete({ where: { matchId_userId: { matchId: MATCH.pay, userId: src } } });
    await recordAttendanceEvent(
      tx,
      { matchId: MATCH.pay, userId: src, orgId: ORG_ID, fromStatus: "CONFIRMED", toStatus: null, fromPosition: 9, toPosition: null },
      { cause: "admin-squad-edit", actorKind: "admin", actorUserId: U.admin },
    );
  });

  const before = await count();
  const srcEventsBefore = await db.attendanceEvent.count({ where: { userId: src } });
  const historyOf = async (userId: string) =>
    (await db.attendanceEvent.findMany({ where: { userId, cause: { notIn: ["player-merge", "rolling-squad"] } }, orderBy: [{ at: "asc" }, { id: "asc" }] })).map(
      (e) => ({ matchId: e.matchId, orgId: e.orgId, fromStatus: e.fromStatus, toStatus: e.toStatus, fromPosition: e.fromPosition, toPosition: e.toPosition, cause: e.cause, actorKind: e.actorKind, sourceRef: e.sourceRef, note: e.note, at: e.at.toISOString() }),
    );
  const srcHistory = await historyOf(src);

  // Dry run: plans, writes nothing.
  const dry = await dryRunUserMerge(db, src, tgt);
  assert.deepEqual(dry.plan.blockers, []);
  assert.deepEqual(await count(), before, "the dry run wrote nothing");
  assert.equal((await db.user.findUnique({ where: { id: src } }))!.isActive, true);
  ok("the dry run plans the merge and writes nothing");

  const res = await applyUserMerge(db, src, tgt);
  assert.ok(res.ok && !res.noop, `applied: ${JSON.stringify(res.plan.blockers)}`);
  assert.equal(res.plan.ops.length, dry.plan.ops.length, "the apply did exactly what the dry run showed");

  const srcUser = await db.user.findUnique({ where: { id: src } });
  const tgtUser = await db.user.findUnique({ where: { id: tgt } });
  assert.ok(srcUser, "source is never deleted");
  assert.equal(srcUser!.isActive, false);
  assert.equal(tgtUser!.name, "Nabz");
  assert.equal(tgtUser!.phoneNumber, "+447700900991");
  ok("source deactivated, not deleted; target keeps its name and phone");

  const memA = await db.membership.findUnique({ where: { userId_orgId: { userId: tgt, orgId: ORG_ID } } });
  const memB = await db.membership.findUnique({ where: { userId_orgId: { userId: tgt, orgId: OTHER } } });
  assert.equal(memA?.id, `${P}-m-src`, "club A's row moved whole");
  assert.equal(memA?.seedRating, 6);
  assert.equal(memA?.matchRating, 1042);
  assert.equal(memB?.seedRating, 8);
  assert.equal(memB?.matchRating, 1100);
  assert.equal(await db.membership.count({ where: { userId: src } }), 0);
  ok("club-scoped: club A's seed and Elo moved with club A's row; club B's untouched");

  const alias = await db.userAlias.findUnique({ where: { orgId_alias: { orgId: ORG_ID, alias: "uncle nabz" } } });
  assert.equal(alias?.userId, tgt);
  ok('"uncle nabz" is an alias for the target at club A');

  assert.equal(await db.attendance.count({ where: { userId: src } }), 0);
  assert.equal(await db.attendance.count({ where: { userId: tgt, matchId: { in: [MATCH.upcoming, MATCH.rate] } } }), 2);
  assert.equal(await db.attendanceEvent.count({ where: { userId: src } }), srcEventsBefore + 2, "old events kept, one 'lost the place' per match appended");
  assert.deepEqual(await historyOf(tgt), srcHistory, "the target's history is the source's, event for event, original times kept");
  assert.equal(await db.attendanceEvent.count({ where: { userId: tgt, cause: "player-merge" } }), 0, "history already ends at the rows: no extra event");
  ok("attendance moved; the target inherited the source's history; the old events stay (coverage gate armed)");

  assert.equal(await db.rating.count({ where: { OR: [{ raterId: src }, { playerId: src }] } }), 0);
  assert.equal(await db.rating.count({ where: { matchId: MATCH.rate, raterId: tgt, playerId: U.player } }), 1);
  assert.equal(await db.rating.count({ where: { matchId: MATCH.rate, raterId: U.third, playerId: tgt } }), 1);
  assert.equal(await db.teamAssignment.count({ where: { userId: tgt, matchId: MATCH.rate } }), 1);
  assert.equal(await db.moMVote.count({ where: { playerId: tgt, matchId: MATCH.rate } }), 1);
  const note = await db.sentNotification.findUnique({ where: { key: `${MATCH.rate}:rate-dm:${tgt}` } });
  assert.equal(note?.targetUser, tgt);
  const fee = await db.adminFeeProposal.findUnique({ where: { waMessageId: `${P}-fee` } });
  assert.deepEqual(fee?.userIds, [tgt, U.player]);
  ok("ratings, team place, MoM vote, the rate-dm marker and id lists name the target");

  const merges: Array<{ orgId: string; reason: string | null; has: boolean }> = await db.$queryRaw`
    SELECT "orgId", reason, detail IS NOT NULL AS has FROM "UserMerge" WHERE "oldUserId" = ${src}`;
  assert.deepEqual(merges, [{ orgId: ORG_ID, reason: USER_MERGE_REASON, has: true }]);
  ok("one UserMerge row per club, with the audit detail");

  // Idempotent.
  const mid = await count();
  const again = await applyUserMerge(db, src, tgt);
  assert.ok(again.ok && again.noop, "second run is a no-op");
  assert.deepEqual(await count(), mid, "and wrote nothing");
  ok("a second run is a no-op");

  // ── Reclaim: a moved DROPPED place is still reclaimable ──
  {
    const s4 = `${P}-src4`;
    const t4 = `${P}-tgt4`;
    await db.user.create({ data: { id: s4, name: "Reclaimer", email: `${P}-s4@placeholder.matchtime` } });
    await db.user.create({ data: { id: t4, name: "Reclaimer Real", email: `${P}-t4@placeholder.matchtime`, phoneNumber: "+447700900994" } });
    await db.membership.create({ data: { userId: s4, orgId: ORG_ID } });
    await place(s4, MATCH.upcoming, "CONFIRMED", 9);
    await db.$transaction(async (tx) => {
      await tx.attendance.update({ where: { matchId_userId: { matchId: MATCH.upcoming, userId: s4 } }, data: { status: "DROPPED" } });
      await recordAttendanceEvent(
        tx,
        { matchId: MATCH.upcoming, userId: s4, orgId: ORG_ID, fromStatus: "CONFIRMED", toStatus: "DROPPED", fromPosition: 9, toPosition: 9 },
        { cause: "self-attendance", actorKind: "player", actorUserId: s4 },
      );
    });
    assert.deepEqual(await loadReclaimUserIds(MATCH.upcoming, [s4]), [s4], "fixture: reclaimable before the merge");
    const r4 = await applyUserMerge(db, s4, t4);
    assert.ok(r4.ok && !r4.noop);
    assert.deepEqual(await loadReclaimUserIds(MATCH.upcoming, [t4]), [t4]);
    ok("squad-reclaim: the target can reclaim the place the source dropped");
  }

  // ── A checkout in flight: refused ──
  {
    const s5 = `${P}-src5`;
    await db.user.create({ data: { id: s5, name: "Paying", email: `${P}-s5@placeholder.matchtime` } });
    await db.membership.create({ data: { userId: s5, orgId: ORG_ID } });
    await place(s5, MATCH.rate, "CONFIRMED", 11);
    await db.attendance.update({ where: { matchId_userId: { matchId: MATCH.rate, userId: s5 } }, data: { stripeSessionId: "cs_test_open" } });
    const b = await count();
    const r5 = await applyUserMerge(db, s5, tgt);
    assert.equal(r5.ok, false);
    assert.match(r5.plan.blockers.join(), /checkout in flight/);
    assert.deepEqual(await count(), b);
    ok("a source with a Stripe checkout in flight is refused, nothing written");
  }

  // ── Both in the same club ──
  const s2 = `${P}-src2`;
  const t2 = `${P}-tgt2`;
  await db.user.create({ data: { id: s2, name: "Lucs", email: `${P}-s2@placeholder.matchtime` } });
  await db.user.create({ data: { id: t2, name: "Luca", email: `${P}-t2@placeholder.matchtime`, phoneNumber: "+447700900992" } });
  await db.membership.create({ data: { userId: s2, orgId: ORG_ID, role: "ADMIN", seedRating: 5 } });
  await db.membership.create({ data: { userId: t2, orgId: ORG_ID, role: "PLAYER" } });
  await place(s2, MATCH.upcoming, "CONFIRMED", 8);
  await place(t2, MATCH.upcoming, "BENCH", 12);
  await db.rating.create({ data: { matchId: MATCH.rate, raterId: s2, playerId: U.player, score: 3 } });
  await db.rating.create({ data: { matchId: MATCH.rate, raterId: t2, playerId: U.player, score: 9 } });
  const r2 = await applyUserMerge(db, s2, t2);
  assert.ok(r2.ok && !r2.noop);
  const m2 = await db.membership.findUnique({ where: { userId_orgId: { userId: t2, orgId: ORG_ID } } });
  assert.equal(m2?.role, "ADMIN");
  assert.equal(m2?.seedRating, 5);
  assert.equal(await db.roleChange.count({ where: { userId: t2, orgId: ORG_ID, toRole: "ADMIN", source: "merge" } }), 1);
  const a2 = await db.attendance.findUnique({ where: { matchId_userId: { matchId: MATCH.upcoming, userId: t2 } } });
  assert.equal(a2?.status, "CONFIRMED");
  assert.equal(await db.attendance.count({ where: { userId: s2 } }), 0);
  const kept = await db.rating.findMany({ where: { matchId: MATCH.rate, raterId: t2, playerId: U.player } });
  assert.deepEqual(kept.map((r) => r.score), [9], "the target's own rating wins the unique key");
  ok("same club: combined under the real unique keys, higher role kept and logged, CONFIRMED beats BENCH");

  // ── Blocked ──
  const s3 = `${P}-src3`;
  await db.user.create({ data: { id: s3, name: "Signed In", email: `${P}-real@example.com` } });
  await db.membership.create({ data: { userId: s3, orgId: ORG_ID } });
  const b0 = await count();
  const r3 = await applyUserMerge(db, s3, t2);
  assert.equal(r3.ok, false);
  assert.match(r3.plan.blockers.join(), /sign in/);
  assert.deepEqual(await count(), b0);
  assert.equal((await db.user.findUnique({ where: { id: s3 } }))!.isActive, true);
  ok("a blocked merge writes nothing");

  console.log(`OK (${n} checks)`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
