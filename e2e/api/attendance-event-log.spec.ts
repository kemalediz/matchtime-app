/**
 * The append-only attendance log, against a real Postgres.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THESE ASSERTIONS AND NOT OTHERS
 * ─────────────────────────────────────────────────────────────────────
 * The unit tests cover the shape of an event and the fold that rebuilds
 * a squad from one. Three properties cannot be asserted in TypeScript at
 * all, because they are enforced by the DATABASE, and they are the ones
 * the log's credibility rests on:
 *
 *   1. **It cannot be rewritten.** An UPDATE or a DELETE on
 *      "AttendanceEvent" is refused. A log an application can quietly
 *      correct is not evidence, and this log is the evidence §10 step 6
 *      of the analyzer redesign turns on.
 *   2. **A squad-state write with no event FAILS.** Proven by arming
 *      `prisma/sql/attendance-event-coverage.sql` — a DEFERRED
 *      constraint trigger that checks, at COMMIT, that an event was
 *      written by the SAME TRANSACTION. It is armed here and dropped in
 *      afterAll: it is a test-database gate, deliberately not part of
 *      the production migration, because arming it in production would
 *      turn "a writer we missed" into a thrown registration.
 *      (`workers: 1` + `fullyParallel: false` in playwright.config.ts
 *      is what makes arming it mid-suite safe.)
 *   3. **The real writers pass that gate.** Not "an event exists
 *      somewhere" — the actual production endpoints are driven WITH the
 *      gate armed, so a writer that forgot to log fails here rather
 *      than leaving a hole nobody notices for months.
 *
 * Plus the two things the harness needs: a squad reconstructed from the
 * log alone matches the live rows, and `batchId` groups one analyze
 * flush.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { setLlmStub } from "../helpers/stub";
import { U, MATCH, PHONE, ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import { squadStateAt, type AttendanceEventLike } from "@/lib/attendance-events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../helpers/env";

test.describe.configure({ mode: "serial" });

let n = 0;
const msgId = () => `e2e-att-event-${Date.now()}-${++n}`;

const COVERAGE_SQL = path.join(REPO_ROOT, "prisma", "sql", "attendance-event-coverage.sql");

async function armCoverageGate(db: TestDb): Promise<void> {
  await db.run(readFileSync(COVERAGE_SQL, "utf8"));
}

async function disarmCoverageGate(db: TestDb): Promise<void> {
  for (const t of [
    "attendance_requires_event_ins",
    "attendance_requires_event_upd",
    "attendance_requires_event_del",
  ]) {
    await db.run(`DROP TRIGGER IF EXISTS ${t} ON "Attendance"`);
  }
}

interface EventRow {
  matchId: string;
  userId: string;
  orgId: string;
  fromStatus: string | null;
  toStatus: string | null;
  toPosition: number | null;
  cause: string;
  actorKind: string;
  actorUserId: string | null;
  sourceRef: string | null;
  txId: string | null;
  at: Date;
}

const eventsFor = (db: TestDb, matchId: string) =>
  db.all<EventRow>(`SELECT * FROM "AttendanceEvent" WHERE "matchId" = $1 ORDER BY "at" ASC, id ASC`, [
    matchId,
  ]);

const liveSquad = (db: TestDb, matchId: string) =>
  db.all<{ userId: string; status: string; position: number }>(
    `SELECT "userId", status::text AS status, position FROM "Attendance"
      WHERE "matchId" = $1 ORDER BY position ASC, "userId" ASC`,
    [matchId],
  );

async function markIn(request: Parameters<typeof postAnalyze>[0], userId: keyof typeof U) {
  return request.post("/api/whatsapp/attendance", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: {
      groupId: E2E.GROUP_ID,
      phoneNumber: PHONE[userId as keyof typeof PHONE],
      action: "IN",
    },
  });
}

test.beforeAll(() => {
  resetDb();
});

test.afterAll(async () => {
  // The coverage gate is a TEST gate. Never leave it armed for another
  // spec, and never leave it behind at all.
  await disarmCoverageGate(testDb());
});

// ── 1. Append-only ─────────────────────────────────────────────────────

test.describe("the log cannot be rewritten", () => {
  test("an UPDATE on AttendanceEvent is refused by the database", async ({ db }) => {
    const before = await db.count(`SELECT COUNT(*) FROM "AttendanceEvent"`);
    expect(before, "the fixture world seeds a history, not just a state").toBeGreaterThan(0);

    await expect(
      db.run(`UPDATE "AttendanceEvent" SET cause = 'rewritten' WHERE id = (SELECT id FROM "AttendanceEvent" LIMIT 1)`),
    ).rejects.toThrow(/append-only/i);

    // And nothing changed.
    const rewritten = await db.count(
      `SELECT COUNT(*) FROM "AttendanceEvent" WHERE cause = 'rewritten'`,
    );
    expect(rewritten).toBe(0);
  });

  test("a DELETE on AttendanceEvent is refused by the database", async ({ db }) => {
    const before = await db.count(`SELECT COUNT(*) FROM "AttendanceEvent"`);
    await expect(
      db.run(`DELETE FROM "AttendanceEvent" WHERE id = (SELECT id FROM "AttendanceEvent" LIMIT 1)`),
    ).rejects.toThrow(/append-only/i);
    expect(await db.count(`SELECT COUNT(*) FROM "AttendanceEvent"`)).toBe(before);
  });
});

// ── 2 + 3. Coverage: a write with no event fails; the real writers pass ─

test.describe("a squad-state write without an event FAILS", () => {
  test.beforeAll(async () => {
    await armCoverageGate(testDb());
  });
  test.afterAll(async () => {
    await disarmCoverageGate(testDb());
  });

  test("a bare UPDATE that changes status is rejected at COMMIT", async ({ db }) => {
    await expect(
      db.run(
        `UPDATE "Attendance" SET status = 'DROPPED' WHERE "matchId" = $1 AND "userId" = $2`,
        [MATCH.upcoming, U.third],
      ),
    ).rejects.toThrow(/wrote no AttendanceEvent/i);

    // The rejection ROLLED BACK: the player is still confirmed.
    const row = await db.one<{ status: string }>(
      `SELECT status::text AS status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
      [MATCH.upcoming, U.third],
    );
    expect(row?.status).toBe("CONFIRMED");
  });

  test("a bare INSERT of a new squad place is rejected at COMMIT", async ({ db }) => {
    await expect(
      db.run(
        `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt")
         VALUES ('e2e-att-nolog', $1, $2, 'CONFIRMED', 99, NOW())`,
        [MATCH.upcoming, U.fresh],
      ),
    ).rejects.toThrow(/wrote no AttendanceEvent/i);
    expect(
      await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE id = 'e2e-att-nolog'`),
    ).toBe(0);
  });

  test("PAYMENT metadata is not a squad place, and is not gated", async ({ db }) => {
    // Sutton's per-player payment writes touch Attendance constantly.
    // Requiring an event for those would fill the log with noise and
    // break the payment path for nothing.
    await db.run(`UPDATE "Attendance" SET "paidAt" = NOW() WHERE "matchId" = $1 AND "userId" = $2`, [
      MATCH.pay,
      U.player,
    ]);
    const paid = await db.count(
      `SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2 AND "paidAt" IS NOT NULL`,
      [MATCH.pay, U.player],
    );
    expect(paid).toBe(1);
  });

  test("the REAL bot IN/OUT endpoint passes the gate, and names its cause", async ({ request, db }) => {
    const res = await markIn(request, "fresh");
    expect(res.status(), await res.text()).toBe(200);

    const ev = await db.one<EventRow>(
      `SELECT * FROM "AttendanceEvent"
        WHERE "matchId" = $1 AND "userId" = $2 ORDER BY "at" DESC LIMIT 1`,
      [MATCH.upcoming, U.fresh],
    );
    expect(ev, "the write landed, so an event must have landed with it").not.toBeNull();
    expect(ev!.cause).toBe("self-attendance");
    expect(ev!.actorKind).toBe("player");
    expect(ev!.actorUserId).toBe(U.fresh);
    expect(ev!.orgId).toBe(ORG_ID);
    expect(ev!.fromStatus).toBeNull(); // no row existed
    // 4 confirmed of 5 before this, so the fifth place is a slot, not a bench.
    expect(ev!.toStatus).toBe("CONFIRMED");
    expect(ev!.txId, "the DB fills txId; it is what proves same-transaction").toBeTruthy();
  });

  test("the REAL analyze route passes the gate on a third-party OUT", async ({ request, db }) => {
    const id = msgId();
    setLlmStub({
      [id]: {
        intent: "out",
        confidence: 0.95,
        registerFor: [{ name: "Tom", action: "OUT" }],
        reasoning: "third-party OUT",
      },
    });
    await postAnalyze(request, [
      {
        waMessageId: id,
        body: "@Match Time Tom can't make it",
        authorPhone: PHONE.admin,
        authorName: "Ada Admin",
        botMentioned: true,
      },
    ]);

    const ev = await db.one<EventRow>(
      `SELECT * FROM "AttendanceEvent"
        WHERE "matchId" = $1 AND "userId" = $2 ORDER BY "at" DESC LIMIT 1`,
      [MATCH.upcoming, U.third],
    );
    expect(ev).not.toBeNull();
    expect(ev!.toStatus).toBe("DROPPED");
    // The SUBJECT is Tessa; the ACTOR is the admin who spoke. Recording
    // only the effect would make this indistinguishable from a self-OUT,
    // which is exactly the distinction a replay needs.
    expect(ev!.userId).toBe(U.third);
    expect(ev!.actorUserId).toBe(U.admin);
    expect(["admin-message", "third-party-attendance"]).toContain(ev!.cause);
    expect(ev!.sourceRef).toBe(id);
  });
});

// ── 4. Reconstruction ──────────────────────────────────────────────────

test.describe("a squad can be rebuilt from the log alone", () => {
  test.beforeAll(() => {
    resetDb();
  });

  test("the reconstruction at NOW matches the live rows, after real transitions", async ({
    request,
    db,
  }) => {
    // Take the "before" instant FROM THE LOG, not from this process's
    // clock. `AttendanceEvent.at` is a `TIMESTAMP(3)` (no zone), so the
    // pg driver reads it back in the worker's local zone — comparing it
    // against a JS `new Date()` would be off by the UTC offset and the
    // assertion would silently test the wrong moment. Everything the
    // replay harness compares comes from the same column, so it is
    // self-consistent; this test has to opt into that too.
    const seededAt = (
      await db.one<{ at: Date }>(
        `SELECT MAX("at") AS at FROM "AttendanceEvent" WHERE "matchId" = $1`,
        [MATCH.upcoming],
      )
    )!.at;

    // Drive real transitions through the production endpoints: a join,
    // then a drop.
    expect((await markIn(request, "fresh")).status()).toBe(200);
    const out = await request.post("/api/whatsapp/attendance", {
      headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
      data: { groupId: E2E.GROUP_ID, phoneNumber: PHONE.player, action: "OUT" },
    });
    expect(out.status(), await out.text()).toBe(200);

    const events = (await eventsFor(db, MATCH.upcoming)) as unknown as AttendanceEventLike[];
    const rebuilt = squadStateAt(events, new Date(Date.now() + 24 * 60 * 60 * 1000), MATCH.upcoming);
    const live = await liveSquad(db, MATCH.upcoming);

    expect(rebuilt.map((p) => `${p.userId}:${p.status}`).sort()).toEqual(
      live.map((p) => `${p.userId}:${p.status}`).sort(),
    );
    // And the transitions really happened, so this is not a trivially
    // equal pair of empty sets.
    expect(live.find((p) => p.userId === U.player)?.status).toBe("DROPPED");
    expect(live.find((p) => p.userId === U.fresh)?.status).toBe("CONFIRMED");

    // AN ARBITRARY PAST INSTANT — the thing the old model could not
    // answer at all. Before either transition, the fixture squad stood
    // at 4 confirmed + 1 bench and neither of today's moves had happened.
    const before = squadStateAt(events, seededAt, MATCH.upcoming);
    expect(before.find((p) => p.userId === U.player)?.status).toBe("CONFIRMED");
    expect(before.find((p) => p.userId === U.fresh)).toBeUndefined();
    expect(before.filter((p) => p.status === "CONFIRMED")).toHaveLength(4);
    expect(before.filter((p) => p.status === "BENCH")).toHaveLength(1);
  });
});

// ── 5. batchId ─────────────────────────────────────────────────────────

test.describe("batchId records a flush instead of inferring it", () => {
  test("every message in one analyze request shares one batchId", async ({ request, db }) => {
    const ids = [msgId(), msgId(), msgId()];
    setLlmStub(
      Object.fromEntries(
        ids.map((id) => [id, { intent: "noise", confidence: 0.95, reasoning: "banter" }]),
      ),
    );
    await postAnalyze(
      request,
      ids.map((id, i) => ({
        waMessageId: id,
        body: `banter ${i}`,
        authorPhone: PHONE.player,
        authorName: "Pat",
      })),
    );

    const rows = await db.all<{ waMessageId: string; batchId: string | null }>(
      `SELECT "waMessageId", "batchId" FROM "AnalyzedMessage" WHERE "waMessageId" = ANY($1)`,
      [ids],
    );
    expect(rows).toHaveLength(3);
    const batchIds = new Set(rows.map((r) => r.batchId));
    expect(batchIds.size, "one flush is one batch").toBe(1);
    expect([...batchIds][0]).toBeTruthy();
  });

  test("a SECOND request is a different batch, however close together", async ({ request, db }) => {
    // This is the case the timing heuristic cannot call: two flushes
    // milliseconds apart look exactly like one slow flush, and
    // reconstruct.ts threw BOTH away rather than guess.
    const a = msgId();
    const b = msgId();
    setLlmStub({
      [a]: { intent: "noise", confidence: 0.9, reasoning: "x" },
      [b]: { intent: "noise", confidence: 0.9, reasoning: "y" },
    });
    await postAnalyze(request, [
      { waMessageId: a, body: "one", authorPhone: PHONE.player, authorName: "Pat" },
    ]);
    await postAnalyze(request, [
      { waMessageId: b, body: "two", authorPhone: PHONE.player, authorName: "Pat" },
    ]);

    const rows = await db.all<{ waMessageId: string; batchId: string | null }>(
      `SELECT "waMessageId", "batchId" FROM "AnalyzedMessage" WHERE "waMessageId" = ANY($1)`,
      [[a, b]],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].batchId).toBeTruthy();
    expect(rows[1].batchId).toBeTruthy();
    expect(rows[0].batchId).not.toBe(rows[1].batchId);
  });
});
