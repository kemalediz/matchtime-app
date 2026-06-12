/**
 * /profile/stats — the personal season-stats page every rating DM links
 * to. Renders for a seeded player with completed-match data (ratings
 * received, team assignment, MoM-eligible match) without erroring.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { NAME } from "../helpers/constants";

test.beforeAll(async () => {
  resetDb();
});

test("stats page renders for a player with season data", async ({ page }) => {
  await signInAs(page, U.rater, "/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });

  // Headline uses the player's first name; the page must not have bounced
  // to /profile (the no-stats fallback) or 500'd.
  await expect(page.getByText(NAME.rater.split(" ")[0], { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/Man of the Match|season|rating/i).first()).toBeVisible();
});

test("guest with no phone can still view stats via a magic link", async ({ page }) => {
  await signInAs(page, U.guest, "/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });
  await expect(page.getByText(NAME.guest.split(" ")[0], { exact: false }).first()).toBeVisible();
});
