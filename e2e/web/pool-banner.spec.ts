/**
 * The one-line player pool banner on every signed-in page (2026-10-28), in
 * a real browser: join for a member not in the pool (its ⓘ, and "Join the
 * pool" landing on the highlighted "Play elsewhere too" card), share once
 * he is in the pool (his own link in a wa.me message), "Not interested"
 * holding across a reload and on other pages (stored on his user row),
 * join dismissed then joining still shows share, hidden while the club's
 * pool or the platform is off and on public pages, the admin line, Turkish,
 * and phone width. No model, no messages: $0.
 */
import type { Page } from "@playwright/test";
import { test, expect, signInAs, U } from "../fixtures";
import { setPoolPlatform } from "../helpers/pool-platform";
import { ORG_ID } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";
import { poolBannerCopy } from "@/lib/i18n/pool-banner";
import { poolShareCopy } from "@/lib/i18n/pool-share";

const EN = poolBannerCopy("en");
const TR = poolBannerCopy("tr");
const PHONE = { width: 375, height: 740 };
const DESKTOP = { width: 1280, height: 900 };
const SHOTS = "/private/tmp/claude-501/-Users-kemal-Projects-Cressoft-Sports-matchtime/53efc5e1-1f7c-48ce-a74b-cc3c6361bf47/scratchpad/pool-banner";
const SHARE_KEY = `org-${ORG_ID}:pool-club-share`;

test.describe.configure({ mode: "serial" });

const banner = (page: Page) => page.getByTestId("pool-banner");
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function seedActiveProfile(db: TestDb, userId: string) {
  await db.run(`DELETE FROM "PoolProfile" WHERE "userId" = $1`, [userId]);
  await db.run(
    `INSERT INTO "PoolProfile" (id, "userId", status, "consentAt", "consentVersion", "consentChannel", "consentEvidence", "adultConfirmedAt",
       "displayName", "areaDistrict", "areaLat", "areaLng", "maxMiles", source, "createdAt", "updatedAt")
     VALUES ($1, $2, 'active', now(), 1, 'web', 'e2e', now(), 'Pat Player', 'SM1', 51.36, -0.19, 3, 'profile', now(), now())`,
    [`e2e-banner-${userId}`, userId],
  );
}

const dismissals = (db: TestDb, userId: string) =>
  db.one<{ j: Date | null; s: Date | null }>(`SELECT "poolBannerJoinDismissedAt" AS j, "poolBannerShareDismissedAt" AS s FROM "User" WHERE id = $1`, [userId]);

async function reset(db: TestDb) {
  await setPoolPlatform(db, true);
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = true, language = 'en' WHERE id = $1`, [ORG_ID]);
  await db.run(`UPDATE "User" SET "poolBannerJoinDismissedAt" = NULL, "poolBannerShareDismissedAt" = NULL WHERE id IN ($1, $2)`, [U.player, U.admin]);
  await db.run(`DELETE FROM "PoolProfile" WHERE "userId" IN ($1, $2)`, [U.player, U.admin]);
  await db.run(`DELETE FROM "SentNotification" WHERE key = $1`, [SHARE_KEY]);
}

test.beforeEach(async ({ db }) => reset(db));
test.afterAll(async ({ db }) => {
  await reset(db);
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = false WHERE id = $1`, [ORG_ID]);
  await setPoolPlatform(db, false);
});

