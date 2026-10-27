/**
 * The platform owner's "Player pool" switch on /admin/clubs (2026-10-27):
 *
 *   - every approved club has a row, the seeded one (Sutton FC's shape,
 *     which predates self-join) included, with a line saying what it does;
 *   - switched on, the club's /admin/settings shows Style of play and
 *     "Ask the player pool automatically" (automatic asking still off);
 *   - switched off, both are gone again, and `poolAutoAsk` is left as it is;
 *   - a club admin who is not the owner never sees the page (404).
 *
 * The screenshot of the row goes to MT_SHOTS_DIR, else .e2e/test-results.
 * No model calls.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { REPO_ROOT } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const SHOTS = process.env.MT_SHOTS_DIR ?? path.join(REPO_ROOT, ".e2e", "test-results", "pool-switch-shots");

async function flags(db: TestDb) {
  return db.one<{ pool: boolean; auto: boolean }>(`SELECT "featurePlayerPool" AS pool, "poolAutoAsk" AS auto FROM "Organisation" WHERE id = $1`, [ORG_ID]);
}

test.beforeAll(() => {
  resetDb();
});

test.afterAll(() => {
  resetDb();
});

test.beforeEach(async ({ page, db }) => {
  // Switching OFF asks the owner to confirm.
  page.on("dialog", (d) => void d.accept());
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = false, "poolAutoAsk" = false, language = 'en' WHERE id = $1`, [ORG_ID]);
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
});

test("a club admin who is not the owner cannot reach the switch", async ({ page }) => {
  await signInAs(page, U.admin, "/admin");
  await page.waitForURL("**/admin");
  const res = await page.goto("/admin/clubs");
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId("club-pool-switch")).toHaveCount(0);
});

test("the owner switches the pool on, the club's settings show it; off, they are gone", async ({ page, db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);

  // Off: the club's settings have no pool cards.
  await signInAs(page, U.admin, "/admin/settings");
  await expect(page.getByTestId("weekly-routine")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("play-style")).toHaveCount(0);
  await expect(page.getByTestId("pool-auto-ask")).toHaveCount(0);

  await page.goto("/admin/clubs");
  const section = page.getByTestId("section-player-pool");
  await expect(section.getByRole("heading", { name: "Player pool" })).toBeVisible({ timeout: 30_000 });
  const row = section.getByTestId("club-pool-row").filter({ hasText: "E2E Test FC" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(
    "On: the club's admins see Style of play, Ask the player pool automatically and the MatchTime player pool tick on the match page, and organisers can ask the pool from HQ. Automatic asking stays off until the club's admin turns it on.",
  );
  const text = await section.innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toMatch(/\bfree\b/i);
  expect(text).not.toMatch(/waiting list/i);

  const sw = row.getByRole("switch", { name: "Player pool: E2E Test FC" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await page.waitForLoadState("networkidle");
  await sw.click();
  await expect(page.getByText("Player pool on. Automatic asking stays off until the club's admin turns it on.")).toBeVisible({ timeout: 15_000 });
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => flags(db), { timeout: 15_000 }).toEqual({ pool: true, auto: false });

  mkdirSync(SHOTS, { recursive: true });
  await row.screenshot({ path: path.join(SHOTS, "clubs-pool-row-on.png") });
  await section.screenshot({ path: path.join(SHOTS, "clubs-pool-section.png") });

  await page.goto("/admin/settings");
  await expect(page.getByTestId("play-style").getByRole("heading", { name: "Style of play" })).toBeVisible({ timeout: 30_000 });
  const auto = page.getByTestId("pool-auto-ask");
  await expect(auto.getByRole("heading", { name: "Ask the player pool automatically" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Ask the player pool automatically" })).toHaveAttribute("aria-checked", "false");

  // The club's admin turns automatic asking on; the owner then turns the pool off.
  await db.run(`UPDATE "Organisation" SET "poolAutoAsk" = true WHERE id = $1`, [ORG_ID]);
  await page.goto("/admin/clubs");
  const rowAgain = page.getByTestId("section-player-pool").getByTestId("club-pool-row").filter({ hasText: "E2E Test FC" });
  const swAgain = rowAgain.getByRole("switch", { name: "Player pool: E2E Test FC" });
  await expect(swAgain).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await swAgain.click();
  await expect(page.getByText("Player pool off.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(swAgain).toHaveAttribute("aria-checked", "false");
  // Off leaves the club's own automatic asking choice as it is.
  await expect.poll(() => flags(db), { timeout: 15_000 }).toEqual({ pool: false, auto: true });

  await page.goto("/admin/settings");
  await expect(page.getByTestId("weekly-routine")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("play-style")).toHaveCount(0);
  await expect(page.getByTestId("pool-auto-ask")).toHaveCount(0);
  await expect(page.getByText("Ask the player pool automatically")).toHaveCount(0);
});

test("switching off closes the club's open pool ask at once", async ({ page, db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = true WHERE id = $1`, [ORG_ID]);
  const match = await db.one<{ id: string }>(
    `SELECT m.id FROM "Match" m JOIN "Activity" a ON a.id = m."activityId" WHERE a."orgId" = $1 ORDER BY m.date DESC LIMIT 1`,
    [ORG_ID],
  );
  await db.run(
    `INSERT INTO "PoolAsk" (id, "matchId", "orgId", places, status, via, "createdAt", "updatedAt") VALUES ('e2e-pool-ask-switch', $1, $2, 1, 'open', 'page', now(), now())`,
    [match!.id, ORG_ID],
  );

  await signInAs(page, U.admin, "/admin/clubs");
  const row = page.getByTestId("section-player-pool").getByTestId("club-pool-row").filter({ hasText: "E2E Test FC" });
  const sw = row.getByRole("switch", { name: "Player pool: E2E Test FC" });
  await expect(sw).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await sw.click();
  await expect(page.getByText("Player pool off. 1 open pool ask closed.")).toBeVisible({ timeout: 15_000 });
  const ask = await db.one<{ status: string; closeReason: string | null; closedAt: Date | null }>(
    `SELECT status, "closeReason", "closedAt" FROM "PoolAsk" WHERE id = 'e2e-pool-ask-switch'`,
  );
  expect(ask?.status).not.toBe("open");
  expect(ask?.closeReason).toBe("switched-off");
  expect(ask?.closedAt).not.toBeNull();
});
