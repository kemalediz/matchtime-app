/**
 * REVIEW OF #517 (uncommitted, failing): `resizeMatch` against concurrent
 * writers, on the REAL embedded Postgres, under tsx (see
 * format-resize-lib-tests.ts for why tsx). No model.
 *
 *   1. An OUT that commits while the switch is running is overwritten: the
 *      switch read the player as CONFIRMED, planned to bench him, and its
 *      unconditional `attendance.update` lands after his DROPPED. He is put
 *      back on the bench (and DM'd "you're on the bench") after saying OUT.
 *   2. Two switches to the same size at once (two organisers answering the
 *      same suggestion "yes", the suggestion names them all): both report
 *      "format-switched" and the new list is posted twice. The "already that
 *      size" check runs before the lock and is not repeated under it.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";
import { ACTIVITY_ID, ORG_ID, U } from "./constants";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;
  const { resizeMatch } = await import("@/lib/format-resize");
  const { db } = await import("@/lib/db");
  const P = "e2e-r517";
  const kickoff = new Date(Date.now() + 3 * 86_400_000);
  const users = Array.from({ length: 12 }, (_, i) => ({ id: `${P}-u${i + 1}`, name: `R517 Player ${i + 1}`, phone: `+4477008${String(10000 + i)}` }));
  for (const u of users) {
    await db.user.create({ data: { id: u.id, name: u.name, phoneNumber: u.phone, email: `${u.id}@e2e.test` } });
    await db.membership.create({ data: { userId: u.id, orgId: ORG_ID, role: "PLAYER" } });
  }
  await db.activity.update({ where: { id: ACTIVITY_ID }, data: { minPlayers: 8, maxPlayers: 12 } });
  let round = 0;
  async function seed(confirmed: number, places: number) {
    const id = `${P}-match-${++round}`;
    await db.match.create({ data: { id, activityId: ACTIVITY_ID, date: kickoff, maxPlayers: places, attendanceDeadline: new Date(kickoff.getTime() - 5 * 3600_000) } });
    const t0 = Date.now() - 86_400_000;
    for (let i = 0; i < confirmed; i++) {
      await db.attendance.create({ data: { matchId: id, userId: users[i].id, status: "CONFIRMED", position: i + 1, respondedAt: new Date(t0 + i * 60_000) } });
    }
    return id;
  }
  const failures: string[] = [];
  try {
    // ── 1. An OUT committing mid-switch ──
    {
      const MATCH = await seed(12, 12); // 12 in, 6 a side; u12 joined last
      const last = users[11].id;
      let outDone = false;
      const out = db.$transaction(
        async (tx) => {
          // u12 says OUT: his row is written (and locked) first ...
          await tx.attendance.update({ where: { matchId_userId: { matchId: MATCH, userId: last } }, data: { status: "DROPPED" } });
          await new Promise((r) => setTimeout(r, 1500));
          outDone = true;
        },
        { timeout: 10_000 },
      );
      await new Promise((r) => setTimeout(r, 200));
      // ... while an organiser switches to 5 a side (10 places).
      const r = await resizeMatch({ matchId: MATCH, perSide: 5, actorUserId: U.admin, via: "review-517" });
      await out;
      assert.ok(outDone);
      const row = await db.attendance.findUnique({ where: { matchId_userId: { matchId: MATCH, userId: last } }, select: { status: true } });
      const confirmed = await db.attendance.count({ where: { matchId: MATCH, status: "CONFIRMED" } });
      const dmToLast = await db.botJob.count({ where: { matchId: MATCH, kind: "dm", phone: users[11].phone.replace(/^\+/, "") } });
      console.log(`  1. outcome=${r.outcome} demoted=${r.demoted.length} u12=${row?.status} confirmed=${confirmed}/10 dmToU12=${dmToLast}`);
      if (row?.status !== "DROPPED") failures.push(`1. u12 said OUT mid-switch but ends ${row?.status} (expected DROPPED)`);
      if (confirmed !== 10) failures.push(`1. ${confirmed} confirmed on a 10-place match (expected 10: one benched too many)`);
    }
    // ── 2. Two switches to the same size at once ──
    {
      const MATCH = await seed(10, 10);
      const [a, b] = await Promise.all([
        resizeMatch({ matchId: MATCH, perSide: 6, actorUserId: U.admin, via: "review-517-a" }),
        resizeMatch({ matchId: MATCH, perSide: 6, actorUserId: U.admin, via: "review-517-b" }),
      ]);
      const posts = await db.botJob.count({ where: { matchId: MATCH, kind: "group" } });
      console.log(`  2. outcomes=${a.outcome},${b.outcome} groupPosts=${posts}`);
      if (posts !== 1) failures.push(`2. two concurrent switches to 6 a side posted the list ${posts} times (expected 1)`);
      if ([a.outcome, b.outcome].filter((o) => o === "format-switched").length !== 1) failures.push(`2. both said format-switched`);
    }
  } finally {
    await db.activity.update({ where: { id: ACTIVITY_ID }, data: { minPlayers: null, maxPlayers: null } }).catch(() => {});
    await db.$disconnect();
  }
  if (failures.length) {
    console.error("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("OK");
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
