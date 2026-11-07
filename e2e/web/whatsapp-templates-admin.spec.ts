/**
 * /admin/whatsapp-templates: the platform owner's page for the official
 * number's message templates (Cloud API plan 5.6). Two things must hold:
 *
 *   1. a club admin can NOT open it (404) and is not shown a link to it;
 *   2. the owner sees the page with the status rows Meta's webhooks wrote.
 *
 * The suite pins WA_CLOUD_ACCESS_TOKEN empty (e2e/helpers/env.ts), so the
 * page's dry run says the setting is missing and nothing reaches Meta. The
 * dry run, Submit and the per-template result are unit tested on a stubbed
 * fetch (template-sync-admin.test.ts, template-sync-view.test.ts). $0.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

test.beforeEach(async ({ db }) => {
  await db.run(`DELETE FROM "CloudTemplateStatus"`);
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
});

test.afterAll(async ({ db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
  await db.run(`DELETE FROM "CloudTemplateStatus"`);
});

test("a club admin cannot open the WhatsApp templates page and is not shown a link to it", async ({ page }) => {
  await signInAs(page, U.admin, "/admin");
  await page.waitForURL("**/admin");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("link", { name: "WhatsApp templates", exact: true })).toHaveCount(0);

  const res = await page.goto("/admin/whatsapp-templates");
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId("whatsapp-templates-page")).toHaveCount(0);
});

test("the owner sees the page, Meta's status rows, and no Submit without a token", async ({ page, db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await db.run(
    `INSERT INTO "CloudTemplateStatus" (name, language, "metaTemplateId", status, category, "previousCategory", "qualityScore", reason, "createdAt", "updatedAt")
     VALUES
       ('mt_pool_offer', 'en_GB', '111', 'APPROVED', 'MARKETING', 'UTILITY', 'GREEN', NULL, now(), now()),
       ('mt_pool_paused', 'tr', '222', 'REJECTED', 'UTILITY', NULL, NULL, 'INVALID_FORMAT', now(), now())`,
  );

  await signInAs(page, U.admin, "/admin");
  await page.waitForURL("**/admin");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "WhatsApp templates", exact: true }).click();
  await page.waitForURL("**/admin/whatsapp-templates");

  await expect(page.getByRole("heading", { name: "WhatsApp templates" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("wt-not-configured")).toContainText("WA_CLOUD_ACCESS_TOKEN is not set");
  await expect(page.getByTestId("wt-submit-start")).toHaveCount(0);

  const rows = page.getByTestId("wt-status");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "mt_pool_offer" })).toContainText("MARKETING (was UTILITY)");
  await expect(rows.filter({ hasText: "mt_pool_paused" })).toContainText("REJECTED");
  await expect(rows.filter({ hasText: "mt_pool_paused" })).toContainText("INVALID_FORMAT");
});
