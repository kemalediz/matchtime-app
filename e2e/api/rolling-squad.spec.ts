/**
 * ROLLING SQUAD, END TO END AGAINST POSTGRES (2026-09-30).
 *
 * Slice 1 of MDs/friday-group-features-plan-2026-09-30.md. No model is
 * called anywhere in this file: the seeding is a cron, the posts are
 * fixed text, and the OUT messages go through the stubbed pipeline.
 *
 *   1. /api/cron/complete-matches seeds a rolling club's next match at
 *      08:00 London the morning after, with last week's players, once;
 *      the events are `rolling-squad`, written in the SAME transaction
 *      as the rows (the coverage gate is armed for the call).
 *   2. A club without the setting (Sutton's shape) is never seeded.
 *   3. Bench players, phoneless guests and leavers are not carried.
 *   4. After a cancelled week it seeds from the last PLAYED match within
 *      21 days; after a longer gap it seeds nothing.
 *   5. /api/whatsapp/due-posts posts the rolling announcement.
 *   6. An OUT before the deadline is an ordinary OUT; after it, it is
 *      still recorded and the owner is told it was late. Lateness is the
 *      SEND time.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { engineOn, selfOut } from "../helpers/stub";
import { E2E, REPO_ROOT } from "../helpers/env";
import { MATCH, NAME, ORG_ID, PHONE, U } from "../helpers/constants";
import { testDb, type TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const COVERAGE_SQL = path.join(REPO_ROOT, "prisma", "sql", "attendance-event-coverage.sql");
const COVERAGE_TRIGGERS = [
  "attendance_requires_event_ins",
  "attendance_requires_event_upd",
  "attendance_requires_event_del",
];

const DAY = 24 * 60 * 60 * 1000;
// Fridays in January 2027, 20:30 GMT (= 20:30 UTC).
const JAN_1 = new Date("2027-01-01T20:30:00.000Z");
const JAN_8 = new Date("2027-01-08T20:30:00.000Z");
const JAN_15 = new Date("2027-01-15T20:30:00.000Z");
/** The 08:00 London after the Jan 8 match (GMT, so 08:00 UTC). */
const SAT_0755 = new Date("2027-01-09T07:55:00.000Z");
const SAT_0805 = new Date("2027-01-09T08:05:00.000Z");
const SAT_1000 = new Date("2027-01-09T10:00:00.000Z");

const ROLLING_GROUP = "e2e-rolling@g.us";

/** One club with one Friday fixture. `rolling` is the setting. */
async function club(db: TestDb, key: string, rolling: boolean, group: string | null = null): Promise<void> {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled",
                                 "rollingSquadEnabled", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [`e2e-rs-org-${key}`, `Rolling ${key}`, `e2e-rs-${key}`, `e2e-rs-invite-${key}`, group, !!group, rolling],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ($1, $2, 'Football 9-a-side', 9, ARRAY['GK','DEF','MID','FWD'], ARRAY['Red','Yellow'], now())`,
    [`e2e-rs-sport-${key}`, `e2e-rs-org-${key}`],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ($1, $2, $3, 'Friday 9-a-side', 5, '20:30', 'Powerleague', 5, now())`,
    [`e2e-rs-act-${key}`, `e2e-rs-org-${key}`, `e2e-rs-sport-${key}`],
  );
}

async function match(db: TestDb, key: string, id: string, date: Date, status: string): Promise<void> {
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
     VALUES ($1, $2, $3, 18, $4::"MatchStatus", $5, now())`,
    [id, `e2e-rs-act-${key}`, date.toISOString(), status, new Date(date.getTime() - 5 * 60 * 60 * 1000).toISOString()],
  );
}

/** A member, with a phone unless `phone` is null. */
async function member(
  db: TestDb,
  key: string,
  userId: string,
  name: string,
  phone: string | null,
  opts: { left?: boolean; provisional?: boolean } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`,
    [userId, opts.provisional ? `provisional+${userId}@matchtime.local` : `${userId}@e2e.test`, name, phone],
  );
  await db.run(
    `INSERT INTO "Membership" (id, "userId", "orgId", "leftAt", "provisionallyAddedAt")
     VALUES ($1, $2, $3, $4, $5)`,
    [
      `e2e-rs-mem-${userId}`,
      userId,
      `e2e-rs-org-${key}`,
      opts.left ? new Date().toISOString() : null,
      opts.provisional ? new Date().toISOString() : null,
    ],
  );
}

