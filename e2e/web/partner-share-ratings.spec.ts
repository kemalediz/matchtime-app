/**
 * "Share our players' ratings with partner clubs" (Kemal, 2026-10-22,
 * option C), on /admin/settings under Partner clubs.
 *
 *   - off for an existing club; an owner switches it on and off, and the
 *     column follows; its ⓘ says exactly what partner clubs will see;
 *   - the same in Turkish;
 *   - a PLAYER of the club never sees it.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const shared = async (db: TestDb) =>
  (await db.one<{ on: boolean }>(`SELECT "sharePlayerRatingsWithPartners" AS on FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.on;

test.beforeAll(() => {
  resetDb();
});

test.afterAll(async ({ db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  resetDb();
});

test("off by default; an owner switches it on and off; the ⓘ says what partner clubs see", async ({ page, db }) => {
  expect(await shared(db)).toBe(false);
  await signInAs(page, U.admin, "/admin/settings#partner-clubs");
  const section = page.getByTestId("partner-clubs");
  await expect(section).toBeVisible({ timeout: 30_000 });
  const sw = section.getByRole("switch", { name: "Share our players' ratings with partner clubs" });
  await expect(sw).toHaveAttribute("aria-checked", "false");

  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });
  await expect.poll(() => shared(db), { timeout: 15_000 }).toBe(true);

  await section.getByTestId("info-setting-partnerShareRatings").click();
  const dialog = page.getByRole("dialog", { name: "Share our players' ratings with partner clubs" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("top third, middle third or bottom third");
  await expect(dialog).toContainText("they also see his rating at your club");
  await expect(dialog).toContainText("They never see your other players");
  await expect(dialog).toContainText("New clubs:");
  await page.getByRole("button", { name: "Close" }).click();

  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false", { timeout: 15_000 });
  await expect.poll(() => shared(db), { timeout: 15_000 }).toBe(false);
});

test("in Turkish: the switch and its ⓘ", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/admin/settings#partner-clubs");
  const section = page.getByTestId("partner-clubs");
  await expect(section).toBeVisible({ timeout: 30_000 });
  const sw = section.getByRole("switch", { name: "Oyuncularımızın puanlarını partner kulüplerle paylaş" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });
  await expect.poll(() => shared(db), { timeout: 15_000 }).toBe(true);
  await section.getByTestId("info-setting-partnerShareRatings").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("üst üçte bir, orta üçte bir ya da alt üçte bir");
  await expect(dialog).toContainText("kulübünüzdeki puanını da görürler");
  await page.getByRole("button", { name: "Kapat" }).click();
  await db.run(`UPDATE "Organisation" SET language = 'en', "sharePlayerRatingsWithPartners" = false WHERE id = $1`, [ORG_ID]);
});

test("a PLAYER of the club never sees the switch", async ({ page }) => {
  await signInAs(page, U.player, "/admin/settings");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("switch", { name: "Share our players' ratings with partner clubs" })).toHaveCount(0);
});
