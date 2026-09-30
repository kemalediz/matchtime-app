/**
 * WEEKLY DEADLINES, END TO END AGAINST POSTGRES (2026-09-30).
 *
 * Slice 3 of MDs/friday-group-features-plan-2026-09-30.md, driven through
 * the real /api/whatsapp/due-posts with the test clock (`x-test-now`). No
 * model is called anywhere in this file: every post is fixed text, and
 * Sutton's 17:00 post below takes the full-squad branch, which is static.
 *
 * A Friday 20:30 club with a Monday 21:00 drop-out deadline and a Tuesday
 * 20:00 list, next to a club with neither (Sutton's shape):
 *
 *   1. Mon 18:05: the reminder in the group, 3 hours before the deadline;
 *      the 17:00 post is off for the deadline club (D4), on for Sutton.
 *   2. Mon 21:05: the organisers' summary, once, through the admin notice
 *      (a BotJob DM to the owner), never in preview mode.
 *   3. Tue 20:05: the final list in the group.
 *   4. Sutton gets none of the three.
 *
 * January, so London is GMT and London times equal UTC.
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

/** Friday 15 January 2027, 20:30 GMT. */
const KICKOFF = new Date("2027-01-15T20:30:00.000Z");
const MON_1705 = new Date("2027-01-11T17:05:00.000Z");
const MON_1805 = new Date("2027-01-11T18:05:00.000Z");
const MON_2105 = new Date("2027-01-11T21:05:00.000Z");
const TUE_1955 = new Date("2027-01-12T19:55:00.000Z");
const TUE_2005 = new Date("2027-01-12T20:05:00.000Z");

const W_GROUP = "e2e-wd-weekly@g.us";
const S_GROUP = "e2e-wd-sutton@g.us";
const W_MATCH = "e2e-wd-w-match";
const S_MATCH = "e2e-wd-s-match";
const W_OWNER_PHONE = "+447700920001";

async function club(db: TestDb, key: string, group: string, deadlines: boolean): Promise<void> {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled",
                                 "dropOutDeadlineDay", "dropOutDeadlineTime", "listPublishDay", "listPublishTime",
                                 "updatedAt")
     VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, now())`,
    [
      `e2e-wd-org-${key}`,
      `Weekly ${key}`,
      `e2e-wd-${key}`,
      `e2e-wd-invite-${key}`,
      group,
      deadlines ? 1 : null,
      deadlines ? "21:00" : null,
      deadlines ? 2 : null,
      deadlines ? "20:00" : null,
    ],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ($1, $2, 'Football 9-a-side', 9, ARRAY['GK','DEF','MID','FWD'], ARRAY['Red','Yellow'], now())`,
    [`e2e-wd-sport-${key}`, `e2e-wd-org-${key}`],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ($1, $2, $3, 'Friday 9-a-side', 5, '20:30', 'Powerleague', 5, now())`,
    [`e2e-wd-act-${key}`, `e2e-wd-org-${key}`, `e2e-wd-sport-${key}`],
  );
}

async function member(db: TestDb, key: string, userId: string, name: string, phone: string, role = "PLAYER") {
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
    userId,
    `${userId}@e2e.test`,
    name,
    phone,
  ]);
  await db.run(
    `INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4::"MemberRole")`,
    [`e2e-wd-mem-${userId}`, userId, `e2e-wd-org-${key}`, role],
  );
}

async function attend(db: TestDb, key: string, matchId: string, userId: string, status: string, position: number) {
  await db.run(
    `WITH a AS (
       INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt")
       VALUES ($1, $2, $3, $4::"AttendanceStatus", $5, now())
       RETURNING "matchId", "userId", status, position
     )
     INSERT INTO "AttendanceEvent" (id, "matchId", "userId", "orgId", "toStatus", "toPosition", cause, "actorKind")
     SELECT $6, "matchId", "userId", $7, status, position, 'test-fixture', 'system' FROM a`,
    [`e2e-wd-att-${matchId}-${userId}`, matchId, userId, status, position, `e2e-wd-ev-${matchId}-${userId}`, `e2e-wd-org-${key}`],
  );
}

async function duePosts(request: APIRequestContext, group: string, now: Date, preview: boolean) {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(group)}`, {
    headers: {
      "x-api-key": E2E.WHATSAPP_API_KEY,
      "x-test-now": now.toISOString(),
      ...(preview ? { "x-no-claim": "1" } : {}),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { instructions: Array<{ key: string; kind: string; text?: string }> }).instructions;
}

