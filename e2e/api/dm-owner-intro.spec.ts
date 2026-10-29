/**
 * /api/whatsapp/dm-reply: THE OWNER'S INTRO MESSAGES, END TO END (2026-10-29).
 *
 * The platform owner (SELF_JOIN_APPROVER_PHONES, E2E.APPROVER_PHONE here)
 * DMs MatchTime in his own words and gets each intro category back as two
 * DMs, English then Turkish, through the owner DM door (PlatformJob,
 * purpose owner-intro). The DM admin intent's model is stubbed through
 * `MT_TEST_DM_INTENT_STUB_FILE` (what the model said, nothing more): the
 * owner gate, the category rule and the queue are the shipped code.
 *
 * Anybody else asking the same words gets the normal handling, and not one
 * intro message is queued anywhere.
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { setDmIntentStub, clearDmIntentStub } from "../helpers/stub";
import type { APIRequestContext } from "@playwright/test";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const OWNER_ID = "e2e-intro-owner";
const CAT3 = "kategori 3 tanıtım mesajını gönder";
const ALL = "send me all the intro messages";

test.beforeAll(async () => {
  resetDb();
});

test.afterAll(() => {
  clearDmIntentStub();
});

let n = 0;
async function postDm(request: APIRequestContext, phone: string, body: string, waMessageId = `e2e-intro-${Date.now()}-${++n}`) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body, waMessageId, authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const introJobs = (db: TestDb) =>
  db.all<{ phone: string; text: string; refId: string; sendAfter: Date | null }>(
    `SELECT phone, text, "refId", "sendAfter" FROM "PlatformJob" WHERE purpose = 'owner-intro' ORDER BY "createdAt" ASC, "refId" ASC`,
  );

test("setup: the owner is a member (a player, not an admin) of the club", async ({ db }) => {
  await db.run(
    `INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, 'e2e-intro-owner@e2e.test', 'Kemal Owner', $2, now())
     ON CONFLICT (id) DO NOTHING`,
    [OWNER_ID, `+${E2E.APPROVER_PHONE}`],
  );
  await db.run(
    `INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ('e2e-intro-owner-m', $1, $2, 'PLAYER') ON CONFLICT (id) DO NOTHING`,
    [OWNER_ID, ORG_ID],
  );
});

test("the owner asks for category 3: its English then its Turkish message, to him only, at once", async ({ request, db }) => {
  setDmIntentStub({ bodies: { [CAT3]: "intro_messages:3" } });
  const json = await postDm(request, `+${E2E.APPROVER_PHONE}`, CAT3, "e2e-intro-cat3");
  expect(json).toMatchObject({ handled: "owner-intro-dm", categories: [3] });
  const jobs = await introJobs(db);
  expect(jobs).toHaveLength(2);
  expect(jobs.every((j) => j.phone === E2E.APPROVER_PHONE)).toBe(true);
  expect(jobs.every((j) => j.sendAfter === null)).toBe(true);
  expect(jobs[0].text).toMatch(/^Hi all 👋 Some new MatchTime features/);
  expect(jobs[0].text).toContain("*Play elsewhere too*");
  expect(jobs[1].text).toMatch(/^Herkese selam 👋 Bugünden itibaren/);
  expect(jobs[1].text).toContain("*Başka yerlerde de oyna*");
});

test("the same DM forwarded twice is answered once", async ({ request, db }) => {
  await postDm(request, `+${E2E.APPROVER_PHONE}`, CAT3, "e2e-intro-cat3");
  expect(await introJobs(db)).toHaveLength(2);
});

test("all of them: six bubbles, 1 EN, 1 TR, 2 EN, 2 TR, 3 EN, 3 TR, with the app's own links", async ({ request, db }) => {
  setDmIntentStub({ bodies: { [ALL]: "intro_messages" } });
  const json = await postDm(request, `+${E2E.APPROVER_PHONE}`, ALL, "e2e-intro-all");
  expect(json).toMatchObject({ handled: "owner-intro-dm", categories: [1, 2, 3] });
  const jobs = (await introJobs(db)).filter((j) => j.refId.startsWith("intro:e2e-intro-all:"));
  expect(jobs.map((j) => j.refId)).toEqual([
    "intro:e2e-intro-all:1:en",
    "intro:e2e-intro-all:1:tr",
    "intro:e2e-intro-all:2:en",
    "intro:e2e-intro-all:2:tr",
    "intro:e2e-intro-all:3:en",
    "intro:e2e-intro-all:3:tr",
  ]);
  expect(jobs[0].text).toMatch(/^Hi lads 👋/);
  expect(jobs[1].text).toMatch(/^Selam arkadaşlar 👋/);
  expect(jobs[2].text).toMatch(/Sign up here: https?:\/\/\S+\/play$/);
  expect(jobs[3].text).toMatch(/Buradan kaydolun: https?:\/\/\S+\/play$/);
});

test("a club admin asking the same words gets the normal handling, and no intro goes anywhere", async ({ request, db }) => {
  setDmIntentStub({ bodies: { [CAT3]: "intro_messages:3", [ALL]: "intro_messages" } });
  const before = (await introJobs(db)).length;
  for (const body of [CAT3, ALL]) {
    const json = await postDm(request, PHONE.admin, body);
    expect(json.handled).not.toBe("owner-intro-dm");
  }
  expect(await introJobs(db)).toHaveLength(before);
  const leaked = await db.all(`SELECT id FROM "BotJob" WHERE text LIKE '%Some new MatchTime features%' OR text LIKE '%I run another football group%'`);
  expect(leaked).toEqual([]);
});

test("the owner's DM the model calls `other` sends nothing", async ({ request, db }) => {
  setDmIntentStub({});
  const before = (await introJobs(db)).length;
  const json = await postDm(request, `+${E2E.APPROVER_PHONE}`, "I shared the intro in my work group");
  expect(json.handled).not.toBe("owner-intro-dm");
  expect(await introJobs(db)).toHaveLength(before);
});
