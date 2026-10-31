/**
 * A CANCELLED WEEK'S LIST, AS THE ORGANISERS LEFT IT (FNF, 23 Oct 2026).
 *
 * FNF's Fri 23 Oct was seeded from 16 Oct, then the organisers changed
 * its list in HQ (Imti added 17 Oct, Clarence added 20 Oct, several
 * dropped; here one is also put on the bench and one removed outright on
 * the web), then the game was CANCELLED. The week after must carry that
 * list (2026-10-31). No model is called.
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const JAN_1 = new Date("2027-01-01T20:30:00.000Z");
const JAN_8 = new Date("2027-01-08T20:30:00.000Z");
const JAN_15 = new Date("2027-01-15T20:30:00.000Z");
const SEEDED_WK2 = "2027-01-02T08:00:31Z";
const CANCELLED_AT = "2027-01-07T15:40:00Z";
/** A tick the morning after the cancelled week's slot. */
const SAT_0805 = new Date("2027-01-09T08:05:00.000Z");

const ORG = "e2e-rsl-org";
const ACT = "e2e-rsl-act";

async function setup(db: TestDb) {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappBotEnabled", "rollingSquadEnabled", "updatedAt")
     VALUES ($1, 'Rolling list', 'e2e-rsl', 'e2e-rsl-invite', false, true, now())`,
    [ORG],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ('e2e-rsl-sport', $1, 'Football 9-a-side', 9, ARRAY['GK','DEF','MID','FWD'], ARRAY['Red','Yellow'], now())`,
    [ORG],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ($1, $2, 'e2e-rsl-sport', 'Friday 9-a-side', 5, '20:30', 'Powerleague', 5, now())`,
    [ACT, ORG],
  );
}

async function match(db: TestDb, id: string, date: Date, status: string, seededAt: string | null = null) {
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "rollingSeededAt", "updatedAt")
     VALUES ($1, $2, $3, 18, $4::"MatchStatus", $5, $6, now())`,
    [id, ACT, date.toISOString(), status, new Date(date.getTime() - 5 * 3600_000).toISOString(), seededAt],
  );
}

async function member(db: TestDb, userId: string, name: string, phone: string) {
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
    userId,
    `${userId}@e2e.test`,
    name,
    phone,
  ]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId") VALUES ($1, $2, $3)`, [`${userId}-mem`, userId, ORG]);
}