/** An attendance row and its event, in one statement (one transaction). */
async function attend(db: TestDb, key: string, matchId: string, userId: string, status: string, position: number) {
  await db.run(
    `WITH a AS (
       INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt")
       VALUES ($1, $2, $3, $4::"AttendanceStatus", $5, now())
       RETURNING "matchId", "userId", status, position
     )
     INSERT INTO "AttendanceEvent" (id, "matchId", "userId", "orgId", "toStatus", "toPosition", cause, "actorKind")
     SELECT $6, "matchId", "userId", $7, status, position, 'test-fixture', 'system' FROM a`,
    [`e2e-rs-att-${matchId}-${userId}`, matchId, userId, status, position, `e2e-rs-ev-${matchId}-${userId}`, `e2e-rs-org-${key}`],
  );
}

async function completeMatchesAt(request: APIRequestContext, now: Date) {
  const res = await request.get("/api/cron/complete-matches", {
    headers: { authorization: `Bearer ${E2E.CRON_SECRET}`, "x-test-now": now.toISOString() },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { ok: boolean; completed: number; rollingSeeded: number };
}

const rowsOn = (db: TestDb, matchId: string) =>
  db.all<{ userId: string; status: string; position: number }>(
    `SELECT "userId", status::text AS status, position FROM "Attendance" WHERE "matchId" = $1 ORDER BY position`,
    [matchId],
  );

const seededFrom = async (db: TestDb, matchId: string) =>
  (
    await db.one<{ from: string | null; at: Date | null }>(
      `SELECT "rollingSeededFromMatchId" AS "from", "rollingSeededAt" AS at FROM "Match" WHERE id = $1`,
      [matchId],
    )
  ) ?? { from: null, at: null };

test.describe("seeding from the complete-matches cron", () => {
  test.beforeAll(async () => {
    resetDb();
    const db = testDb();

    // R: a rolling club. Last Friday (Jan 8) played; next Friday (Jan 15).
    await club(db, "r", true, ROLLING_GROUP);
    await member(db, "r", "e2e-rs-hamzah", "Hamzah Khan", "+447700910001");
    await member(db, "r", "e2e-rs-raihan", "Raihan Ahmed", "+447700910002");
    await member(db, "r", "e2e-rs-wasim", "Wasim Ali", "+447700910003");
    await member(db, "r", "e2e-rs-guest", "Gary Guest", null, { provisional: true });
    await member(db, "r", "e2e-rs-leaver", "Lee Leaver", "+447700910005", { left: true });
    await member(db, "r", "e2e-rs-bencher", "Ben Bencher", "+447700910006");
    await match(db, "r", "e2e-rs-r-last", JAN_8, "COMPLETED");
    await match(db, "r", "e2e-rs-r-next", JAN_15, "UPCOMING");
    await attend(db, "r", "e2e-rs-r-last", "e2e-rs-hamzah", "CONFIRMED", 1);
    await attend(db, "r", "e2e-rs-r-last", "e2e-rs-raihan", "CONFIRMED", 2);
    await attend(db, "r", "e2e-rs-r-last", "e2e-rs-wasim", "CONFIRMED", 3);
    await attend(db, "r", "e2e-rs-r-last", "e2e-rs-guest", "CONFIRMED", 4);
    await attend(db, "r", "e2e-rs-r-last", "e2e-rs-leaver", "CONFIRMED", 5);
    await attend(db, "r", "e2e-rs-r-last", "e2e-rs-bencher", "BENCH", 6);
    // Wasim already said OUT for next week: stays OUT.
    await attend(db, "r", "e2e-rs-r-next", "e2e-rs-wasim", "DROPPED", 1);

    // S: Sutton's shape, the same week, setting OFF.
    await club(db, "s", false);
    await member(db, "s", "e2e-rs-sam", "Sam Sutton", "+447700910011");
    await match(db, "s", "e2e-rs-s-last", JAN_8, "COMPLETED");
    await match(db, "s", "e2e-rs-s-next", JAN_15, "UPCOMING");
    await attend(db, "s", "e2e-rs-s-last", "e2e-rs-sam", "CONFIRMED", 1);

    // C: rolling, Jan 1 played, Jan 8 CANCELLED, Jan 15 next.
    await club(db, "c", true);
    await member(db, "c", "e2e-rs-cora", "Cora Cancel", "+447700910021");
    await member(db, "c", "e2e-rs-colin", "Colin Cancel", "+447700910022");
    await match(db, "c", "e2e-rs-c-wk1", JAN_1, "COMPLETED");
    await match(db, "c", "e2e-rs-c-wk2", JAN_8, "CANCELLED");
    await match(db, "c", "e2e-rs-c-wk3", JAN_15, "UPCOMING");
    await attend(db, "c", "e2e-rs-c-wk1", "e2e-rs-cora", "CONFIRMED", 1);
    await attend(db, "c", "e2e-rs-c-wk2", "e2e-rs-colin", "CONFIRMED", 1);

    // G: rolling, last played five weeks before the next match.
    await club(db, "g", true);
    await member(db, "g", "e2e-rs-gabe", "Gabe Gap", "+447700910031");
    await match(db, "g", "e2e-rs-g-old", new Date(JAN_15.getTime() - 35 * DAY), "COMPLETED");
    await match(db, "g", "e2e-rs-g-next", JAN_15, "UPCOMING");
    await attend(db, "g", "e2e-rs-g-old", "e2e-rs-gabe", "CONFIRMED", 1);
  });

  test.afterAll(async () => {
    const db = testDb();
    for (const t of COVERAGE_TRIGGERS) await db.run(`DROP TRIGGER IF EXISTS ${t} ON "Attendance"`);
    // The pinned clock completed other fixtures' matches too.
    resetDb();
  });

  test("before 08:00 the morning after, nothing is carried over", async ({ request, db }) => {
    await completeMatchesAt(request, SAT_0755);
    expect(await seededFrom(db, "e2e-rs-r-next")).toEqual({ from: null, at: null });
    expect(await rowsOn(db, "e2e-rs-r-next")).toHaveLength(1);
  });

  test("at 08:00 last week's players are in, once, each with a rolling-squad event in the same transaction", async ({
    request,
    db,
  }) => {
    await db.run(readFileSync(COVERAGE_SQL, "utf8"));
    try {
      const res = await completeMatchesAt(request, SAT_0805);
      expect(res.rollingSeeded).toBeGreaterThanOrEqual(1);
    } finally {
      for (const t of COVERAGE_TRIGGERS) await db.run(`DROP TRIGGER IF EXISTS ${t} ON "Attendance"`);
    }

    expect((await seededFrom(db, "e2e-rs-r-next")).from).toBe("e2e-rs-r-last");
    // Hamzah and Raihan carried; Wasim's early OUT stands; the guest,
    // the leaver and the bencher are not carried.
    expect(await rowsOn(db, "e2e-rs-r-next")).toEqual([
      { userId: "e2e-rs-wasim", status: "DROPPED", position: 1 },
      { userId: "e2e-rs-hamzah", status: "CONFIRMED", position: 2 },
      { userId: "e2e-rs-raihan", status: "CONFIRMED", position: 3 },
    ]);
    const events = await db.all<{ cause: string; actorKind: string; sourceRef: string; txId: string }>(
      `SELECT cause, "actorKind", "sourceRef", "txId" FROM "AttendanceEvent" WHERE "matchId" = $1`,
      ["e2e-rs-r-next"],
    );
    const seeded = events.filter((e) => e.cause === "rolling-squad");
    expect(seeded).toHaveLength(2);
    for (const e of seeded) expect(e).toMatchObject({ actorKind: "scheduler", sourceRef: "e2e-rs-r-last" });
    expect(new Set(seeded.map((e) => e.txId)).size).toBe(1);

    // A second tick is a no-op.
    await completeMatchesAt(request, new Date(SAT_0805.getTime() + 15 * 60 * 1000));
    expect(await rowsOn(db, "e2e-rs-r-next")).toHaveLength(3);
    expect(
      await db.count(`SELECT COUNT(*) FROM "AttendanceEvent" WHERE "matchId" = $1 AND cause = 'rolling-squad'`, [
        "e2e-rs-r-next",
      ]),
    ).toBe(2);
  });

  test("a club without the setting (Sutton's shape) is never seeded", async ({ db }) => {
    expect(await seededFrom(db, "e2e-rs-s-next")).toEqual({ from: null, at: null });
    expect(await rowsOn(db, "e2e-rs-s-next")).toEqual([]);
  });

  test("after a cancelled week it carries the last PLAYED match, not the cancelled one", async ({ db }) => {
    expect((await seededFrom(db, "e2e-rs-c-wk3")).from).toBe("e2e-rs-c-wk1");
    expect((await rowsOn(db, "e2e-rs-c-wk3")).map((r) => r.userId)).toEqual(["e2e-rs-cora"]);
  });

  test("after a longer gap nothing is carried", async ({ db }) => {
    expect(await seededFrom(db, "e2e-rs-g-next")).toEqual({ from: null, at: null });
    expect(await rowsOn(db, "e2e-rs-g-next")).toEqual([]);
  });

  test("the morning announcement lists the carried squad and the deadline", async ({ request }) => {
    const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(ROLLING_GROUP)}`, {
      headers: { "x-api-key": E2E.WHATSAPP_API_KEY, "x-test-now": SAT_1000.toISOString(), "x-no-claim": "1" },
    });
    expect(res.status(), await res.text()).toBe(200);
    const { instructions } = (await res.json()) as { instructions: Array<{ key: string; text?: string }> };
    const ann = instructions.filter((i) => i.key === "e2e-rs-r-next:rolling-announce");
    expect(ann).toHaveLength(1);
    expect(ann[0].text).toBe(
      [
        "📅 *Friday 9-a-side*, *Friday 15 January at 20:30*, Powerleague.",
        "",
        "Everyone who played last time is in again. Drop-out deadline: *Friday 15:30*. Until then, you're in unless you say *OUT*.",
        "",
        "*In (2/18):*",
        "1. Hamzah Khan",
        "2. Raihan Ahmed",
        "",
        "16 places open: say *IN* to take one.",
      ].join("\n"),
    );
    expect(instructions.some((i) => i.key === "e2e-rs-r-next:announce-match")).toBe(false);
  });
});

test.describe("OUT before and after the drop-out deadline", () => {
  let n = 0;
  const msgId = () => `e2e-rs-out-${Date.now()}-${++n}`;
  const OUT = "out sorry";
  const lateNotices = (db: TestDb) =>
    db.all<{ phone: string; text: string }>(
      `SELECT phone, text FROM "BotJob" WHERE kind = 'dm' AND text LIKE 'Late drop-out:%'`,
    );
  const statusOf = async (db: TestDb, userId: string) =>
    (
      await db.one<{ status: string }>(
        `SELECT status::text AS status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
        [MATCH.upcoming, userId],
      )
    )?.status;
  const setDeadline = (db: TestDb, at: Date) =>
    db.run(`UPDATE "Match" SET "attendanceDeadline" = $2 WHERE id = $1`, [MATCH.upcoming, at.toISOString()]);

  test.beforeEach(async ({ db }) => {
    resetDb();
    await db.run(`UPDATE "Organisation" SET "rollingSquadEnabled" = true WHERE id = $1`, [ORG_ID]);
    engineOn({ [OUT]: { route: "self_att", facts: selfOut() } });
  });

  test.afterAll(() => resetDb());

  test("before the deadline: an ordinary OUT, nobody is told", async ({ request, db }) => {
    await setDeadline(db, new Date(Date.now() + 2 * 60 * 60 * 1000));
    await postAnalyze(request, [{ waMessageId: msgId(), body: OUT, authorPhone: PHONE.player, authorName: NAME.player }]);
    expect(await statusOf(db, U.player)).toBe("DROPPED");
    expect(await lateNotices(db)).toEqual([]);
  });

  test("after the deadline: still recorded, and the owner gets one notice", async ({ request, db }) => {
    await setDeadline(db, new Date(Date.now() - 60 * 60 * 1000));
    await postAnalyze(request, [{ waMessageId: msgId(), body: OUT, authorPhone: PHONE.player, authorName: NAME.player }]);
    expect(await statusOf(db, U.player)).toBe("DROPPED");
    const notices = await lateNotices(db);
    expect(notices).toHaveLength(1);
    expect(notices[0].phone).toBe(PHONE.admin.replace(/^\+/, ""));
    expect(notices[0].text).toMatch(/^Late drop-out: \*Pat Player\* said OUT for \*.+\* \(.+\) at \d\d:\d\d, after the .+ deadline\. Squad is now 3\/5\.$/);
    const note = await db.one<{ note: string }>(
      `SELECT note FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 AND "toStatus" = 'DROPPED'`,
      [MATCH.upcoming, U.player],
    );
    expect(note?.note).toMatch(/^after the drop-out deadline \(/);
  });

  test("sent before the deadline, delivered after it: on time", async ({ request, db }) => {
    await setDeadline(db, new Date(Date.now() - 10 * 60 * 1000));
    await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: OUT,
        authorPhone: PHONE.player,
        authorName: NAME.player,
        timestamp: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      },
    ]);
    expect(await statusOf(db, U.player)).toBe("DROPPED");
    expect(await lateNotices(db)).toEqual([]);
  });

  test("a club without the setting: a late OUT tells nobody", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET "rollingSquadEnabled" = false WHERE id = $1`, [ORG_ID]);
    await setDeadline(db, new Date(Date.now() - 60 * 60 * 1000));
    await postAnalyze(request, [{ waMessageId: msgId(), body: OUT, authorPhone: PHONE.player, authorName: NAME.player }]);
    expect(await statusOf(db, U.player)).toBe("DROPPED");
    expect(await lateNotices(db)).toEqual([]);
  });
});