const summaryJobs = (db: TestDb) =>
  db.all<{ orgId: string; phone: string; text: string }>(
    `SELECT "orgId", phone, text FROM "BotJob" WHERE kind = 'dm' AND text LIKE 'Drop-out deadline passed%'`,
  );

test.beforeAll(async () => {
  resetDb();
  const db = testDb();

  // W: the Friday group, with weekly deadlines.
  await club(db, "w", W_GROUP, true);
  await member(db, "w", "e2e-wd-hamzah", "Hamzah Khan", W_OWNER_PHONE, "OWNER");
  await member(db, "w", "e2e-wd-raihan", "Raihan Ahmed", "+447700920002");
  await member(db, "w", "e2e-wd-wasim", "Wasim Ali", "+447700920003");
  await member(db, "w", "e2e-wd-dan", "Dan Dropped", "+447700920004");
  await member(db, "w", "e2e-wd-ali", "Ali Demir", "+447700920005");
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
     VALUES ($1, 'e2e-wd-act-w', $2, 18, 'UPCOMING', $3, now())`,
    [W_MATCH, KICKOFF.toISOString(), new Date(KICKOFF.getTime() - 5 * 3600_000).toISOString()],
  );
  await attend(db, "w", W_MATCH, "e2e-wd-hamzah", "CONFIRMED", 1);
  await attend(db, "w", W_MATCH, "e2e-wd-raihan", "CONFIRMED", 2);
  await attend(db, "w", W_MATCH, "e2e-wd-wasim", "CONFIRMED", 3);
  await attend(db, "w", W_MATCH, "e2e-wd-dan", "DROPPED", 4);
  await attend(db, "w", W_MATCH, "e2e-wd-ali", "BENCH", 5);
  // Raihan said "maybe" and never came back: listed for the organisers.
  await db.run(
    `INSERT INTO "TentativeAvailability" (id, "matchId", "userId", "dueAt", "updatedAt")
     VALUES ('e2e-wd-tent-raihan', $1, 'e2e-wd-raihan', $2, now())`,
    [W_MATCH, KICKOFF.toISOString()],
  );

  // S: Sutton's shape, no deadlines. A FULL squad, so its 17:00 post is
  // the static full-squad branch and never asks the model.
  await club(db, "s", S_GROUP, false);
  await member(db, "s", "e2e-wd-sam", "Sam Sutton", "+447700920011", "OWNER");
  await member(db, "s", "e2e-wd-sid", "Sid Sutton", "+447700920012");
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
     VALUES ($1, 'e2e-wd-act-s', $2, 2, 'UPCOMING', $3, now())`,
    [S_MATCH, KICKOFF.toISOString(), new Date(KICKOFF.getTime() - 5 * 3600_000).toISOString()],
  );
  await attend(db, "s", S_MATCH, "e2e-wd-sam", "CONFIRMED", 1);
  await attend(db, "s", S_MATCH, "e2e-wd-sid", "CONFIRMED", 2);
});

test.afterAll(() => resetDb());

test("Mon 17:05: the 17:00 post is off for the deadline club (D4), and still on for Sutton", async ({ request }) => {
  const w = await duePosts(request, W_GROUP, MON_1705, true);
  expect(w.some((i) => i.key.startsWith(`${W_MATCH}:evening-update:`))).toBe(false);
  const s = await duePosts(request, S_GROUP, MON_1705, true);
  expect(s.some((i) => i.key === `${S_MATCH}:evening-update:2027-01-11`)).toBe(true);
});

