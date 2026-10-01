/**
 * THE UNPAID FOLLOW-UPS, END TO END AGAINST POSTGRES (2026-10-01).
 *
 * Driven through the real /api/whatsapp/due-posts with the test clock
 * (`x-test-now`). No model is called anywhere in this file: both messages
 * are fixed text.
 *
 * A Friday 20:30 club with weekly deadlines and its admin channel on
 * "one-person" (the default for a new club), next to Sutton's shape (no
 * deadlines, "each-admin"), each with a COMPLETED match, payment tracking
 * on, the holder unpaid (left out), one player paid and two not:
 *
 *   1. Sun 09:55: nothing yet.
 *   2. Sun 10:05: the weekly club's group gets the unpaid tail on its own
 *      (`<matchId>:unpaid-group`), and its owner the named list (U1,
 *      `<matchId>:unpaid-list`, a BotJob DM through the admin channel).
 *   3. A later poll sends neither again.
 *   4. Sutton's shape gets neither.
 *
 * January, so London is GMT and London times equal UTC.
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import { buildUnpaidTailText } from "@/lib/scheduler-copy";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

/** Friday 15 January 2027, 20:30 GMT, played. */
const KICKOFF = new Date("2027-01-15T20:30:00.000Z");
const PAID_AT = new Date("2027-01-15T22:00:00.000Z");
const SUN_0955 = new Date("2027-01-17T09:55:00.000Z");
const SUN_1005 = new Date("2027-01-17T10:05:00.000Z");
const SUN_1015 = new Date("2027-01-17T10:15:00.000Z");

const W_GROUP = "e2e-unp-weekly@g.us";
const S_GROUP = "e2e-unp-sutton@g.us";
const W_MATCH = "e2e-unp-w-match";
const S_MATCH = "e2e-unp-s-match";
const W_OWNER_PHONE = "+447700930001";

async function club(db: TestDb, key: string, group: string, weekly: boolean): Promise<void> {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled",
                                 "dropOutDeadlineDay", "dropOutDeadlineTime", "listPublishDay", "listPublishTime",
                                 "adminChannelMode", "paymentTrackingEnabled", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, $10, true, now())`,
    [
      `e2e-unp-org-${key}`,
      `Unpaid ${key}`,
      `e2e-unp-${key}`,
      `e2e-unp-invite-${key}`,
      group,
      weekly ? 1 : null,
      weekly ? "21:00" : null,
      weekly ? 2 : null,
      weekly ? "20:00" : null,
      weekly ? "one-person" : "each-admin",
    ],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ($1, $2, 'Football 9-a-side', 9, ARRAY['GK','DEF','MID','FWD'], ARRAY['Red','Yellow'], now())`,
    [`e2e-unp-sport-${key}`, `e2e-unp-org-${key}`],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ($1, $2, $3, 'Friday 9-a-side', 5, '20:30', 'Powerleague', 5, now())`,
    [`e2e-unp-act-${key}`, `e2e-unp-org-${key}`, `e2e-unp-sport-${key}`],
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
    [`e2e-unp-mem-${userId}`, userId, `e2e-unp-org-${key}`, role],
  );
}

async function played(db: TestDb, matchId: string, userId: string, position: number, paid: boolean) {
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "paidAt", "updatedAt")
     VALUES ($1, $2, $3, 'CONFIRMED', $4, $5, now())`,
    [`e2e-unp-att-${matchId}-${userId}`, matchId, userId, position, paid ? PAID_AT.toISOString() : null],
  );
}

