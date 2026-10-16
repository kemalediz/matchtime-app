/**
 * /admin/settings: an ⓘ beside EVERY setting (2026-10-15).
 *
 *   - every form control on the page sits in a row marked `data-setting`,
 *     and every such row has its own ⓘ (`info-setting-<key>`), in a weekly
 *     club with every optional row showing and in a monthly club;
 *   - the popup: keyboard (Enter opens, the focus goes in and stays in,
 *     Escape closes and the focus comes back), a tap outside closes it;
 *   - at phone width it keeps a 16px gutter and scrolls inside; dark mode
 *     gives it a dark panel;
 *   - a Turkish club reads it in Turkish.
 *
 * With SETTINGS_INFO_SHOTS=<dir> it also saves the screenshots the PR
 * shows: two popups, light and dark, desktop and phone.
 */
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const HQ = "120363777000000052@g.us";

test.beforeAll(() => {
  resetDb();
});

test.afterAll(() => {
  resetDb();
});

async function openSettings(page: Page) {
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");
  await expect(page.getByTestId("weekly-routine")).toBeVisible({ timeout: 30_000 });
}

/** Every visible, editable control is inside a `data-setting` row with its own ⓘ. */
async function expectEveryControlExplained(page: Page): Promise<string[]> {
  // Let the rows that load their own state (admin messages, teams ready, posters) arrive.
  await page.waitForLoadState("networkidle");
  const result = await page.evaluate(() => {
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>('[role="switch"], select, textarea, input:not([type="hidden"])'),
    ).filter((el) => {
      const input = el as HTMLInputElement;
      if (input.disabled && el.tagName !== "SELECT" && el.getAttribute("role") !== "switch") return false;
      if (input.readOnly) return false;
      if (el.closest('[role="dialog"]')) return false;
      // The sr-only file input of the posters card counts; anything else hidden does not.
      const style = getComputedStyle(el);
      const visible = el.getClientRects().length > 0 || (input.type === "file" && style.display !== "none");
      return visible;
    });
    const orphans = controls.filter((el) => !el.closest("[data-setting]")).map((el) => el.outerHTML.slice(0, 120));
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-setting]"));
    const missing = rows
      .filter((r) => !r.querySelector(`[data-testid="info-setting-${r.dataset.setting}"]`))
      .map((r) => r.dataset.setting ?? "");
    return { orphans, missing, keys: rows.map((r) => r.dataset.setting ?? "") };
  });
  expect(result.orphans, "controls with no data-setting row").toEqual([]);
  expect(result.missing, "rows without their own ⓘ").toEqual([]);
  return result.keys;
}

test("weekly club, every optional row showing: every control has its ⓘ", async ({ page, db }) => {
  await db.run(
    `UPDATE "Organisation" SET "paymentCollectionEnabled" = true, "benchPickMode" = 'organiser',
       "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`,
    [ORG_ID, HQ],
  );
  await openSettings(page);
  await expect(page.getByTestId("teams-ready")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("posters-card")).toBeVisible({ timeout: 30_000 });
  const keys = await expectEveryControlExplained(page);
  for (const k of [
    "clubName",
    "teamNames",
    "language",
    "attendance",
    "badgeAnnouncements",
    "rollingSquad",
    "benchPickMode",
    "benchPickFallback",
    "listAnnouncer",
    "dropOutDeadline",
    "listPublish",
    "adminChannel",
    "teamsReady",
    "posters",
    "posterDesign",
    "posterBackground",
    "squadMode",
    "moneyCollector",
    "collectorBank",
    // Weekly match fees (2026-10-16): the club's payment instructions.
    "paymentInstructions",
  ]) {
    expect(keys, k).toContain(k);
  }
});

