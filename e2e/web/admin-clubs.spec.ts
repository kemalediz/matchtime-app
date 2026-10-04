/**
 * /admin/clubs: the owner's decisions on self-join clubs (slice 7).
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, section 6.4.
 *
 *   1. OWNER ONLY: a club admin gets a 404 and no link to it;
 *   2. the owner sees who is waiting (with the AI spend that must read
 *      $0.00), the live self-join clubs, unsolicited groups, rejected and
 *      turned-off clubs, and today's site limits;
 *   3. Approve, Reject, Turn off (with the club's name typed) and Leave
 *      work through the same writer as the WhatsApp reply;
 *   4. the seeded approved club (Sutton FC's shape) is not on the page.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { E2E_BASE_URL, REPO_ROOT } from "../helpers/env";
import { testDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const SHOTS = process.env.MT_SHOTS_DIR ?? path.join(REPO_ROOT, ".e2e", "test-results", "self-join-shots");

async function flag(context: BrowserContext, on: boolean) {
  await context.addCookies([{ name: "mt-test-self-join", value: on ? "1" : "0", url: E2E_BASE_URL }]);
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

const P = "e2e-sj7w";

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  const clubs = [
    [`${P}-riverside`, "Riverside FC", "pending", "en", null],
    [`${P}-kartallar`, "Kartallar", "pending", "tr", null],
    [`${P}-oldboys`, "Old Boys Weds", "approved", "en", "120363800000000009@g.us"],
    [`${P}-nope`, "Nope United", "rejected", "en", null],
  ] as const;
  for (const [id, name, status, lang, group] of clubs) {
    await db.run(
      `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"whatsappGroupId","whatsappBotEnabled","approvedAt","approvalDecidedAt","createdAt","updatedAt")
       VALUES ($1,$2,$1,$3,$4,$5,$6,$7,$8,$9,now(),now())`,
      [
        id,
        name,
        `${id}-invite`,
        status,
        lang,
        group,
        status === "approved",
        status === "approved" ? new Date(Date.now() - 3 * 86400_000) : null,
        status === "pending" ? null : new Date(Date.now() - 86400_000),
      ],
    );
  }
  for (const [user, name, phone] of [
    [`${P}-ali`, "Ali Demir", "447700900951"],
    [`${P}-ayse`, "Ayşe Yılmaz", "905321234551"],
  ] as const) {
    await db.run(
      `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,$2,$3,$4,true,true,now())`,
      [user, name, `${user}@e2e-test.invalid`, `+${phone}`],
    );
  }
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","dmAt","dmPhone","groupId","groupSubject","memberCount","addedByPhone","adderMatch",participants,"detectedLang","linkedAt","updatedAt") VALUES
      ($1,$2,$3,'447700900951','7KQ2','group_linked',now() - interval '2 hours',now() - interval '1 hour',now() - interval '2 minutes','447700900951','120363800000000001@g.us','Riverside Tuesday 5s',3,'447700900951','phone',$4::jsonb,'en',now() - interval '90 minutes',now()),
      ($5,$6,$7,'905321234551','9XT4','group_linked',now() - interval '1 hour',now(),now() - interval '1 minute','905321234551','120363800000000002@g.us','Cuma Halı Saha',2,'905321234551','phone',$8::jsonb,'tr',now() - interval '30 minutes',now())`,
    [
      `${P}-cc-en`,
      `${P}-riverside`,
      `${P}-ali`,
      JSON.stringify([
        { phone: "447700900951", pushname: "Ali" },
        { phone: "447700900952", pushname: "Ben" },
        { phone: "447700900953", pushname: "Cem" },
      ]),
      `${P}-cc-tr`,
      `${P}-kartallar`,
      `${P}-ayse`,
      JSON.stringify([
        { phone: "905321234551", pushname: "Ayşe" },
        { phone: "905321234552", pushname: "Emre" },
      ]),
    ],
  );
  await db.run(
    `INSERT INTO "UnsolicitedGroup" (id,"groupId",subject,"memberCount","addedByPhone","addedAt") VALUES ($1,'120363800000000005@g.us','Random lads',7,'447700900999',now() - interval '5 hours')`,
    [`${P}-ug`],
  );
});

test.beforeEach(async ({ db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
});

test.afterAll(async () => {
  resetDb();
});

test("a club admin cannot open /admin/clubs and is not shown a link to it", async ({ page }) => {
  await signInAs(page, U.admin, "/admin");
  await page.waitForURL("**/admin");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("link", { name: "Clubs", exact: true })).toHaveCount(0);

  const res = await page.goto("/admin/clubs");
  expect(res?.status()).toBe(404);
  await expect(page.getByText("Waiting for you")).toHaveCount(0);
  await expect(page.getByText("Riverside FC")).toHaveCount(0);
});

