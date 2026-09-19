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

/**
 * Slice 6 of MDs/club-scoped-ratings-design-2026-09-18.md. There are two
 * ratings now and the page has to say which is which. The fixture world
 * is a good test of it by accident: no membership carries a seed, so
 * every player here is in the state every member created since slice 4
 * is in, with no global seed to fall back on.
 */
test("the stats page names the club rating and says where it comes from", async ({ page }) => {
  await signInAs(page, U.rater, "/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });

  // Riley has exactly two ratings at this club, so the prior still
  // outweighs them and the page must say so rather than show a bare
  // shrunk number.
  await expect(page.getByText("Your rating at", { exact: false }).first()).toBeVisible();
  await expect(
    page.getByText("From this club's ratings only", { exact: false }).first(),
  ).toBeVisible();
  await expect(page.getByText(/Provisional: 2 ratings/).first()).toBeVisible();
});

test("a player this club has never rated is shown the empty state, not an average", async ({ page }) => {
  await signInAs(page, U.guest, "/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });
  await expect(page.getByText("No ratings at this club yet", { exact: false }).first()).toBeVisible();
});

test("the dashboard tile is the CLUB rating", async ({ page }) => {
  await signInAs(page, U.rater, "/");
  await page.waitForURL(/\/$/, { timeout: 30_000 });
  // The tile used to be labelled "Rating" while showing a number blended
  // across every club the player was in.
  await expect(page.getByText("Club rating", { exact: false }).first()).toBeVisible();
});