test("monthly club: the monthly rows have their ⓘ too", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET "squadMode" = 'monthly' WHERE id = $1`, [ORG_ID]);
  await openSettings(page);
  await expect(page.getByTestId("msq-credit")).toBeVisible({ timeout: 30_000 });
  const keys = await expectEveryControlExplained(page);
  for (const k of ["squadMode", "monthCreditRule", "paygPrice", "monthListOpens", "paymentInstructions"]) expect(keys, k).toContain(k);
  expect(keys).not.toContain("rollingSquad");
  await db.run(`UPDATE "Organisation" SET "squadMode" = 'weekly' WHERE id = $1`, [ORG_ID]);
});

test("the popup: keyboard, Escape, a tap outside, and what it says", async ({ page }) => {
  await openSettings(page);
  const trigger = page.getByTestId("info-setting-rollingSquad");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Rolling squad" });
  await expect(dialog).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const close = dialog.getByRole("button", { name: "Close" });
  await expect(close).toBeFocused();
  // The focus stays in the popup.
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  // What it does, both choices, the default, who it suits, the other settings.
  await expect(dialog).toContainText("Everyone who played the last match is put in the squad for the next one automatically");
  await expect(dialog.getByTestId("setting-info-example")).toContainText("Everyone who played last time is in again");
  await expect(dialog).toContainText("New clubs:");
  await expect(dialog).toContainText("Suits:");
  await expect(dialog).toContainText("Works with other settings");
  // Escape closes it and the focus goes back to the ⓘ.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // A tap outside closes it, and opening one never flips the switch beside it.
  const toggle = page.getByTestId("weekly-routine").getByRole("switch", { name: "Rolling squad" });
  const before = await toggle.getAttribute("aria-checked");
  await trigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-checked", before ?? "false");
});

test("phone width: a 16px gutter, scrolls inside, and dark mode is dark", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await openSettings(page);
  await page.getByTestId("info-setting-paymentCollection").click();
  const dialog = page.getByRole("dialog", { name: "Collect match fees" });
  await expect(dialog).toBeVisible();
  // Measure where it settles, after its short slide-in.
  await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(16);
  expect(box.x + box.width).toBeLessThanOrEqual(390 - 16 + 0.5);
  expect(box.y).toBeGreaterThanOrEqual(16 - 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(640 - 16 + 0.5);
  // The long text scrolls inside the panel; the page behind does not move.
  const scrolls = await dialog.evaluate((el) => {
    const body = el.lastElementChild as HTMLElement;
    return body.scrollHeight > body.clientHeight;
  });
  expect(scrolls).toBe(true);
  const light = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(dark).not.toBe(light);
  await page.emulateMedia({ colorScheme: "light" });
  await page.keyboard.press("Escape");
});

test("a Turkish club reads every popup in Turkish", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await openSettings(page);
  // The page's own headings are Turkish too.
  for (const heading of ["Genel", "Takım adları", "Bot dili", "Davet bağlantısı", "Bot özellikleri", "WhatsApp botu"]) {
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  await expect(page.getByText("added in stages")).toHaveCount(0);
  await page.getByRole("button", { name: "Listeyi ve takımları kim duyurur nedir?" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Listeyi ve takımları kim duyurur" })).toBeVisible();
  await expect(dialog).toContainText("Organizatörler paylaşır");
  await expect(dialog).toContainText("Yeni kulüpler:");
  await dialog.getByRole("button", { name: "Kapat" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});

test("screenshots for the PR (only with SETTINGS_INFO_SHOTS)", async ({ page, db }) => {
  const dir = process.env.SETTINGS_INFO_SHOTS;
  test.skip(!dir, "set SETTINGS_INFO_SHOTS=<dir> to save them");
  mkdirSync(dir!, { recursive: true });
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  for (const [device, size] of [
    ["desktop", { width: 1280, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(size);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await openSettings(page);
      await page.waitForLoadState("networkidle");
      for (const k of ["listAnnouncer", "attendance"]) {
        const trigger = page.getByTestId(`info-setting-${k}`);
        await trigger.scrollIntoViewIfNeeded();
        await trigger.click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
        await page.screenshot({ path: join(dir!, `${k}-${scheme}-${device}.png`) });
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
      }
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
});

// Payment tracking is hidden for now (Kemal, 2026-10-16). The seeded club
// still has the column ON, and the page shows no row, no switch and no ⓘ
// for it; Collect match fees is still there.
test("payment tracking is hidden: no row, no switch, no explanation", async ({ page }) => {
  await openSettings(page);
  await expect(page.locator('[data-setting="paymentCollection"]')).toBeVisible();
  await expect(page.locator('[data-setting="paymentTracking"]')).toHaveCount(0);
  await expect(page.getByTestId("info-setting-paymentTracking")).toHaveCount(0);
  await expect(page.getByText(/Payment tracking/i)).toHaveCount(0);
  await expect(page.getByText(/tick when you've paid/i)).toHaveCount(0);
});
