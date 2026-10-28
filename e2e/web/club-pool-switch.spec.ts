/**
 * The player pool's two switches (2026-10-28, decisions P.1 and P.2):
 *
 *   - /admin/clubs has ONE "Player pool" switch for the whole platform
 *     (superadmin only), no per-club list; off asks first and closes every
 *     open pool ask at once;
 *   - /admin/settings has the club's own "Player pool" card, for owners and
 *     admins, shown only while the platform switch is on; Style of play and
 *     "Ask the player pool automatically" appear under it once it is on;
 *     off asks first, closes the club's open asks and keeps poolAutoAsk;
 *   - the first switch-on tells the club once: the seeded club has no admin
 *     group, so ONE post in its players' group, worded for everyone, and no
 *     admin DM (Kemal, 2026-10-28); off and on again never repeats;
 *   - a player who is not an admin never gets the card.
 *
 * Screenshots go to MT_SHOTS_DIR, else .e2e/test-results. No model calls.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { REPO_ROOT } from "../helpers/env";
import { poolPlatformOn, setPoolPlatform } from "../helpers/pool-platform";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const SHOTS = process.env.MT_SHOTS_DIR ?? path.join(REPO_ROOT, ".e2e", "test-results", "pool-switch-shots");

async function flags(db: TestDb) {
  return db.one<{ pool: boolean; auto: boolean }>(`SELECT "featurePlayerPool" AS pool, "poolAutoAsk" AS auto FROM "Organisation" WHERE id = $1`, [ORG_ID]);
}

async function openSettings(page: import("@playwright/test").Page, userId: string) {
  await signInAs(page, userId, "/admin/settings#player-pool");
  await expect(page.getByTestId("settings-tabs")).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
}

const noticeJobs = (db: TestDb) =>
  db.all<{ kind: string; phone: string | null; text: string }>(
    `SELECT kind, phone, text FROM "BotJob" WHERE "orgId" = $1 AND text LIKE '%player pool is now on%' ORDER BY phone`,
    [ORG_ID],
  );

test.beforeAll(() => {
  resetDb();
});

test.afterAll(() => {
  resetDb();
});

test.beforeEach(async ({ page, db }) => {
  // Switching OFF asks to confirm, on both pages.
  page.on("dialog", (d) => void d.accept());
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = false, "poolAutoAsk" = false, language = 'en' WHERE id = $1`, [ORG_ID]);
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
  await setPoolPlatform(db, true);
});

test("the owner page: one switch for every club, no per-club list; a club admin who is not the owner gets a 404", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin");
  await page.waitForURL("**/admin");
  const res = await page.goto("/admin/clubs");
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId("pool-platform-switch")).toHaveCount(0);

  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await page.goto("/admin/clubs");
  const section = page.getByTestId("section-player-pool");
  await expect(section.getByRole("heading", { name: "Player pool" })).toBeVisible({ timeout: 30_000 });
  await expect(section.getByTestId("club-pool-row")).toHaveCount(0);
  await expect(section.getByRole("switch")).toHaveCount(1);
  const text = await section.innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toMatch(/\bfree\b/i);
  expect(text).not.toMatch(/waiting list/i);

  const sw = section.getByRole("switch", { name: "Player pool for every club" });
  await expect(sw).toHaveAttribute("aria-checked", "true");
  mkdirSync(SHOTS, { recursive: true });
  await section.screenshot({ path: path.join(SHOTS, "clubs-pool-platform-on.png") });

  await page.waitForLoadState("networkidle");
  await sw.click();
  await expect(page.getByText("Player pool off for every club.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => poolPlatformOn(db), { timeout: 15_000 }).toBe(false);

  await sw.click();
  await expect(page.getByText("Player pool on for every club. Each club's admins can now switch it on in their settings.")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => poolPlatformOn(db), { timeout: 15_000 }).toBe(true);
});

