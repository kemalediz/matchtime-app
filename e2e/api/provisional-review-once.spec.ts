/**
 * "NEW PLAYERS TO REVIEW" IS SAID ONCE PER PLAYER, END TO END AGAINST
 * POSTGRES (2026-10-15).
 *
 * A club rehearsal posted "✨ New players to review: 2 people were added
 * automatically" in the admin group at 09:00 every day for two weeks about
 * the same two players, pasted in by an organiser and never reviewed. The
 * key was `org-<id>:provisional-review:admin-group:<yyyy-MM-dd>`, so each
 * new day was a new key. Driven through the real /api/whatsapp/due-posts
 * with the test clock; the claim writes SentNotification as on the Pi.
 *
 *   1. Day 1, 09:05: one notice naming both players.
 *   2. Day 2 and day 3, 09:05: nothing.
 *   3. A third player appears: one notice naming only them, with how many
 *      are still waiting; then nothing again.
 *   4. A club told under the old day key: no extra post after the change.
 *
 * January, so London is GMT and London times equal UTC.
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const A_GROUP = "e2e-pr-a@g.us";
const A_HQ = "e2e-pr-a-hq@g.us";
const L_GROUP = "e2e-pr-l@g.us";
const L_HQ = "e2e-pr-l-hq@g.us";

const ADDED = new Date("2027-01-10T20:00:00.000Z");
const DAY1 = new Date("2027-01-11T09:05:00.000Z");
const DAY2 = new Date("2027-01-12T09:05:00.000Z");
const DAY3 = new Date("2027-01-13T09:05:00.000Z");
const DAY3_LATER = new Date("2027-01-13T09:20:00.000Z");
const DAY4 = new Date("2027-01-14T09:05:00.000Z");

async function club(db: TestDb, key: string, group: string, hq: string): Promise<void> {
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled",
                                 "adminChannelMode", "adminGroupId", "approvedAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, true, 'admin-group', $6, now(), now())`,
    [`e2e-pr-org-${key}`, `Club ${key}`, `e2e-pr-${key}`, `e2e-pr-invite-${key}`, group, hq],
  );
}

async function member(db: TestDb, key: string, userId: string, name: string, phone: string | null, provisionalAt: Date | null, role = "PLAYER") {
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
    userId,
    provisionalAt ? `provisional+${userId}@matchtime.local` : `${userId}@e2e.test`,
    name,
    phone,
  ]);
  await db.run(
    `INSERT INTO "Membership" (id, "userId", "orgId", role, "provisionallyAddedAt") VALUES ($1, $2, $3, $4::"MemberRole", $5)`,
    [`e2e-pr-mem-${userId}`, userId, `e2e-pr-org-${key}`, role, provisionalAt?.toISOString() ?? null],
  );
}

type Instr = { key: string; kind: string; text?: string; groupId?: string };

async function reviewNotices(request: APIRequestContext, group: string, now: Date): Promise<Instr[]> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(group)}`, {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY, "x-test-now": now.toISOString(), "x-mt-pi-caps": "admin-group" },
  });
  expect(res.status(), await res.text()).toBe(200);
  const out = ((await res.json()) as { instructions: Instr[] }).instructions;
  return out.filter((i) => i.key.includes(":provisional-review:"));
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await club(db, "a", A_GROUP, A_HQ);
  await member(db, "a", "e2e-pr-owner", "Owner A", "+447700940001", null, "OWNER");
  await member(db, "a", "e2e-pr-raihan", "Raihan Ahmed", null, ADDED);
  await member(db, "a", "e2e-pr-wasim", "Wasim Ali", null, new Date(ADDED.getTime() + 1000));

  await club(db, "l", L_GROUP, L_HQ);
  await member(db, "l", "e2e-pr-lowner", "Owner L", "+447700940011", null, "OWNER");
  await member(db, "l", "e2e-pr-lpaul", "Paul Pending", null, ADDED);
});

test.afterAll(() => resetDb());

test("day 1: one notice in the admin group naming both players", async ({ request }) => {
  const out = await reviewNotices(request, A_GROUP, DAY1);
  expect(out).toHaveLength(1);
  expect(out[0].kind).toBe("admin-group-message");
  expect(out[0].groupId).toBe(A_HQ);
  expect(out[0].text).toContain("2 people were added automatically.");
  expect(out[0].text).toContain("Raihan Ahmed");
  expect(out[0].text).toContain("Wasim Ali");
});

test("days 2 and 3: the same two players are not posted about again", async ({ request }) => {
  expect(await reviewNotices(request, A_GROUP, DAY2)).toEqual([]);
  expect(await reviewNotices(request, A_GROUP, DAY3)).toEqual([]);
});

test("a new player appears: one notice naming only them, then nothing", async ({ request, db }) => {
  await member(db, "a", "e2e-pr-zaid", "Zaid Noor", null, new Date("2027-01-13T09:10:00.000Z"));
  const out = await reviewNotices(request, A_GROUP, DAY3_LATER);
  expect(out).toHaveLength(1);
  expect(out[0].text).toContain("1 person was added automatically.");
  expect(out[0].text).toContain("Zaid Noor");
  expect(out[0].text).not.toContain("Raihan Ahmed");
  expect(out[0].text).not.toContain("Wasim Ali");
  expect(out[0].text).toContain("Still waiting from earlier: 2");
  expect(await reviewNotices(request, A_GROUP, DAY4)).toEqual([]);
});

test("a club already told under the old day key gets no extra post", async ({ request, db }) => {
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "createdAt") VALUES ($1, $2, 'admin-group-message', $3)`,
    ["e2e-pr-legacy", "org-e2e-pr-org-l:provisional-review:admin-group:2027-01-10", "2027-01-10T21:00:00.000Z"],
  );
  expect(await reviewNotices(request, L_GROUP, DAY1)).toEqual([]);
});
