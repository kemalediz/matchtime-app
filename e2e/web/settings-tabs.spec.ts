/**
 * /admin/settings as tabs of collapsible cards (2026-10-28).
 *
 *   - six tabs; choosing one shows its cards only, and it survives a reload
 *     (?tab= in the address);
 *   - a card shows its title and a one-line summary until it is opened;
 *   - "Find a setting": "pool" finds Player pool and opens it on its tab;
 *     "havuz" finds it too, and a Turkish club reads the box as "Ayar bul";
 *   - /admin/settings#player-pool opens the tab, expands the card and
 *     scrolls to it;
 *   - phone width: no sideways page scroll; the tab row scrolls instead.
 *
 * With SETTINGS_UX_SHOTS=<dir> it also saves a phone screenshot of each tab
 * and of the search, for the PR.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { setPoolPlatform } from "../helpers/pool-platform";
import { SETTINGS_TABS, openSettingsTab } from "../helpers/settings-nav";

test.describe.configure({ mode: "serial" });

const PHONE = { width: 390, height: 844 };

test.beforeAll(() => {
  resetDb();
});

test.beforeEach(async ({ db }) => {
  await setPoolPlatform(db, true);
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = true, language = 'en' WHERE id = $1`, [ORG_ID]);
});

test.afterAll(async ({ db }) => {
  await setPoolPlatform(db, false);
  resetDb();
});

const noSidewaysScroll = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("the tabs switch, and the chosen one survives a reload", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/settings");
  const tabs = page.getByRole("tablist", { name: "Settings sections" });
  await expect(tabs).toBeVisible({ timeout: 30_000 });
  await expect(tabs.getByRole("tab")).toHaveText(["Club", "Matches", "Players", "Payments", "Finding players", "Messages"]);

  // Club first: its cards show, collapsed, with their summaries.
  await expect(page.getByRole("tab", { name: "Club", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("settings-card-toggle-club-details")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("settings-card-summary-club-details")).toHaveText(/^E2E Test FC, \d+ members$/);
  await expect(page.getByTestId("settings-card-summary-bot-language")).toHaveText("English");
  await expect(page.locator("#org-slug")).toBeHidden();
  // Other tabs' cards are not shown.
  await expect(page.getByTestId("quiet-hours")).toBeHidden();

  // A tap on the header opens the card; another closes it.
  await page.getByTestId("settings-card-toggle-club-details").click();
  await expect(page.locator("#org-slug")).toBeVisible();
  await expect(page.getByTestId("settings-card-summary-club-details")).toHaveCount(0);
  await page.getByTestId("settings-card-toggle-club-details").click();
  await expect(page.locator("#org-slug")).toBeHidden();

  // Messages: quiet hours, admin messages, posters.
  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/settings\?tab=messages$/);
  const quiet = page.getByTestId("quiet-hours");
  await expect(quiet).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("settings-card-summary-quiet-hours")).toHaveText("On, 23:00 to 09:00");
  await expect(page.getByTestId("settings-card-toggle-club-details")).toBeHidden();

  // The tab survives a reload.
  await page.reload();
  await expect(page.getByRole("tab", { name: "Messages", exact: true })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
  await expect(page.getByTestId("quiet-hours")).toBeVisible({ timeout: 30_000 });

  // And can be linked to.
  await page.goto("/admin/settings?tab=players");
  await expect(page.getByRole("tab", { name: "Players", exact: true })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
  await expect(page.getByTestId("settings-card-toggle-attendance")).toBeVisible();
});

test("Find a setting: 'pool' finds Player pool and opens it on its tab", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/settings");
  const box = page.getByRole("combobox", { name: "Find a setting" });
  await expect(box).toBeVisible({ timeout: 30_000 });
  // The pool cards load their own state; wait until the search knows them.
  await openSettingsTab(page, "finding");
  await expect(page.getByTestId("player-pool")).toBeVisible({ timeout: 30_000 });
  await openSettingsTab(page, "club");

  await box.fill("pool");
  const results = page.getByTestId("find-setting-results").getByRole("option");
  await expect(results.first()).toContainText("Player pool");
  await expect(results.first()).toContainText("Finding players");
  await expect(page.getByTestId("find-setting-results")).toContainText("Ask the player pool automatically");

  await page.getByTestId("find-setting-result-player-pool").click();
  await expect(page.getByRole("tab", { name: "Finding players", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("settings-card-toggle-player-pool")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("player-pool-switch")).toBeVisible();
  await expect(page.getByTestId("player-pool-switch")).toBeInViewport();
  await expect(page.getByTestId("find-setting-results")).toHaveCount(0);
  await expect(page).toHaveURL(/\?tab=finding#player-pool$/);

  // Turkish words find it too, and nonsense finds nothing.
  await box.fill("havuz");
  await expect(page.getByTestId("find-setting-results").getByRole("option").first()).toContainText("Player pool");
  await box.fill("zzzz");
  await expect(page.getByTestId("find-setting-results")).toHaveText("No setting matches that.");

  // Enter picks the first result.
  await box.fill("quiet");
  await box.press("Enter");
  await expect(page.getByRole("tab", { name: "Messages", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("quiet-hours-switch")).toBeVisible();
});

test("a Turkish club: Ayar bul, Turkish tabs and summaries; English words still find", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/admin/settings");
  const box = page.getByRole("combobox", { name: "Ayar bul" });
  await expect(box).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("tablist", { name: "Ayar bölümleri" }).getByRole("tab")).toHaveText([
    "Kulüp",
    "Maçlar",
    "Oyuncular",
    "Ödemeler",
    "Oyuncu bulma",
    "Mesajlar",
  ]);
  await expect(page.getByTestId("settings-card-summary-bot-language")).toHaveText("Türkçe");
  await openSettingsTab(page, "finding");
  await expect(page.getByTestId("player-pool")).toBeVisible({ timeout: 30_000 });
  await box.fill("pool");
  await expect(page.getByTestId("find-setting-results").getByRole("option").first()).toContainText("Oyuncu havuzu");
  await box.fill("havuz");
  await page.getByTestId("find-setting-result-player-pool").click();
  await expect(page.getByTestId("player-pool-switch")).toBeVisible();
  await expect(page.getByTestId("settings-card-summary-pool-auto-ask")).toHaveText("Kapalı");
});

test("#player-pool opens its tab, expands it and scrolls to it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 500 });
  await signInAs(page, U.admin, "/admin/settings#player-pool");
  await expect(page.getByRole("tab", { name: "Finding players", exact: true })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
  await expect(page.getByTestId("settings-card-toggle-player-pool")).toHaveAttribute("aria-expanded", "true", { timeout: 30_000 });
  await expect(page.getByTestId("player-pool-switch")).toBeVisible();
  await expect(page.getByTestId("player-pool")).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  // The other cards on the tab stay collapsed, with their summaries.
  await expect(page.getByTestId("settings-card-toggle-partner-clubs")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("settings-card-summary-pool-auto-ask")).toHaveText("Off");
});

test("phone width: no sideways page scroll, the tab row scrolls instead, every tab works", async ({ page }) => {
  const shots = process.env.SETTINGS_UX_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  await page.setViewportSize(PHONE);
  await signInAs(page, U.admin, "/admin/settings");
  const row = page.getByTestId("settings-tabs");
  await expect(row).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  expect(await noSidewaysScroll(page)).toBeLessThanOrEqual(0);
  // The six tabs do not fit in 390px: the row scrolls, the page does not.
  expect(await row.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // The cards keep a 16px gutter at least.
  const card = (await page.getByTestId("settings-card-toggle-club-details").locator("xpath=ancestor::section[1]").boundingBox())!;
  expect(card.x).toBeGreaterThanOrEqual(16);
  expect(card.x + card.width).toBeLessThanOrEqual(PHONE.width - 16 + 0.5);

  for (const tab of SETTINGS_TABS) {
    await openSettingsTab(page, tab);
    await expect(page.getByTestId(`settings-tab-${tab}`)).toBeInViewport();
    await expect(page.getByTestId(`settings-panel-${tab}`)).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await noSidewaysScroll(page), tab).toBeLessThanOrEqual(0);
    if (shots) await page.screenshot({ path: join(shots, `tab-${tab}-phone.png`), fullPage: true });
  }

  await page.getByRole("combobox", { name: "Find a setting" }).fill("pool");
  await expect(page.getByTestId("find-setting-results")).toBeVisible();
  expect(await noSidewaysScroll(page)).toBeLessThanOrEqual(0);
  if (shots) await page.screenshot({ path: join(shots, "search-pool-phone.png") });
  await page.getByTestId("find-setting-result-player-pool").click();
  await expect(page.getByTestId("player-pool-switch")).toBeVisible();
  expect(await noSidewaysScroll(page)).toBeLessThanOrEqual(0);
  if (shots) await page.screenshot({ path: join(shots, "search-opened-player-pool-phone.png") });
});