/** A completed match: the holder (unpaid, left out), one paid, two unpaid. */
async function completedMatch(db: TestDb, key: string, matchId: string, ids: string[]): Promise<void> {
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
     VALUES ($1, $2, $3, 18, 'COMPLETED', $4, now())`,
    [matchId, `e2e-unp-act-${key}`, KICKOFF.toISOString(), new Date(KICKOFF.getTime() - 5 * 3600_000).toISOString()],
  );
  await db.run(`UPDATE "Organisation" SET "paymentHolderId" = $1 WHERE id = $2`, [ids[0], `e2e-unp-org-${key}`]);
  await played(db, matchId, ids[0], 1, false);
  await played(db, matchId, ids[1], 2, true);
  await played(db, matchId, ids[2], 3, false);
  await played(db, matchId, ids[3], 4, false);
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

const unpaidListJobs = (db: TestDb) =>
  db.all<{ orgId: string; phone: string; text: string }>(
    `SELECT "orgId", phone, text FROM "BotJob" WHERE kind = 'dm' AND text LIKE '💷 Unpaid for%'`,
  );

test.beforeAll(async () => {
  resetDb();
  const db = testDb();

  await club(db, "w", W_GROUP, true);
  await member(db, "w", "e2e-unp-hamzah", "Hamzah Khan", W_OWNER_PHONE, "OWNER");
  await member(db, "w", "e2e-unp-raihan", "Raihan Ahmed", "+447700930002");
  await member(db, "w", "e2e-unp-wasim", "Wasim Ali", "+447700930003");
  await member(db, "w", "e2e-unp-ali", "Ali Demir", "+447700930004");
  await completedMatch(db, "w", W_MATCH, ["e2e-unp-hamzah", "e2e-unp-raihan", "e2e-unp-wasim", "e2e-unp-ali"]);

  await club(db, "s", S_GROUP, false);
  await member(db, "s", "e2e-unp-sam", "Sam Sutton", "+447700930011", "OWNER");
  await member(db, "s", "e2e-unp-sid", "Sid Sutton", "+447700930012");
  await member(db, "s", "e2e-unp-sue", "Sue Sutton", "+447700930013");
  await member(db, "s", "e2e-unp-stu", "Stu Sutton", "+447700930014");
  await completedMatch(db, "s", S_MATCH, ["e2e-unp-sam", "e2e-unp-sid", "e2e-unp-sue", "e2e-unp-stu"]);
});

test.afterAll(() => resetDb());

test("Sun 09:55: neither follow-up yet", async ({ request, db }) => {
  const w = await duePosts(request, W_GROUP, SUN_0955, false);
  expect(w.some((i) => i.key.endsWith(":unpaid-group"))).toBe(false);
  expect(await unpaidListJobs(db)).toEqual([]);
});

test("Sun 10:05: the weekly club gets the group reminder and its owner the unpaid list, once", async ({
  request,
  db,
}) => {
  // Preview computes the group reminder but never queues the admin list.
  const preview = await duePosts(request, W_GROUP, SUN_1005, true);
  expect(preview.filter((i) => i.key === `${W_MATCH}:unpaid-group`)).toHaveLength(1);
  expect(await unpaidListJobs(db)).toEqual([]);

  const w = await duePosts(request, W_GROUP, SUN_1005, false);
  const reminder = w.filter((i) => i.key === `${W_MATCH}:unpaid-group`);
  expect(reminder).toHaveLength(1);
  expect(reminder[0].kind).toBe("group-message");
  expect(reminder[0].text).toBe(buildUnpaidTailText(2, "en"));

  const jobs = await unpaidListJobs(db);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ orgId: "e2e-unp-org-w", phone: W_OWNER_PHONE.replace(/^\+/, "") });
  expect(jobs[0].text).toBe("💷 Unpaid for *Friday 9-a-side* (Fri 15 Jan at 20:30): Wasim Ali, Ali Demir. 1 of 3 paid.");
  // Queued before compute, so it goes out in the same poll.
  expect(w.some((i) => i.kind === "dm" && i.text === jobs[0].text)).toBe(true);
  expect(
    await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = $1`, [`${W_MATCH}:unpaid-list`]),
  ).toBe(1);

  // A later poll sends neither again.
  const later = await duePosts(request, W_GROUP, SUN_1015, false);
  expect(later.some((i) => i.key === `${W_MATCH}:unpaid-group`)).toBe(false);
  expect(later.some((i) => i.kind === "dm" && i.text?.startsWith("💷 Unpaid for"))).toBe(false);
  expect(await unpaidListJobs(db)).toHaveLength(1);
});

test("Sutton's shape (no weekly deadlines, each-admin) gets neither", async ({ request, db }) => {
  const s = await duePosts(request, S_GROUP, SUN_1005, false);
  expect(s.some((i) => i.key.endsWith(":unpaid-group"))).toBe(false);
  expect(s.some((i) => i.key.endsWith(":unpaid-list"))).toBe(false);
  expect((await unpaidListJobs(db)).filter((j) => j.orgId === "e2e-unp-org-s")).toEqual([]);
  expect(
    await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = $1`, [`${S_MATCH}:unpaid-list`]),
  ).toBe(0);
});
