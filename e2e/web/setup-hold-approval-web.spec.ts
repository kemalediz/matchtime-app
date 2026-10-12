/**
 * GO-LIVE SLICE S3: approving on /admin/clubs with SETUP_HOLD_ENABLED on
 * (go-live plan 2.1, 2.3). The owner's Approve button goes through the
 * same writer as the WhatsApp reply (`decideClub`), so the club is held:
 * approved, setting up, silent. The page says so instead of promising a
 * hello, and the organiser's ONE setup DM is queued by the run that
 * follows the action (`after()`).
 *
 * The flag is turned on for this browser with the test-only cookie
 * (honoured only under MT_TEST_MODE=1). The dev server runs with
 * SETUP_LEARNING_ENABLED unset, so there is no chat reading to wait for
 * and the DM goes at once. Nothing here calls a model.
 *
 * With the flag off the same button is today's: web/admin-clubs.spec.ts,
 * untouched.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { E2E_BASE_URL, REPO_ROOT } from "../helpers/env";
import { testDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const ORG = "e2e-s3w-riverside";
const USER = "e2e-s3w-ali";
const PHONE = "447700900651";
const GROUP = "120363920000000001@g.us";

async function flags(context: BrowserContext) {
  await context.addCookies([
    { name: "mt-test-self-join", value: "1", url: E2E_BASE_URL },
    { name: "mt-test-setup-hold", value: "1", url: E2E_BASE_URL },
  ]);
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt")
     VALUES ($1,'Riverside FC',$1,$2,'pending','en',now(),now())`,
    [ORG, `${ORG}-invite`],
  );
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,'Ali Demir',$2,$3,true,true,now())`,
    [USER, `${USER}@e2e-test.invalid`, `+${PHONE}`],
  );
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER')`, [`${USER}-mem`, USER, ORG]);
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","dmAt","dmPhone","groupId","groupSubject","memberCount","addedByPhone","adderMatch",participants,"detectedLang","linkedAt","updatedAt")
     VALUES ($1,$2,$3,$4,'7KQ2','group_linked',now() - interval '2 hours',now() + interval '1 hour',now() - interval '2 minutes',$4,$5,'Riverside Tuesday 5s',2,$4,'phone',$6::jsonb,'en',now() - interval '90 minutes',now())`,
    [
      `${ORG}-cc`,
      ORG,
      USER,
      PHONE,
      GROUP,
      JSON.stringify([
        { phone: PHONE, pushname: "Ali" },
        { phone: "447700900652", pushname: "Ben" },
      ]),
    ],
  );
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
});

test.afterAll(async () => {
  resetDb();
});

test("Approve with the hold on: the club is held and silent, the page says so, one setup DM is queued", async ({ page, db, context }) => {
  await flags(context);
  await signInAs(page, U.admin, "/admin/clubs");
  await page.getByRole("button", { name: "Approve Riverside FC" }).click();
  await expect(
    page.getByText(
      "Approved Riverside FC. It stays silent in its group: its organiser is sent the setup message and goes live by replying GO. Any problem shows on the health page.",
    ),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("The hello goes out in the group")).toHaveCount(0);
  await expect(page.getByTestId("waiting-club")).toHaveCount(0);

  expect(
    await db.one(
      `SELECT "approvalStatus","setupStage","whatsappBotEnabled","whatsappGroupId","approvalDecidedBy","billingStatus" FROM "Organisation" WHERE id = $1`,
      [ORG],
    ),
  ).toEqual({
    approvalStatus: "approved",
    setupStage: "setting-up",
    whatsappBotEnabled: false,
    whatsappGroupId: GROUP,
    approvalDecidedBy: U.admin,
    // BILLING_ENABLED is on for the suite: the free period has not started.
    billingStatus: "exempt",
  });
  expect(await db.count(`SELECT COUNT(*) FROM "ClubBilling" WHERE "orgId" = $1`, [ORG])).toBe(0);
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1`, [ORG])).toBe(0);
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = $1`, [`org-${ORG}:bot-intro`])).toBe(0);
  expect(await db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE purpose = 'organiser-decision' AND phone = $1`, [PHONE])).toBe(0);
  // The roster is still imported.
  expect(await db.count(`SELECT COUNT(*) FROM "Membership" WHERE "orgId" = $1`, [ORG])).toBe(2);

  // The run that follows the action queues the organiser's one setup DM.
  const dms = () =>
    db.all<{ text: string; refId: string }>(`SELECT text, "refId" FROM "PlatformJob" WHERE purpose = 'setup-ask' AND phone = $1`, [PHONE]);
  await expect.poll(async () => (await dms()).length, { timeout: 30_000, intervals: [200, 500, 1000] }).toBe(1);
  const [dm] = await dms();
  expect(dm.refId).toBe(`${ORG}:setup-ask`);
  expect(dm.text).toMatch(
    /^Good news: Riverside FC is approved\. I'm in "Riverside Tuesday 5s" and I'm staying quiet there until you tell me to start\./,
  );
  expect(dm.text).toContain("reply *GO* here");
  expect(dm.text).toContain("Your first two months are free. The free period starts when I go live in the group.");
  expect(await db.one(`SELECT ("setupAskedAt" IS NOT NULL) AS asked FROM "Organisation" WHERE id = $1`, [ORG])).toEqual({ asked: true });
});

// PR #235 review fix 8: the website approval with the chat reading ON.
// The reading flag and the stub model reach the server action as test-only
// cookies (honoured only under MT_TEST_MODE=1); nothing calls a model.
test("Approve with the hold on and the reading ON: the chat is read after the action, and the one DM carries the findings", async ({ page, db, context }) => {
  const ORG2 = "e2e-s3w-harbour";
  const USER2 = "e2e-s3w-hana";
  const PHONE2 = "447700900653";
  const GROUP2 = "120363920000000002@g.us";
  const rolling = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "src/lib/setup-learning/__fixtures__/rolling.json"), "utf8"),
  ) as { history: unknown[] };
  const answer = {
    regular_game: true,
    squad: {
      answer: "rolling",
      confidence: "high",
      evidence: ["Same lot as last week, let me know if you can't do Tuesday", "Usual crew this week too, only message if you're dropping out"],
    },
    open_places: { answer: "unclear", confidence: "low", evidence: [] },
    drop_out_deadline: { day: "none", time: "none", confidence: "low", evidence: [] },
    list_published: { day: "none", time: "none", confidence: "low", evidence: [] },
    payments: { answer: "no_sign", confidence: "low", evidence: [] },
    monthly_list: { answer: "no_sign", prepay_for_month: false, pay_as_you_go_fill_ins: false, credit_for_missed_games: false, confidence: "low", evidence: [] },
    weekly_game: { day: "none", time: "none", venue: "", players_per_side: 0, confidence: "low", evidence: [] },
  };
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt")
     VALUES ($1,'Harbour FC',$1,$2,'pending','en',now(),now())`,
    [ORG2, `${ORG2}-invite`],
  );
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,'Hana Okafor',$2,$3,true,true,now())`,
    [USER2, `${USER2}@e2e-test.invalid`, `+${PHONE2}`],
  );
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER')`, [`${USER2}-mem`, USER2, ORG2]);
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","dmAt","dmPhone","groupId","groupSubject","memberCount","addedByPhone","adderMatch",participants,"detectedLang","linkedAt","capturedHistory","updatedAt")
     VALUES ($1,$2,$3,$4,'8HRB','group_linked',now() - interval '2 hours',now() + interval '1 hour',now() - interval '2 minutes',$4,$5,'Harbour Thursday 6s',1,$4,'phone',$6::jsonb,'en',now() - interval '90 minutes',$7::jsonb,now())`,
    [`${ORG2}-cc`, ORG2, USER2, PHONE2, GROUP2, JSON.stringify([{ phone: PHONE2, pushname: "Hana" }]), JSON.stringify(rolling.history)],
  );

  await flags(context);
  await context.addCookies([
    { name: "mt-test-setup-learning", value: "1", url: E2E_BASE_URL },
    { name: "mt-test-setup-learning-stub", value: Buffer.from(JSON.stringify(answer)).toString("base64url"), url: E2E_BASE_URL },
  ]);
  await signInAs(page, U.admin, "/admin/clubs");
  await page.getByRole("button", { name: "Approve Harbour FC" }).click();
  await expect(page.getByText(/^Approved Harbour FC\. It stays silent in its group/)).toBeVisible({ timeout: 30_000 });

  const dms = () =>
    db.all<{ text: string }>(`SELECT text FROM "PlatformJob" WHERE purpose = 'setup-ask' AND phone = $1`, [PHONE2]);
  await expect.poll(async () => (await dms()).length, { timeout: 30_000, intervals: [200, 500, 1000] }).toBe(1);
  const [dm] = await dms();
  expect(dm.text).toContain(`I read the recent messages in "Harbour Thursday 6s" to see how it runs, and set MatchTime up the same way.`);
  expect(dm.text).toContain("✅ *Rolling squad is on:*");
  expect(dm.text).toMatch(/Undo or change: http\S+/);
  expect(
    await db.one(`SELECT "setupStage","whatsappBotEnabled","rollingSquadEnabled" FROM "Organisation" WHERE id = $1`, [ORG2]),
  ).toEqual({ setupStage: "setting-up", whatsappBotEnabled: false, rollingSquadEnabled: true });
  expect(await db.one(`SELECT status FROM "ClubSetupLearning" WHERE "orgId" = $1`, [ORG2])).toEqual({ status: "applied" });
  // Never the separate findings DM, and no hello.
  expect(await db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE purpose = 'setup-learned' AND phone = $1`, [PHONE2])).toBe(0);
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1`, [ORG2])).toBe(0);
});
