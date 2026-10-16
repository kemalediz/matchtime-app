/**
 * Partner clubs (cross-club ask, slice S1, 2026-10-16).
 * Plan: MDs/cross-club-player-ask-plan-2026-10-16.md, sections 3.1 and 3.2.
 *
 *   - a club with no partner clubs sees no section (every club today);
 *   - the platform owner pairs two clubs on /admin/clubs;
 *   - the club's OWNER accepts on /admin/settings, then the asking
 *     settings and their ⓘ appear and save, in English and in Turkish;
 *   - a PLAYER of the club cannot reach the section's data at all.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const PARTNER = "e2e-pc-sutton";

const row = async (db: TestDb) =>
  db.one<{ status: string; askerAcceptedAt: Date | null; partnerAcceptedAt: Date | null }>(
    `SELECT status, "askerAcceptedAt", "partnerAcceptedAt" FROM "ClubPartnership" WHERE "askerOrgId" = $1 AND "partnerOrgId" = $2`,
    [ORG_ID, PARTNER],
  );
const orgSettings = async (db: TestDb) =>
  db.one<{ when: string; cutoff: number; time: string | null }>(
    `SELECT "partnerAskWhen" AS when, "partnerAskCutoffHours" AS cutoff, "partnerAskTime" AS time FROM "Organisation" WHERE id = $1`,
    [ORG_ID],
  );

test.beforeAll(() => {
  resetDb();
});

test.afterAll(async ({ db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  resetDb();
});

test("no partner clubs: no section", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/settings");
  await expect(page.getByTestId("weekly-routine")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("partner-clubs")).toHaveCount(0);
});

test("the platform owner pairs the club with another on /admin/clubs/partners", async ({ page, db }) => {
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","createdAt","updatedAt")
     VALUES ($1,'Sutton Partners',$1,$2,'approved',now(),now())`,
    [PARTNER, `${PARTNER}-invite`],
  );
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await signInAs(page, U.admin, "/admin/clubs");
  await page.getByTestId("partners-link").click();
  const section = page.getByTestId("partner-clubs-page");
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.getByText("No clubs are paired.")).toBeVisible();
  const org = await db.one<{ name: string }>(`SELECT name FROM "Organisation" WHERE id = $1`, [ORG_ID]);
  await section.getByTestId("pair-asker").selectOption({ label: org!.name });
  await section.getByTestId("pair-partner").selectOption({ label: "Sutton Partners" });
  await section.getByTestId("pair-clubs").click();
  await expect(section.getByTestId("partnership")).toContainText(`${org!.name} may ask Sutton Partners`, { timeout: 15_000 });
  expect((await row(db))?.status).toBe("proposed");
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
});

test("the owner accepts; once the partner accepts too the asking settings save, each with its ⓘ", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/settings");
  const section = page.getByTestId("partner-clubs");
  await expect(section).toBeVisible({ timeout: 30_000 });
  const item = section.getByTestId("partner-club");
  await expect(item).toContainText("You may ask Sutton Partners for players");
  await expect(item.getByTestId("partner-club-status")).toHaveText("Waiting for both owners to accept");
  await item.getByTestId("partner-accept").click();
  await expect(item.getByTestId("partner-club-status")).toHaveText("Waiting for Sutton Partners's owner to accept", { timeout: 15_000 });
  expect((await row(db))?.askerAcceptedAt).not.toBeNull();

  // The other club's owner accepts (on their own page; here, the row).
  await db.run(`UPDATE "ClubPartnership" SET "partnerAcceptedAt" = now(), status = 'active' WHERE "askerOrgId" = $1`, [ORG_ID]);
  await page.reload();
  await expect(item.getByTestId("partner-club-status")).toHaveText("Active", { timeout: 30_000 });

  // The ⓘ of the list opens and closes.
  await section.getByRole("button", { name: "What is Your partner clubs?" }).click();
  await expect(page.getByRole("dialog")).toContainText("Only the MatchTime team pairs two clubs");
  await page.getByRole("button", { name: "Close" }).click();

  // When to ask: Automatically shows the time row; the cut-off defaults to 4 hours.
  await expect(section.getByTestId("partner-ask-cutoff")).toHaveValue("4");
  await expect(section.getByTestId("partner-ask-time")).toHaveCount(0);
  await section.getByTestId("partner-ask-when").selectOption("auto");
  await expect.poll(async () => (await orgSettings(db))?.when).toBe("auto");
  await expect(section.getByTestId("partner-ask-time")).toHaveValue("16:00");
  await section.getByTestId("partner-ask-time").fill("17:30");
  await section.getByTestId("partner-ask-time").blur();
  await expect.poll(async () => (await orgSettings(db))?.time).toBe("17:30");
  await section.getByTestId("partner-ask-cutoff").selectOption("6");
  await expect.poll(async () => (await orgSettings(db))?.cutoff).toBe(6);

  await section.getByRole("button", { name: "What is Last ask before kickoff?" }).click();
  await expect(page.getByRole("dialog")).toContainText("You can choose from 1 to 24 hours.");
  await page.getByRole("button", { name: "Close" }).click();

  // Pause, then resume (the side that paused).
  await item.getByTestId("partner-pause").click();
  await expect(item.getByTestId("partner-club-status")).toHaveText("Paused by you", { timeout: 15_000 });
  await item.getByTestId("partner-resume").click();
  await expect(item.getByTestId("partner-club-status")).toHaveText("Active", { timeout: 15_000 });
});

test("in Turkish: the section and its ⓘ", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/admin/settings");
  const section = page.getByTestId("partner-clubs");
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.getByText("Partner kulüpler", { exact: true })).toBeVisible();
  await expect(section.getByTestId("partner-club")).toContainText("Sutton Partners kulübünden oyuncu isteyebilirsiniz");
  await section.getByRole("button", { name: /Partner kulüplerden oyuncu iste/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Belirli bir saatte kendiliğinden");
  await page.getByRole("button", { name: "Kapat" }).click();
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});

test("a PLAYER of the club cannot see or change it", async ({ page }) => {
  await signInAs(page, U.player, "/admin/settings");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("partner-clubs")).toHaveCount(0);
});
