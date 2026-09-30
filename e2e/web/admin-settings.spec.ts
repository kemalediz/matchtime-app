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

test("Weekly routine: the rolling squad switch persists, and its info opens (EN and TR)", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");
  const section = page.getByTestId("weekly-routine");
  await expect(section.getByRole("heading", { name: "Weekly routine" })).toBeVisible({ timeout: 30_000 });
  const toggle = section.getByRole("switch", { name: "Rolling squad" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  // The ⓘ explains it.
  await section.getByRole("button", { name: "What is Rolling squad?" }).click();
  await expect(page.getByText(/everyone who played the last match is automatically in for the next one/)).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  // ON persists to the org row and survives a reload.
  await toggle.click();
  await expect
    .poll(async () =>
      (await db.one<{ v: boolean }>(`SELECT "rollingSquadEnabled" AS v FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.v,
    )
    .toBe(true);
  await page.reload();
  await expect(page.getByTestId("weekly-routine").getByRole("switch", { name: "Rolling squad" })).toHaveAttribute(
    "aria-checked",
    "true",
    { timeout: 30_000 },
  );

  // A Turkish club reads it in Turkish.
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await page.reload();
  const tr = page.getByTestId("weekly-routine");
  await expect(tr.getByRole("heading", { name: "Haftalık düzen" })).toBeVisible({ timeout: 30_000 });
  await tr.getByRole("button", { name: "What is Kadro devam eder?" }).click();
  await expect(page.getByText(/son maçta oynayan herkes bir sonraki maçta otomatik olarak kadroda olur/)).toBeVisible();

  // Restore for later specs.
  await db.run(`UPDATE "Organisation" SET language = 'en', "rollingSquadEnabled" = false WHERE id = $1`, [ORG_ID]);
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