test("Mon 18:05: the drop-out reminder, 3 hours before the deadline, with the squad", async ({ request }) => {
  const before = await duePosts(request, W_GROUP, new Date(MON_1805.getTime() - 10 * 60_000), true);
  expect(before.some((i) => i.key === `${W_MATCH}:dropout-reminder`)).toBe(false);

  const w = await duePosts(request, W_GROUP, MON_1805, true);
  const reminder = w.filter((i) => i.key === `${W_MATCH}:dropout-reminder`);
  expect(reminder).toHaveLength(1);
  expect(reminder[0].kind).toBe("group-message");
  expect(reminder[0].text).toBe(
    [
      "⏰ *Friday 9-a-side*, Fri 15 Jan at 20:30: the drop-out deadline is *today at 21:00*. If you can't play, say *OUT* before then.",
      "",
      "*Confirmed (3/18):*",
      "1. Hamzah Khan",
      "2. Raihan Ahmed",
      "3. Wasim Ali",
      "",
      "*Bench (1):*",
      "1. Ali Demir",
    ].join("\n"),
  );

  const s = await duePosts(request, S_GROUP, MON_1805, true);
  expect(s.some((i) => i.key.endsWith(":dropout-reminder"))).toBe(false);
});

test("Mon 21:05: the organisers get the summary once; preview never sends it; Sutton gets none", async ({
  request,
  db,
}) => {
  // Preview mode computes without side effects.
  await duePosts(request, W_GROUP, MON_2105, true);
  expect(await summaryJobs(db)).toEqual([]);

  const first = await duePosts(request, W_GROUP, MON_2105, false);
  const jobs = await summaryJobs(db);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ orgId: "e2e-wd-org-w", phone: W_OWNER_PHONE.replace(/^\+/, "") });
  expect(jobs[0].text).toBe(
    [
      "Drop-out deadline passed for *Friday 9-a-side* (Fri 15 Jan at 20:30). Squad 3/18.",
      "Out this week: Dan Dropped.",
      "Said maybe: Raihan Ahmed.",
      "Waiting list: Ali Demir.",
      "15 places open.",
    ].join("\n"),
  );
  // Queued before compute, so it goes out in the same poll.
  expect(first.some((i) => i.kind === "dm" && i.text === jobs[0].text)).toBe(true);
  expect(
    await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = $1`, [`${W_MATCH}:deadline-summary`]),
  ).toBe(1);

  // A later poll does not send it again.
  await duePosts(request, W_GROUP, new Date(MON_2105.getTime() + 10 * 60_000), false);
  expect(await summaryJobs(db)).toHaveLength(1);

  await duePosts(request, S_GROUP, MON_2105, false);
  expect((await summaryJobs(db)).filter((j) => j.orgId === "e2e-wd-org-s")).toEqual([]);
});

test("Tue 20:05: the final list in the group; not before; Sutton gets none", async ({ request }) => {
  const before = await duePosts(request, W_GROUP, TUE_1955, true);
  expect(before.some((i) => i.key === `${W_MATCH}:list-published`)).toBe(false);

  const w = await duePosts(request, W_GROUP, TUE_2005, true);
  const list = w.filter((i) => i.key === `${W_MATCH}:list-published`);
  expect(list).toHaveLength(1);
  expect(list[0].text).toBe(
    [
      "📋 *Friday 9-a-side* list, *Friday 15 January at 20:30*, Powerleague",
      "",
      "*Playing (3/18):*",
      "1. Hamzah Khan",
      "2. Raihan Ahmed",
      "3. Wasim Ali",
      "",
      "*Waiting list (1):*",
      "1. Ali Demir",
      "",
      "15 places still open.",
      "Can't make it now? Say *OUT* as soon as you can so a replacement can be brought in.",
    ].join("\n"),
  );

  const s = await duePosts(request, S_GROUP, TUE_2005, true);
  expect(s.some((i) => i.key.endsWith(":list-published"))).toBe(false);
});