test("phone: join, its ⓘ, and Join the pool lands on the highlighted Play elsewhere too card", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signInAs(page, U.player, "/");
  const b = banner(page);
  await expect(b).toBeVisible({ timeout: 30_000 });
  await expect(b).toHaveAttribute("data-kind", "join");
  await expect(b.getByTestId("pool-banner-text")).toContainText(EN.join.text);
  await expect(b.getByTestId("pool-banner-join")).toHaveText(EN.join.button);
  await expect(b.getByTestId("pool-banner-dismiss")).toHaveText(EN.notInterested);
  await expect(b.getByTestId("pool-banner-admin")).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  // Compact: the line and its buttons, never taller than a few rows.
  expect((await b.boundingBox())!.height).toBeLessThan(110);
  await page.screenshot({ path: `${SHOTS}/phone-join-dashboard.png` });

  await page.getByTestId("info-pool-banner").click();
  const dialog = page.getByRole("dialog", { name: EN.join.info.title });
  await expect(dialog).toBeVisible();
  for (const line of EN.join.info.lines) await expect(dialog).toContainText(line);
  await page.waitForTimeout(500); // the sheet's slide-in, for the picture only
  await page.screenshot({ path: `${SHOTS}/phone-join-info.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await b.getByTestId("pool-banner-join").click();
  await page.waitForURL("**/profile#play-elsewhere");
  const card = page.getByTestId("play-elsewhere");
  await expect(card).toHaveAttribute("data-highlight", "on", { timeout: 30_000 });
  await expect(card).toBeInViewport();
  // Let the smooth scroll settle before the picture.
  await expect
    .poll(() => page.evaluate(async () => { const a = window.scrollY; await new Promise((r) => setTimeout(r, 250)); return window.scrollY - a; }))
    .toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS}/phone-join-lands-on-card.png` });
});

test("the banner is on the other signed-in pages too, under the nav, never over the content", async ({ page }) => {
  await page.setViewportSize(PHONE);
  for (const path of ["/profile", "/matches", "/profile/stats"]) {
    await signInAs(page, U.player, path);
    await expect(banner(page)).toBeVisible({ timeout: 30_000 });
    // In the flow: it scrolls away with the page rather than sitting over it.
    const position = await banner(page).evaluate((el) => getComputedStyle(el).position);
    expect(["static", "relative"]).toContain(position);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  }
});

test("never on public pages", async ({ page }) => {
  await signInAs(page, U.player, "/privacy");
  await page.waitForLoadState("networkidle");
  await expect(banner(page)).toHaveCount(0);
  await page.goto("/play");
  await page.waitForLoadState("networkidle");
  await expect(banner(page)).toHaveCount(0);
});

test("Not interested on join holds across a reload and on another page, stored on his user row", async ({ page, db }) => {
  await signInAs(page, U.player, "/");
  await expect(banner(page)).toBeVisible({ timeout: 30_000 });
  await banner(page).getByTestId("pool-banner-dismiss").click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(async () => (await dismissals(db, U.player))?.j ?? null).not.toBeNull();
  expect((await dismissals(db, U.player))?.s).toBeNull();

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
  await expect(banner(page)).toHaveCount(0);
  await page.goto("/profile");
  await expect(page.getByTestId("play-elsewhere")).toBeVisible({ timeout: 30_000 });
  await expect(banner(page)).toHaveCount(0);
});

for (const [name, size] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
  test(`${name}: in the pool, share his own link on WhatsApp`, async ({ page, db }) => {
    await seedActiveProfile(db, U.player);
    await page.setViewportSize(size);
    await signInAs(page, U.player, "/");
    const b = banner(page);
    await expect(b).toHaveAttribute("data-kind", "share", { timeout: 30_000 });
    await expect(b.getByTestId("pool-banner-text")).toContainText(EN.share.text);
    const share = b.getByTestId("pool-banner-share");
    await expect(share).toHaveText(EN.share.button);
    const code = (await db.one<{ shareCode: string }>(`SELECT "shareCode" FROM "PoolProfile" WHERE "userId" = $1`, [U.player]))!.shareCode;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    const href = await share.getAttribute("href");
    expect(href).toMatch(/^https:\/\/wa\.me\/\?text=/);
    const text = decodeURIComponent(href!.split("text=")[1]);
    expect(text).toMatch(new RegExp(`/play\\?ref=${code}$`));
    expect(text).toBe(poolShareCopy("en").message(text.slice(text.lastIndexOf("http"))));
    await expect(share).toHaveAttribute("target", "_blank");
    await b.getByTestId("info-pool-banner").click();
    const dialog = page.getByRole("dialog", { name: EN.share.info.title });
    for (const line of EN.share.info.lines) await expect(dialog).toContainText(line);
    await page.keyboard.press("Escape");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/${name}-share.png` });
  });
}

test("join dismissed, then he joins: the share banner still shows once; dismissing it holds", async ({ page, db }) => {
  await db.run(`UPDATE "User" SET "poolBannerJoinDismissedAt" = now() WHERE id = $1`, [U.player]);
  await signInAs(page, U.player, "/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
  await expect(banner(page)).toHaveCount(0);

  await seedActiveProfile(db, U.player);
  await page.reload();
  await expect(banner(page)).toHaveAttribute("data-kind", "share", { timeout: 30_000 });
  await banner(page).getByTestId("pool-banner-dismiss").click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(async () => (await dismissals(db, U.player))?.s ?? null).not.toBeNull();
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
  await expect(banner(page)).toHaveCount(0);
});

test("hidden while the club's pool is off, and while the platform is off", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = false WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.player, "/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
  await expect(banner(page)).toHaveCount(0);

  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = true WHERE id = $1`, [ORG_ID]);
  await setPoolPlatform(db, false);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
  await expect(banner(page)).toHaveCount(0);

  // On again: back on the next page, nothing cached.
  await setPoolPlatform(db, true);
  await page.reload();
  await expect(banner(page)).toBeVisible({ timeout: 30_000 });
});