async function row(db: TestDb, matchId: string, userId: string, status: string, position: number) {
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt")
     VALUES ($1, $2, $3, $4::"AttendanceStatus", $5, now())`,
    [`${matchId}-${userId}`, matchId, userId, status, position],
  );
}

let evN = 0;
async function event(db: TestDb, matchId: string, userId: string, from: string | null, to: string | null, cause: string, at: string, pos: number | null) {
  await db.run(
    `INSERT INTO "AttendanceEvent" (id, "matchId", "userId", "orgId", "fromStatus", "toStatus", "toPosition", cause, "actorKind", at)
     VALUES ($1, $2, $3, $4, $5::"AttendanceStatus", $6::"AttendanceStatus", $7, $8, 'admin', $9)`,
    [`e2e-rsl-ev-${++evN}`, matchId, userId, ORG, from, to, pos, cause, new Date(at).toISOString()],
  );
}

async function tick(request: APIRequestContext, now: Date) {
  const res = await request.get("/api/cron/complete-matches", {
    headers: { authorization: `Bearer ${E2E.CRON_SECRET}`, "x-test-now": now.toISOString() },
  });
  expect(res.status(), await res.text()).toBe(200);
}

const rowsOn = (db: TestDb, matchId: string) =>
  db.all<{ userId: string; status: string }>(
    `SELECT "userId", status::text AS status FROM "Attendance" WHERE "matchId" = $1 ORDER BY position`,
    [matchId],
  );

test.describe("a cancelled week's edited list carries over (FNF shape)", () => {
  test.beforeAll(async () => {
    resetDb();
    const db = testDb();
    await setup(db);
    for (const [u, n, p] of [
      ["e2e-rsl-bilal", "Bilal", "+447700930001"],
      ["e2e-rsl-mo", "Mo", "+447700930002"],
      ["e2e-rsl-seb", "Seb", "+447700930003"],
      ["e2e-rsl-wasim", "Wasim", "+447700930004"],
      ["e2e-rsl-imti", "Imti", "+447700930005"],
      ["e2e-rsl-clarence", "Clarence", "+447700930006"],
      ["e2e-rsl-kieran", "Kieran", "+447700930007"],
    ] as const) {
      await member(db, u, n, p);
    }
    // wk1 (16 Oct): played.
    await match(db, "e2e-rsl-wk1", JAN_1, "COMPLETED");
    for (const [u, p] of [["e2e-rsl-bilal", 1], ["e2e-rsl-mo", 2], ["e2e-rsl-seb", 3], ["e2e-rsl-wasim", 4], ["e2e-rsl-kieran", 7]] as const) {
      await row(db, "e2e-rsl-wk1", u, "CONFIRMED", p);
    }
    // wk2 (23 Oct): seeded from wk1, edited by the organisers, then cancelled.
    await match(db, "e2e-rsl-wk2", JAN_8, "CANCELLED", SEEDED_WK2);
    await db.run(`UPDATE "Match" SET "updatedAt" = $2, "rollingSeededFromMatchId" = 'e2e-rsl-wk1' WHERE id = $1`, [
      "e2e-rsl-wk2",
      new Date(CANCELLED_AT).toISOString(),
    ]);
    for (const [u, p] of [["e2e-rsl-bilal", 1], ["e2e-rsl-mo", 2], ["e2e-rsl-seb", 3], ["e2e-rsl-wasim", 4], ["e2e-rsl-kieran", 7]] as const) {
      await event(db, "e2e-rsl-wk2", u, null, "CONFIRMED", "rolling-squad", SEEDED_WK2, p);
    }
    await row(db, "e2e-rsl-wk2", "e2e-rsl-bilal", "CONFIRMED", 1);
    await row(db, "e2e-rsl-wk2", "e2e-rsl-mo", "DROPPED", 2);
    await row(db, "e2e-rsl-wk2", "e2e-rsl-seb", "CONFIRMED", 3);
    await row(db, "e2e-rsl-wk2", "e2e-rsl-wasim", "BENCH", 4);
    await row(db, "e2e-rsl-wk2", "e2e-rsl-imti", "CONFIRMED", 5);
    await row(db, "e2e-rsl-wk2", "e2e-rsl-clarence", "CONFIRMED", 6);
    await event(db, "e2e-rsl-wk2", "e2e-rsl-mo", "CONFIRMED", "DROPPED", "admin-message", "2027-01-02T08:44:27Z", 2);
    await event(db, "e2e-rsl-wk2", "e2e-rsl-imti", null, "CONFIRMED", "admin-message", "2027-01-02T08:44:34Z", 5);
    await event(db, "e2e-rsl-wk2", "e2e-rsl-wasim", "CONFIRMED", "BENCH", "admin-message", "2027-01-04T10:00:00Z", 4);
    await event(db, "e2e-rsl-wk2", "e2e-rsl-clarence", null, "CONFIRMED", "admin-message", "2027-01-05T12:48:36Z", 6);
    // Kieran's row deleted outright (web "remove from match": toStatus null, no row left).
    await event(db, "e2e-rsl-wk2", "e2e-rsl-kieran", "CONFIRMED", null, "admin-squad-edit", "2027-01-06T09:00:00Z", null);
    // wk3 (30 Oct): next.
    await match(db, "e2e-rsl-wk3", JAN_15, "UPCOMING");
  });

  test.afterAll(() => resetDb());

  test("the week after carries the cancelled week's list: Imti and Clarence in; Mo, the benched Wasim and the removed Kieran not", async ({ request, db }) => {
    await tick(request, SAT_0805);
    const rows = await rowsOn(db, "e2e-rsl-wk3");
    expect(rows.filter((r) => r.status === "CONFIRMED").map((r) => r.userId)).toEqual([
      "e2e-rsl-bilal",
      "e2e-rsl-seb",
      "e2e-rsl-imti",
      "e2e-rsl-clarence",
    ]);
    expect(rows.map((r) => r.userId)).not.toContain("e2e-rsl-wasim");
    expect(rows.map((r) => r.userId)).not.toContain("e2e-rsl-kieran");
  });
});
