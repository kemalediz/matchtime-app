/**
 * Payment instructions for WEEKLY match fees (Kemal, 2026-10-16).
 *
 *   - a weekly club with Collect match fees on gets the "Payment
 *     instructions" field in its Payments section, with its ⓘ; it saves,
 *     reloads and refuses nothing it should keep;
 *   - a monthly club edits the same field in its Monthly squad section,
 *     so the Payments section does not show it a second time;
 *   - /pay/<match> shows the text verbatim, as plain text (no markup, no
 *     links made from it), under the buttons, only when paying the
 *     collector directly is offered; Turkish club, Turkish heading.
 *
 * No model is called anywhere in this spec.
 */
import type { Page } from "@playwright/test";
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, ORG_ID } from "../helpers/constants";
import { testDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

const TEXT = "Sort code 12-34-56, account 12345678.\nReference: your name <b>not bold</b> https://example.com/x";

async function setOrg(sql: string, params: unknown[] = []) {
  await testDb().run(`UPDATE "Organisation" SET ${sql} WHERE id = $1`, [ORG_ID, ...params]);
}

async function openSettings(page: Page) {
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");
  await expect(page.getByTestId("monthly-squad")).toBeVisible({ timeout: 30_000 });
}

test("weekly club collecting match fees: the field is in Payments, with its info, and saves", async ({ page, db }) => {
  await openSettings(page);
  const payments = page.locator("#payments");
  const row = payments.getByTestId("pay-instructions-row");
  await expect(row).toBeVisible();
  await expect(row.getByText("Payment instructions", { exact: true })).toBeVisible();
  await expect(row.getByTestId("info-setting-paymentInstructions")).toBeVisible();
  // The monthly section is still the one switch for a weekly club.
  await expect(page.getByTestId("msq-instructions")).toHaveCount(0);

  // The popup says where it shows for a weekly club.
  await row.getByTestId("info-setting-paymentInstructions").click();
  const dialog = page.getByRole("dialog", { name: "Payment instructions" });
  await expect(dialog).toContainText("on the pay page, in the pay link and in the daily reminder");
  await page.keyboard.press("Escape");

  await row.getByTestId("pay-instructions-input").fill("  Sort code 12-34-56, account 12345678  ");
  await row.getByTestId("pay-instructions-save").click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Saved" }).first()).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => (await db.one<{ paymentInstructions: string | null }>(`SELECT "paymentInstructions" FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.paymentInstructions)
    .toBe("Sort code 12-34-56, account 12345678");

  await page.reload();
  await expect(page.getByTestId("pay-instructions-input")).toHaveValue("Sort code 12-34-56, account 12345678", { timeout: 30_000 });

  // Cleared: saved as nothing.
  await page.getByTestId("pay-instructions-input").fill("   ");
  await page.getByTestId("pay-instructions-save").click();
  await expect
    .poll(async () => (await db.one<{ paymentInstructions: string | null }>(`SELECT "paymentInstructions" FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.paymentInstructions)
    .toBeNull();
});

test("monthly club: the field stays in Monthly squad only; fees off: no Payments field", async ({ page }) => {
  await setOrg(`"squadMode" = 'monthly'`);
  await openSettings(page);
  await expect(page.getByTestId("msq-instructions")).toBeVisible();
  await expect(page.getByTestId("pay-instructions-row")).toHaveCount(0);

  await setOrg(`"squadMode" = 'weekly', "paymentCollectionEnabled" = false`);
  await openSettings(page);
  await expect(page.locator("#payments")).toHaveCount(0);
  await expect(page.getByTestId("pay-instructions-row")).toHaveCount(0);
  await setOrg(`"paymentCollectionEnabled" = true`);
});

test("pay page: the instructions, verbatim and plain, when paying directly is offered", async ({ page }) => {
  await setOrg(`"paymentInstructions" = $2`, [TEXT]);
  await signInAs(page, U.player, `/pay/${MATCH.pay}`);
  await page.waitForURL(`**/pay/${MATCH.pay}`);
  const box = page.getByTestId("pay-instructions");
  await expect(box).toBeVisible();
  await expect(box).toContainText("How to pay Colin");
  // Verbatim: the text node is exactly what the organiser wrote.
  expect(await page.getByTestId("pay-instructions-text").evaluate((el) => el.textContent)).toBe(TEXT);
  // Plain text: no markup rendered and no link made from it.
  await expect(box.locator("b")).toHaveCount(0);
  await expect(box.locator("a")).toHaveCount(0);
  // The buttons are still there, the box under them.
  await expect(page.getByRole("button", { name: /Pay Colin directly/ })).toBeVisible();
});

test("pay page: nothing when direct is off, or when no instructions are set", async ({ page }) => {
  await setOrg(`"payMethodDirect" = false`);
  await signInAs(page, U.player, `/pay/${MATCH.pay}`);
  await page.waitForURL(`**/pay/${MATCH.pay}`);
  await expect(page.getByRole("button", { name: /Card, Apple or Google Pay/ })).toBeVisible();
  await expect(page.getByTestId("pay-instructions")).toHaveCount(0);

  await setOrg(`"payMethodDirect" = true, "paymentInstructions" = NULL`);
  await page.reload();
  await expect(page.getByRole("button", { name: /Pay Colin directly/ })).toBeVisible();
  await expect(page.getByTestId("pay-instructions")).toHaveCount(0);
});

test("pay page, Turkish club: Turkish heading, same text", async ({ page }) => {
  await setOrg(`"paymentInstructions" = $2, language = 'tr'`, [TEXT]);
  await signInAs(page, U.player, `/pay/${MATCH.pay}`);
  await page.waitForURL(`**/pay/${MATCH.pay}`);
  const box = page.getByTestId("pay-instructions");
  await expect(box).toContainText("Doğrudan Colin ile ödeme");
  expect(await page.getByTestId("pay-instructions-text").evaluate((el) => el.textContent)).toBe(TEXT);
  await setOrg(`language = 'en', "paymentInstructions" = NULL`);
});