test("the admin line for an owner whose club has not told its players, gone once it has", async ({ page, db }) => {
  await page.setViewportSize(PHONE);
  await signInAs(page, U.admin, "/admin");
  const b = banner(page);
  await expect(b).toBeVisible({ timeout: 30_000 });
  const line = b.getByTestId("pool-banner-admin");
  await expect(line).toHaveText(EN.adminLine);
  await expect(line).toHaveAttribute("href", "/admin/settings#pool-club-share");
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/phone-admin-line.png` });

  await db.run(`INSERT INTO "SentNotification" (id, key, kind, "createdAt") VALUES ('e2e-banner-share-claim', $1, 'pool-club-share', now())`, [SHARE_KEY]);
  await page.reload();
  await expect(b).toBeVisible({ timeout: 30_000 });
  await expect(b.getByTestId("pool-banner-admin")).toHaveCount(0);
});

test("before the migration (the columns missing): no banner, and the pages still work", async ({ page, db }) => {
  await db.run(`ALTER TABLE "User" RENAME COLUMN "poolBannerJoinDismissedAt" TO "e2eHiddenJoin"`);
  await db.run(`ALTER TABLE "User" RENAME COLUMN "poolBannerShareDismissedAt" TO "e2eHiddenShare"`);
  try {
    for (const path of ["/", "/profile", "/admin"]) {
      await signInAs(page, U.admin, path);
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
      await expect(banner(page)).toHaveCount(0);
    }
  } finally {
    await db.run(`ALTER TABLE "User" RENAME COLUMN "e2eHiddenJoin" TO "poolBannerJoinDismissedAt"`);
    await db.run(`ALTER TABLE "User" RENAME COLUMN "e2eHiddenShare" TO "poolBannerShareDismissedAt"`);
  }
  await page.reload();
  await expect(banner(page)).toBeVisible({ timeout: 30_000 });
});

test("Turkish club: the Turkish banner", async ({ page, db }) => {
  await page.setViewportSize(PHONE);
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/");
  const b = banner(page);
  await expect(b).toBeVisible({ timeout: 30_000 });
  await expect(b).toHaveAttribute("lang", "tr");
  await expect(b.getByTestId("pool-banner-text")).toContainText(TR.join.text);
  await expect(b.getByTestId("pool-banner-join")).toHaveText(TR.join.button);
  await expect(b.getByTestId("pool-banner-dismiss")).toHaveText(TR.notInterested);
  await expect(b.getByTestId("pool-banner-admin")).toHaveText(TR.adminLine);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/phone-turkish.png` });

  await seedActiveProfile(db, U.admin);
  await db.run(`UPDATE "PoolProfile" SET language = 'tr' WHERE "userId" = $1`, [U.admin]);
  await page.reload();
  await expect(b).toHaveAttribute("data-kind", "share", { timeout: 30_000 });
  await expect(b.getByTestId("pool-banner-text")).toContainText(TR.share.text);
  await expect(b.getByTestId("pool-banner-share")).toHaveText(TR.share.button);
  await page.screenshot({ path: `${SHOTS}/phone-turkish-share.png` });
});
