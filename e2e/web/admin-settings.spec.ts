/**
 * Admin → Settings + Activities.
 *
 *   - money-collector picker shows the seeded collector
 *   - payment-method toggle persists (UI → DB → reload → pay page)
 *   - responsive: no horizontal overflow at mobile width on settings,
 *     activities and the admin subnav
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID, MATCH } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

test("money-collector picker has the seeded collector selected", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");
  const select = page.locator("select").filter({ hasText: "Colin Collector" }).first();
  await expect(select).toBeVisible({ timeout: 30_000 });
  await expect(select).toHaveValue(U.collector);
});

test("payment-method toggle persists and gates the pay page", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");

  // The "↳ Pay by Bank" feature row's switch.
  const bankRow = page
    .locator("div")
    .filter({ hasText: /Pay by Bank/ })
    .filter({ has: page.getByRole("switch") })
    .last();
  const bankSwitch = bankRow.getByRole("switch");
  await expect(bankSwitch).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });

  // OFF → persists to the org row…
  await bankSwitch.click();
  await expect
    .poll(async () => {
      const org = await db.one<{ payMethodPayByBank: boolean }>(
        `SELECT "payMethodPayByBank" FROM "Organisation" WHERE id = $1`,
        [ORG_ID],
      );
      return org?.payMethodPayByBank;
    })
    .toBe(false);

  // …survives a reload…
  await page.reload();
  await expect(
    page
      .locator("div")
      .filter({ hasText: /Pay by Bank/ })
      .filter({ has: page.getByRole("switch") })
      .last()
      .getByRole("switch"),
  ).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });

  // …and actually hides the method on the pay page.
  await page.goto(`/pay/${MATCH.pay}`);
  await expect(page.getByRole("button", { name: /Card, Apple or Google Pay/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /^Pay by Bank/ })).toHaveCount(0);

  // Restore for later specs.
  await db.run(`UPDATE "Organisation" SET "payMethodPayByBank" = true WHERE id = $1`, [ORG_ID]);
});

test("settings + activities render with no horizontal overflow at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");
  await expect(page.getByText(/Money collector/i).first()).toBeVisible({ timeout: 30_000 });
  let overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "settings page horizontal overflow").toBeLessThanOrEqual(0);

  await page.goto("/admin/activities");
  await expect(page.getByText("E2E 5-a-side").first()).toBeVisible({ timeout: 30_000 });
  overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "activities page horizontal overflow").toBeLessThanOrEqual(0);
});
