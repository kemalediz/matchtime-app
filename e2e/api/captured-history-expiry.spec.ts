/**
 * CAPTURED GROUP CHAT EXPIRES (2026-10-08): real Postgres, the real
 * /api/cron/learn-setup route. Nothing here calls a model (the one sweep
 * that reads a club is handed a stub, and that club has no chat left).
 *
 * The chat WhatsApp shares when MatchTime joins a group is kept on the
 * connect request only until the club is decided and read once. A club
 * nobody decides used to keep it for ever. Now it is deleted 7 days after
 * the group was linked, by the same 15-minute cron, whether or not
 * SETUP_LEARNING_ENABLED is on. A club approved inside the learned-setup
 * window keeps its chat until that window closes, so expiry never takes
 * chat a sweep may still read. The legacy in-group setup's copy
 * (OnboardingSession.capturedHistory) follows the same rule, and goes at
 * once when its session is completed or abandoned.
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { testDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const CRON = { authorization: `Bearer ${E2E.CRON_SECRET}` };
const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY, "x-mt-test-self-join": "1" };
const NOW = "2026-10-20T11:00:00Z";
const daysAgo = (d: number) => new Date(new Date(NOW).getTime() - d * 24 * 60 * 60 * 1000).toISOString();

const CHAT = [
  { author: "Steve Hart", authorPhone: "447700900971", text: "Same lot as last week?", timestamp: "2026-10-01T18:00:00Z" },
  { author: "Dev Patel", authorPhone: "447700900972", text: "I'm in", timestamp: "2026-10-01T18:05:00Z" },
];

type Club = { id: string; status: "pending" | "approved"; linkedDaysAgo: number; approvedDaysAgo?: number; n: number };
const WAITING_OLD: Club = { id: "e2e-exp-waiting-old", status: "pending", linkedDaysAgo: 8, n: 1 };
const WAITING_NEW: Club = { id: "e2e-exp-waiting-new", status: "pending", linkedDaysAgo: 6, n: 2 };
const APPROVED_IN_WINDOW: Club = { id: "e2e-exp-approved-new", status: "approved", linkedDaysAgo: 9, approvedDaysAgo: 1, n: 3 };
const APPROVED_LONG_AGO: Club = { id: "e2e-exp-approved-old", status: "approved", linkedDaysAgo: 9, approvedDaysAgo: 4, n: 4 };
const NO_CHAT: Club = { id: "e2e-exp-no-chat", status: "pending", linkedDaysAgo: 30, n: 5 };

async function seedClub(c: Club, chat: unknown[] | null = CHAT) {
  const db = testDb();
  const owner = `${c.id}-owner`;
  const phone = `44770090097${c.n}`;
  const approved = c.status === "approved";
  await db.run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1,'Steve Hart',$2,$3,true,true,now())`,
    [owner, `${owner}@e2e-test.invalid`, `+${phone}`],
  );
  await db.run(
    `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","approvedAt","whatsappGroupId",
       "whatsappBotEnabled","language","createdAt","updatedAt")
     VALUES ($1,'Tuesday Night 6s',$1,$2,$3,$4,$5,$6,'en',now(),now())`,
    [c.id, `${c.id}-invite`, c.status, approved ? daysAgo(c.approvedDaysAgo!) : null, approved ? `${c.id}@g.us` : null, approved],
  );
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1,$2,$3,'OWNER')`, [`${owner}-mem`, owner, c.id]);
  await db.run(
    `INSERT INTO "ClubConnect" ("id","orgId","userId","phone","code","status","expiresAt","groupId","groupSubject","linkedAt",
       "capturedHistory","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Tuesday Night 6s',$7,$9::jsonb,now())`,
    [
      `${c.id}-cc`,
      c.id,
      owner,
      phone,
      `7KQ${c.n}`,
      approved ? "closed" : "group_linked",
      daysAgo(c.linkedDaysAgo),
      `${c.id}@g.us`,
      chat ? JSON.stringify(chat) : null,
    ],
  );
}

async function seedSession(id: string, stage: string, createdDaysAgo: number) {
  await testDb().run(
    `INSERT INTO "OnboardingSession" ("id","whatsappGroupId","stage","source","capturedHistory","createdAt","updatedAt")
     VALUES ($1,$2,$3,'group-add',$4::jsonb,$5,now())`,
    [id, `${id}@g.us`, stage, JSON.stringify(CHAT), daysAgo(createdDaysAgo)],
  );
}

const clubChat = async (c: Club) =>
  (await testDb().one<{ h: unknown }>(`SELECT "capturedHistory" AS h FROM "ClubConnect" WHERE "orgId" = $1`, [c.id]))!.h;
const sessionChat = async (id: string) =>
  (await testDb().one<{ h: unknown }>(`SELECT "capturedHistory" AS h FROM "OnboardingSession" WHERE id = $1`, [id]))!.h;

type Report = {
  enabled: boolean;
  considered: number;
  outcomes: Array<{ orgId: string; outcome: { kind: string; reason?: string } }>;
  expired: { connectRequests: number; onboardingSessions: number };
};

async function cron(request: APIRequestContext, flag: "1" | "0", now: string = NOW): Promise<Report> {
  const res = await request.get("/api/cron/learn-setup", {
    headers: { ...CRON, "x-test-now": now, "x-mt-test-setup-learning": flag, "x-mt-test-setup-learning-stub": "{}" },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

test.beforeAll(async () => {
  resetDb();
  for (const c of [WAITING_OLD, WAITING_NEW, APPROVED_IN_WINDOW, APPROVED_LONG_AGO]) await seedClub(c);
  await seedClub(NO_CHAT, null);
  await seedSession("e2e-exp-s-old", "introduced", 8);
  await seedSession("e2e-exp-s-new", "introduced", 2);
  await seedSession("e2e-exp-s-completed", "completed", 1);
  await seedSession("e2e-exp-s-abandoned", "abandoned", 1);
});

test("with learned setup switched OFF, the cron still deletes chat that is past 7 days", async ({ request }) => {
  const r = await cron(request, "0");
  expect(r).toEqual({ enabled: false, considered: 0, outcomes: [], expired: { connectRequests: 2, onboardingSessions: 3 } });

  // Waiting for approval, linked 8 days ago: gone. Linked 6 days ago: kept.
  expect(await clubChat(WAITING_OLD)).toBeNull();
  expect(await clubChat(WAITING_NEW)).toEqual(CHAT);
  // Approved yesterday: a learned-setup sweep may still read it, so it stays
  // however old the link is. Approved 4 days ago: no sweep will ever read it.
  expect(await clubChat(APPROVED_IN_WINDOW)).toEqual(CHAT);
  expect(await clubChat(APPROVED_LONG_AGO)).toBeNull();

  // The legacy in-group setup's copy.
  expect(await sessionChat("e2e-exp-s-old")).toBeNull();
  expect(await sessionChat("e2e-exp-s-new")).toEqual(CHAT);
  expect(await sessionChat("e2e-exp-s-completed")).toBeNull();
  expect(await sessionChat("e2e-exp-s-abandoned")).toBeNull();
});

test("only the chat is deleted: the connect request and the session are otherwise untouched", async () => {
  // The time is compared in SQL: the column has no zone, and reading it
  // into a JS Date would apply this machine's.
  const cc = await testDb().one<{ status: string; groupId: string; sameLinkedAt: boolean }>(
    `SELECT status, "groupId", "linkedAt" = $2::timestamp AS "sameLinkedAt" FROM "ClubConnect" WHERE "orgId" = $1`,
    [WAITING_OLD.id, daysAgo(8)],
  );
  expect(cc).toEqual({ status: "group_linked", groupId: `${WAITING_OLD.id}@g.us`, sameLinkedAt: true });
  const s = await testDb().one<{ stage: string }>(`SELECT stage FROM "OnboardingSession" WHERE id = 'e2e-exp-s-old'`);
  expect(s!.stage).toBe("introduced");
});

test("a second run deletes nothing more", async ({ request }) => {
  const r = await cron(request, "0");
  expect(r.expired).toEqual({ connectRequests: 0, onboardingSessions: 0 });
  expect(await clubChat(WAITING_NEW)).toEqual(CHAT);
  expect(await clubChat(APPROVED_IN_WINDOW)).toEqual(CHAT);
});

test("the day after, the 6-day-old chat has reached 7 days and goes", async ({ request }) => {
  const tomorrow = new Date(new Date(NOW).getTime() + 25 * 60 * 60 * 1000).toISOString();
  const r = await cron(request, "0", tomorrow);
  expect(r.expired.connectRequests).toBe(1);
  expect(await clubChat(WAITING_NEW)).toBeNull();
  expect(await clubChat(APPROVED_IN_WINDOW)).toEqual(CHAT);
});

test("a club approved on day 8 is approved as usual; learned setup finds no chat and does nothing", async ({ request }) => {
  const db = testDb();
  // The owner approves the club whose chat expired yesterday.
  await db.run(
    `UPDATE "Organisation" SET "approvalStatus"='approved', "approvedAt"=$2, "whatsappGroupId"=$3, "whatsappBotEnabled"=true WHERE id=$1`,
    [WAITING_OLD.id, NOW, `${WAITING_OLD.id}@g.us`],
  );
  await db.run(`UPDATE "ClubConnect" SET status='closed' WHERE "orgId"=$1`, [WAITING_OLD.id]);
  // Keep the still-in-window club out of this sweep: it is not what is being shown.
  await db.run(`UPDATE "Organisation" SET "approvedAt"=NULL WHERE id=$1`, [APPROVED_IN_WINDOW.id]);

  const r = await cron(request, "1");
  expect(r.outcomes).toEqual([{ orgId: WAITING_OLD.id, outcome: { kind: "skipped", reason: "no-history" } }]);
  const learning = await db.one<{ status: string; reason: string; messageCount: number }>(
    `SELECT status, reason, "messageCount" FROM "ClubSetupLearning" WHERE "orgId" = $1`,
    [WAITING_OLD.id],
  );
  expect(learning).toEqual({ status: "skipped", reason: "no-history", messageCount: 0 });
  expect(await db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE purpose = 'setup-learned'`)).toBe(0);
});

test("a re-add of a group linked more than 7 days ago does not store chat again", async ({ request }) => {
  const db = testDb();
  expect(await clubChat(NO_CHAT)).toBeNull();
  const res = await request.post("/api/whatsapp/bot-added", {
    headers: KEY,
    data: { groupId: `${NO_CHAT.id}@g.us`, groupSubject: "Tuesday Night 6s", participants: [], enrichmentHistory: CHAT },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect((await res.json()).selfJoin).toBe("already-linked");
  expect(await clubChat(NO_CHAT)).toBeNull();

  // A link that is still fresh takes the late chat, as before.
  await db.run(`UPDATE "ClubConnect" SET "linkedAt" = now() - interval '1 day' WHERE "orgId" = $1`, [NO_CHAT.id]);
  await request.post("/api/whatsapp/bot-added", {
    headers: KEY,
    data: { groupId: `${NO_CHAT.id}@g.us`, groupSubject: "Tuesday Night 6s", participants: [], enrichmentHistory: CHAT },
  });
  expect(await clubChat(NO_CHAT)).toEqual(CHAT);
});
