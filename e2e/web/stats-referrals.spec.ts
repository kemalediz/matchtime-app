/**
 * The stats page's "Players brought to the game: N" card (player pool,
 * growth slice G4), in a real browser at phone width. Riley Rater is in
 * the pool; friends who signed up with his link and have played count.
 *
 *   - nobody brought: no card at all (live clubs see nothing new);
 *   - one friend played (a second only signed up): "Players brought to the
 *     game: 1" and Recruiter;
 *   - three: Recruiter and Scout; kept private: still shown on his own
 *     page, with a line saying the group is not told.
 * No model: $0.
 */
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { poolReferralCopy } from "@/lib/i18n/pool-referral";

const EN = poolReferralCopy("en");
const MOBILE = { width: 375, height: 740 };

test.describe.configure({ mode: "serial" });

async function poolProfile(db: TestDb, userId: string, opts: { referrer?: string; counted?: boolean; showRecognition?: boolean } = {}): Promise<void> {
  await db.run(
    `INSERT INTO "PoolProfile" (id, "userId", status, "consentAt", "consentVersion", "consentChannel", "consentEvidence", "adultConfirmedAt", language,
       "displayName", "areaDistrict", "areaLat", "areaLng", "maxMiles", source, "referrerUserId", "referralCountedAt", "showRecognition", "updatedAt")
     VALUES ($1, $2, 'active', now(), 1, 'web', 'e2e', now(), 'en', 'E2E Person', 'SM3', 51.36, -0.19, 3, $3, $4, $5, $6, now())`,
    [`e2e-ref-p-${userId}`, userId, opts.referrer ? "referral" : "profile", opts.referrer ?? null, opts.counted ? new Date() : null, opts.showRecognition !== false],
  );
}

async function friend(db: TestDb, key: string, counted: boolean): Promise<void> {
  const id = `e2e-ref-friend-${key}`;
  await db.run(`INSERT INTO "User" (id, name, email, onboarded, "isActive", "updatedAt") VALUES ($1, $2, $3, true, true, now())`, [id, `Friend ${key}`, `${id}@e2e.test`]);
  await poolProfile(db, id, { referrer: U.rater, counted });
}

test.beforeEach(() => {
  resetDb();
});

test("nobody brought by him: no card", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await signInAs(page, U.rater, "/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });
  await expect(page.getByText("Badges", { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId("referral-card")).toHaveCount(0);
});

test("one friend played, another only signed up: 1 player and Recruiter", async ({ page, db }) => {
  await poolProfile(db, U.rater);
  await friend(db, "a", true);
  await friend(db, "b", false);
  await page.setViewportSize(MOBILE);
  await signInAs(page, U.rater, "/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });

  const card = page.getByTestId("referral-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("referral-count")).toHaveText(EN.statsCount(1));
  await expect(card.getByTestId("referral-badge")).toHaveCount(1);
  await expect(card.getByTestId("referral-badge")).toContainText("Recruiter");
  await expect(card.getByTestId("referral-badge")).toContainText(EN.badgeHint(1));
  await expect(card.getByTestId("referral-private")).toHaveCount(0);
  // No horizontal scroll at phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("three friends, kept private: Recruiter and Scout on his own page, and the group is not told", async ({ page, db }) => {
  await poolProfile(db, U.rater, { showRecognition: false });
  for (const k of ["c", "d", "e"]) await friend(db, k, true);
  await page.setViewportSize(MOBILE);
  await signInAs(page, U.rater, "/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });

  const card = page.getByTestId("referral-card");
  await expect(card.getByTestId("referral-count")).toHaveText(EN.statsCount(3));
  await expect(card.getByTestId("referral-badge")).toHaveCount(2);
  await expect(card.getByTestId("referral-badge").nth(1)).toContainText("Scout");
  await expect(card.getByTestId("referral-private")).toHaveText(EN.statsPrivate);
});
