/**
 * `lib/format-resize.ts` (one match switched to another size inside its
 * game's range, 2026-11-03) against the REAL embedded Postgres, under tsx
 * (the lib imports the Prisma 7 generated client, which Playwright's
 * transpiler cannot load). Invoked by e2e/api/format-resize.spec.ts via
 * execFile; exits non-zero with a readable message on any failure. No model.
 *
 * What a real database shows that the pure rules cannot:
 *   - the match keeps its Activity and its kickoff, and no second match is
 *     made; only `Match.maxPlayers` changes;
 *   - UP: the bench moves in, in bench order, a player who asked to be on
 *     the bench stays there; each gets a DM; the new roster is posted once;
 *   - DOWN: the last to join go to the bench, each told by DM;
 *   - teams already made are cleared, the status back to UPCOMING;
 *   - every move is one AttendanceEvent, cause "format-switch";
 *   - a size outside the range, the same size, a game with no range and a
 *     game already started are refused with nothing written.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";
import { ACTIVITY_ID, ORG_ID, U } from "./constants";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;

  const { resizeMatch } = await import("@/lib/format-resize");
  const { EXPLICIT_BENCH_NOTE } = await import("@/lib/attendance-events");
  const { db } = await import("@/lib/db");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ✓ ${label}`);
  };

  const P = "e2e-resize";
  // AttendanceEvent is append-only (a trigger), so nothing here is deleted:
  // each round has a match of its own, and the spec reseeds the world.
  let round = 0;
  let MATCH = "";
  const kickoff = new Date(Date.now() + 3 * 86_400_000);
  const users = Array.from({ length: 14 }, (_, i) => ({ id: `${P}-u${i + 1}`, name: `Resize Player ${i + 1}`, phone: `+4477009${String(10000 + i)}` }));

  async function cleanup() {
    await db.activity.update({ where: { id: ACTIVITY_ID }, data: { minPlayers: null, maxPlayers: null } });
  }
  for (const u of users) {
    await db.user.create({ data: { id: u.id, name: u.name, phoneNumber: u.phone, email: `${u.id}@e2e.test` } });
    await db.membership.create({ data: { userId: u.id, orgId: ORG_ID, role: "PLAYER" } });
  }

  /** 10 confirmed (u1..u10, joined in order), u11 and u12 on the bench, u12 first in bench order. */
  async function seed() {
    await cleanup();
    MATCH = `${P}-match-${++round}`;
    await db.match.create({
      data: { id: MATCH, activityId: ACTIVITY_ID, date: kickoff, maxPlayers: 10, attendanceDeadline: new Date(kickoff.getTime() - 5 * 3600_000) },
    });
    const t0 = Date.now() - 86_400_000;
    for (let i = 0; i < 12; i++) {
      await db.attendance.create({
        data: {
          matchId: MATCH,
          userId: users[i].id,
          status: i < 10 ? "CONFIRMED" : "BENCH",
          // u12 (index 11) is ahead of u11 on the bench.
          position: i < 10 ? i + 1 : i === 10 ? 12 : 11,
          respondedAt: new Date(t0 + i * 60_000),
        },
      });
    }
  }

  const statusOf = async (i: number) =>
    (await db.attendance.findFirst({ where: { matchId: MATCH, userId: users[i - 1].id }, select: { status: true } }))?.status;
  const jobs = () => db.botJob.findMany({ where: { orgId: ORG_ID, matchId: MATCH }, orderBy: { createdAt: "asc" } });
  const actor = { actorUserId: U.admin, via: "lib-test" };

  try {
    await seed();

    // ── No range: refused, nothing written ──
    {
      const r = await resizeMatch({ matchId: MATCH, perSide: 6, ...actor });
      assert.equal(r.outcome, "format-no-range");
      assert.match(r.replyText, /is only 5-a-side/);
      const m = await db.match.findUnique({ where: { id: MATCH } });
      assert.equal(m?.maxPlayers, 10);
      assert.equal((await jobs()).length, 0);
    }
    ok("a game with no range: refused, nothing written");

    await db.activity.update({ where: { id: ACTIVITY_ID }, data: { minPlayers: 8, maxPlayers: 12 } });

    // ── Outside the range, and the same size: refused ──
    {
      assert.equal((await resizeMatch({ matchId: MATCH, perSide: 7, ...actor })).outcome, "format-not-allowed");
      assert.equal((await resizeMatch({ matchId: MATCH, perSide: 5, ...actor })).outcome, "format-unchanged");
      assert.equal((await resizeMatch({ matchId: MATCH, perSide: 0, ...actor })).outcome, "format-no-size");
      assert.equal((await db.match.findUnique({ where: { id: MATCH } }))?.maxPlayers, 10);
      assert.equal((await jobs()).length, 0);
    }
    ok("outside the range, the same size or no size: refused, nothing written");

    // ── UP to 6 a side: the bench moves in, in bench order ──
    const before = await db.match.findUnique({ where: { id: MATCH } });
    const matchesBefore = await db.match.count({ where: { activityId: ACTIVITY_ID } });
    {
      const r = await resizeMatch({ matchId: MATCH, perSide: 6, ...actor });
      assert.equal(r.outcome, "format-switched", r.replyText);
      assert.deepEqual(r.promoted, [users[11].id, users[10].id], "bench order: u12 then u11");
      assert.match(r.replyText, /is 6-a-side now, 12 places\. In from the bench: Resize Player 12 and Resize Player 11\./);
      const m = await db.match.findUnique({ where: { id: MATCH } });
      assert.equal(m?.maxPlayers, 12);
      assert.equal(m?.activityId, ACTIVITY_ID, "the match stays on its own game");
      assert.equal(m?.date.getTime(), before?.date.getTime(), "the kickoff does not move");
      assert.equal(await db.match.count({ where: { activityId: ACTIVITY_ID } }), matchesBefore, "no second match");
      assert.equal(await statusOf(11), "CONFIRMED");
      assert.equal(await statusOf(12), "CONFIRMED");
      const all = await jobs();
      const dms = all.filter((j) => j.kind === "dm");
      assert.equal(dms.length, 2);
      for (const d of dms) assert.match(d.text, /^We're going 6-a-side on \w+, you're in\. Can't make it after all\? Reply OUT\.$/);
      assert.deepEqual(dms.map((d) => d.phone).sort(), [users[10].phone, users[11].phone].map((p) => p.replace(/^\+/, "")).sort());
      const group = all.filter((j) => j.kind === "group");
      assert.equal(group.length, 1);
      assert.match(group[0].text, /^🔁 \*\w+ is 6-a-side now\* \(12 places\)\.\n\n\*Playing, 12 of 12:\*\n1\. /);
      assert.doesNotMatch(group[0].text, /Bench/);
      const events = await db.attendanceEvent.findMany({ where: { matchId: MATCH, cause: "format-switch" } });
      assert.equal(events.length, 2);
      assert.ok(await db.sentNotification.findUnique({ where: { key: `${MATCH}:format-up:12` } }), "the size chosen is never suggested again");
    }
    ok("up to 6 a side: the bench moved in bench order, DMs, one roster post, one event each, same match and kickoff");

    // ── DOWN to 4 a side: the last to join go to the bench ──
    await db.botJob.deleteMany({ where: { matchId: MATCH } });
    {
      const r = await resizeMatch({ matchId: MATCH, perSide: 4, ...actor });
      assert.equal(r.outcome, "format-switched", r.replyText);
      // Joined order: u1..u10, then u11 at t+10, u12 at t+11 (respondedAt).
      assert.deepEqual(r.demoted, [users[11].id, users[10].id, users[9].id, users[8].id]);
      assert.equal((await db.match.findUnique({ where: { id: MATCH } }))?.maxPlayers, 8);
      const dms = (await jobs()).filter((j) => j.kind === "dm");
      assert.equal(dms.length, 4);
      for (const d of dms) assert.match(d.text, /^We're going 4-a-side on \w+, so the squad is down to 8 and you're on the bench for now\.$/);
      const group = (await jobs()).filter((j) => j.kind === "group");
      assert.match(group[0].text, /\*Playing, 8 of 8:\*/);
      assert.match(group[0].text, /\*Bench:\*\n1\. /);
      for (const k of [10, 12]) assert.ok(await db.sentNotification.findUnique({ where: { key: `${MATCH}:format-up:${k}` } }), `no suggestion to undo it (${k})`);
    }
    ok("down to 4 a side: the last to join benched, each told, the roster shows the bench");

    // ── Teams out: cleared; a player who asked for the bench stays there ──
    await seed();
    await db.activity.update({ where: { id: ACTIVITY_ID }, data: { minPlayers: 8, maxPlayers: 12 } });
    await db.attendanceEvent.create({
      data: { matchId: MATCH, userId: users[11].id, orgId: ORG_ID, fromStatus: null, toStatus: "BENCH", cause: "self-attendance", actorKind: "player", note: EXPLICIT_BENCH_NOTE },
    });
    await db.teamAssignment.createMany({ data: users.slice(0, 10).map((u, i) => ({ matchId: MATCH, userId: u.id, team: i % 2 ? "RED" : "YELLOW" })) });
    await db.match.update({ where: { id: MATCH }, data: { status: "TEAMS_GENERATED" } });
    {
      const r = await resizeMatch({ matchId: MATCH, perSide: 6, ...actor });
      assert.equal(r.outcome, "format-switched", r.replyText);
      assert.deepEqual(r.promoted, [users[10].id], "u12 asked for the bench: only u11 moves in");
      assert.equal(await statusOf(12), "BENCH");
      assert.match(r.replyText, /The teams are cleared, so tag me to make them again\./);
      assert.equal(await db.teamAssignment.count({ where: { matchId: MATCH } }), 0);
      assert.equal((await db.match.findUnique({ where: { id: MATCH } }))?.status, "UPCOMING");
    }
    ok("teams out: cleared and back to UPCOMING; a player who asked for the bench is not moved in");

    // ── A game that has started: refused ──
    await db.match.update({ where: { id: MATCH }, data: { date: new Date(Date.now() - 60_000) } });
    assert.equal((await resizeMatch({ matchId: MATCH, perSide: 4, ...actor })).outcome, "format-too-late");
    ok("a game that has started: refused");

    console.log(`OK (${n} checks)`);
  } finally {
    await cleanup().catch((err) => console.error("cleanup failed:", err));
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