test("the platform switch off closes every open pool ask at once and hides the club's card", async ({ page, db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = true WHERE id = $1`, [ORG_ID]);
  const match = await db.one<{ id: string }>(
    `SELECT m.id FROM "Match" m JOIN "Activity" a ON a.id = m."activityId" WHERE a."orgId" = $1 ORDER BY m.date DESC LIMIT 1`,
    [ORG_ID],
  );
  await db.run(
    `INSERT INTO "PoolAsk" (id, "matchId", "orgId", places, status, via, "createdAt", "updatedAt") VALUES ('e2e-pool-ask-platform', $1, $2, 1, 'open', 'page', now(), now())`,
    [match!.id, ORG_ID],
  );
  await signInAs(page, U.admin, "/admin/clubs");
  const sw = page.getByTestId("section-player-pool").getByRole("switch", { name: "Player pool for every club" });
  await expect(sw).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await sw.click();
  await expect(page.getByText("Player pool off for every club. 1 open pool ask closed.")).toBeVisible({ timeout: 15_000 });
  const ask = await db.one<{ status: string; closeReason: string | null }>(`SELECT status, "closeReason" FROM "PoolAsk" WHERE id = 'e2e-pool-ask-platform'`);
  expect(ask?.status).not.toBe("open");
  expect(ask?.closeReason).toBe("switched-off");
  // The club's own choice is kept.
  expect(await flags(db)).toEqual({ pool: true, auto: false });

  // With the platform off, the club's admins see no pool card at all, even with the club's flag on.
  await openSettings(page, U.admin);
  await expect(page.getByTestId("player-pool")).toHaveCount(0);
  await expect(page.getByTestId("play-style")).toHaveCount(0);
  await expect(page.getByTestId("pool-auto-ask")).toHaveCount(0);
  await expect(page.getByTestId("pool-club-share")).toHaveCount(0);
});

test("the club's own card: on shows the pool cards and tells the admin team once; off asks, closes, keeps automatic asking", async ({ page, db }) => {
  await openSettings(page, U.admin);
  const card = page.getByTestId("player-pool");
  await expect(card.getByRole("heading", { name: "Player pool" })).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("info-setting-playerPool")).toBeVisible();
  const cardText = await card.innerText();
  expect(cardText).not.toMatch(/[—–]/);
  expect(cardText).not.toMatch(/\bfree\b/i);
  await expect(page.getByTestId("play-style")).toHaveCount(0);
  await expect(page.getByTestId("pool-auto-ask")).toHaveCount(0);

  const sw = page.getByRole("switch", { name: "Player pool", exact: true });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(page.getByText("Player pool on.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => flags(db), { timeout: 15_000 }).toEqual({ pool: true, auto: false });
  // The cards under it appear without a reload.
  await expect(page.getByTestId("play-style").getByRole("heading", { name: "Style of play" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("pool-auto-ask").getByRole("heading", { name: "Ask the player pool automatically" })).toBeVisible();
  mkdirSync(SHOTS, { recursive: true });
  await card.screenshot({ path: path.join(SHOTS, "settings-player-pool-on.png") });

  // The club is told once: no admin group here, so ONE post in its players' group, and no admin DM.
  await expect.poll(async () => (await noticeJobs(db)).length, { timeout: 15_000 }).toBe(1);
  const [job] = await noticeJobs(db);
  expect(job.kind).toBe("group");
  expect(job.text).toContain("⚽ *The MatchTime player pool is now on for E2E Test FC*");
  expect(job.text).toContain("*How to ask* (organisers only)");
  expect(await db.count(`SELECT count(*) FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND text LIKE '%player pool is now on%'`, [ORG_ID])).toBe(0);

  // The club turns automatic asking on, then the pool off: asked to confirm, auto kept.
  await db.run(`UPDATE "Organisation" SET "poolAutoAsk" = true WHERE id = $1`, [ORG_ID]);
  await page.waitForLoadState("networkidle");
  await sw.click();
  await expect(page.getByText("Player pool off.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => flags(db), { timeout: 15_000 }).toEqual({ pool: false, auto: true });
  await expect(page.getByTestId("play-style")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("pool-auto-ask")).toHaveCount(0);

  // On again: never told twice.
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });
  await expect.poll(() => flags(db), { timeout: 15_000 }).toEqual({ pool: true, auto: true });
  expect((await noticeJobs(db)).length).toBe(1);
});

test("an ADMIN who is not the owner can switch it; a player never sees it", async ({ page, db }) => {
  await db.run(`UPDATE "Membership" SET role = 'ADMIN' WHERE "userId" = $1 AND "orgId" = $2`, [U.collector, ORG_ID]);
  try {
    await openSettings(page, U.collector);
    const sw = page.getByRole("switch", { name: "Player pool", exact: true });
    await expect(sw).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });
    await sw.click();
    await expect.poll(() => flags(db), { timeout: 15_000 }).toEqual({ pool: true, auto: false });
  } finally {
    await db.run(`UPDATE "Membership" SET role = 'PLAYER' WHERE "userId" = $1 AND "orgId" = $2`, [U.collector, ORG_ID]);
  }

  await signInAs(page, U.player, "/admin/settings");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("player-pool")).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Player pool", exact: true })).toHaveCount(0);
});

test("the club's card in Turkish", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await openSettings(page, U.admin);
  const card = page.getByTestId("player-pool");
  await expect(card.getByRole("heading", { name: "Oyuncu havuzu" })).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("MatchTime kendiliğinden sorduğunda önce partner kulüplerinize sorulur.");
  await expect(page.getByRole("switch", { name: "Oyuncu havuzu", exact: true })).toHaveAttribute("aria-checked", "false");
});