test("the owner sees every section; the seeded approved club is not on the page", async ({ page, db, context }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await flag(context, true);
  await signInAs(page, U.admin, "/admin/clubs");
  await page.waitForURL("**/admin/clubs");

  await expect(page.getByRole("heading", { name: "Waiting for you" })).toBeVisible({ timeout: 30_000 });
  const waiting = page.getByTestId("waiting-club");
  await expect(waiting).toHaveCount(2);
  // Oldest first.
  await expect(waiting.nth(0)).toContainText("Riverside FC");
  await expect(waiting.nth(0)).toContainText("ref 7KQ2");
  await expect(waiting.nth(0)).toContainText("Ali Demir, +44 7700 900951 (phone verified at sign-up)");
  await expect(waiting.nth(0)).toContainText("the organiser (matched by phone)");
  await expect(waiting.nth(0)).toContainText('"Riverside Tuesday 5s", 3 members, looks English (club chose English)');
  await expect(waiting.nth(1)).toContainText("club chose Türkçe");
  // Pending clubs must have spent nothing.
  await expect(page.getByTestId("pending-ai-spend").first()).toHaveText("$0.00");

  const live = page.getByTestId("live-club");
  await expect(live).toHaveCount(1);
  await expect(live).toContainText("Old Boys Weds");
  await expect(live).toContainText("First 28 days");
  await expect(live).toContainText("DMs today: 0 of 20.");
  await expect(page.getByTestId("unsolicited-group")).toContainText('"Random lads", 7 members');
  await expect(page.getByTestId("rejected-club")).toContainText("Nope United");
  await expect(page.getByTestId("site-limits")).toContainText("Groups connected: 2 of 5");

  // The seeded approved club (Sutton FC's shape) is nowhere on the page.
  await expect(page.getByTestId("clubs-page")).not.toContainText("E2E Test FC");
  const text = await page.getByTestId("clubs-page").innerText();
  expect(text).not.toMatch(/[—–]/);

  await expect(page.getByRole("link", { name: "Clubs", exact: true })).toBeVisible();
  await shot(page, "admin-clubs-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "admin-clubs-mobile");
});

test("Approve: the club goes live with its group, the hello is queued, the organiser is told", async ({ page, db, context }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await flag(context, true);
  await signInAs(page, U.admin, "/admin/clubs");
  await page.getByRole("button", { name: "Approve Riverside FC" }).click();
  await expect(page.getByText("Approved Riverside FC. The hello goes out in the group within a few minutes.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("waiting-club")).toHaveCount(1);
  await expect(page.getByTestId("live-club").filter({ hasText: "Riverside FC" })).toBeVisible();

  expect(
    await db.one(`SELECT "approvalStatus","whatsappBotEnabled","whatsappGroupId","approvalDecidedBy" FROM "Organisation" WHERE id = $1`, [
      `${P}-riverside`,
    ]),
  ).toEqual({
    approvalStatus: "approved",
    whatsappBotEnabled: true,
    whatsappGroupId: "120363800000000001@g.us",
    approvalDecidedBy: U.admin,
  });
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'`, [`${P}-riverside`])).toBe(1);
  expect(
    await db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE purpose = 'organiser-decision' AND phone = '447700900951'`),
  ).toBe(1);
  // A decision on the page does not DM the owner about itself.
  expect(await db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE purpose = 'owner-ack'`)).toBe(0);
  // Club fee billing (slice B2): the suite runs with BILLING_ENABLED on, so
  // the approval started the free month, and the page shows it.
  expect(await db.one(`SELECT "billingStatus" FROM "Organisation" WHERE id = $1`, [`${P}-riverside`])).toEqual({
    billingStatus: "trial",
  });
  expect(await db.count(`SELECT COUNT(*) FROM "ClubBilling" WHERE "orgId" = $1`, [`${P}-riverside`])).toBe(1);
  await expect(
    page.getByTestId("live-club").filter({ hasText: "Riverside FC" }).getByTestId("club-billing-summary"),
  ).toContainText("Standard, up to £9.99. Free month. Free month ends");
});

test("Reject: the club is rejected, MatchTime leaves the group", async ({ page, db, context }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await flag(context, true);
  await signInAs(page, U.admin, "/admin/clubs");
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("waiting-club").filter({ hasText: "Kartallar" }).getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("Rejected Kartallar. MatchTime is leaving the group.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("No club is waiting.")).toBeVisible();
  await expect(page.getByTestId("rejected-club").filter({ hasText: "Kartallar" })).toBeVisible();
  expect(
    await db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE kind = 'leave-group' AND "groupId" = '120363800000000002@g.us'`),
  ).toBe(1);
});

test("Turn off needs the club's name typed; then the club goes silent and MatchTime leaves", async ({ page, db, context }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await flag(context, true);
  await signInAs(page, U.admin, "/admin/clubs");
  const card = page.getByTestId("live-club").filter({ hasText: "Old Boys Weds" });
  await card.getByRole("button", { name: "Turn off" }).click();
  const confirm = card.getByRole("button", { name: "Turn off Old Boys Weds" });
  await expect(confirm).toBeDisabled();
  await card.getByLabel("Type the club's name to confirm").fill("Old Boys");
  await expect(confirm).toBeDisabled();
  await card.getByLabel("Type the club's name to confirm").fill("old boys weds");
  await shot(page, "admin-clubs-turn-off");
  await confirm.click();
  await expect(page.getByText("Turned off Old Boys Weds. MatchTime is leaving the group and stays silent.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("suspended-club").filter({ hasText: "Old Boys Weds" })).toBeVisible();
  expect(
    await db.one(`SELECT "approvalStatus","whatsappBotEnabled" FROM "Organisation" WHERE id = $1`, [`${P}-oldboys`]),
  ).toEqual({ approvalStatus: "suspended", whatsappBotEnabled: false });
  expect(
    await db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE kind = 'leave-group' AND "groupId" = '120363800000000009@g.us'`),
  ).toBe(1);
});

test("Leave an unsolicited group", async ({ page, db, context }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await flag(context, true);
  await signInAs(page, U.admin, "/admin/clubs");
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("unsolicited-group").getByRole("button", { name: "Leave" }).click();
  await expect(page.getByText("MatchTime is leaving the group.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("unsolicited-group")).toContainText("Leaving");
  expect(
    await db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE kind = 'leave-group' AND "groupId" = '120363800000000005@g.us'`),
  ).toBe(1);
});

test("with self-join off, nothing can be approved (the rest still works)", async ({ page, db, context }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await db.run(`UPDATE "Organisation" SET "approvalStatus" = 'pending' WHERE id = $1`, [`${P}-kartallar`]);
  await db.run(`UPDATE "ClubConnect" SET status = 'group_linked' WHERE id = $1`, [`${P}-cc-tr`]);
  await flag(context, false);
  await signInAs(page, U.admin, "/admin/clubs");
  await expect(page.getByText(/Self-join is switched off/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Approve Kartallar" })).toBeDisabled();
});
