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

  // Riley has exactly two ratings at this club, so the number is real
  // but thin, and the page has to say so.
  await expect(page.getByText("Your rating at", { exact: false }).first()).toBeVisible();
  await expect(
    page.getByText("From this club's ratings only", { exact: false }).first(),
  ).toBeVisible();
  await expect(page.getByText(/Provisional: 2 ratings/).first()).toBeVisible();
  await expect(page.getByText(/will move a lot as more arrive/).first()).toBeVisible();
});

/**
 * Kemal, 2026-09-19: "whatever ratings are given the player should see
 * but yeah for team setup shrunk number should be used initially".
 *
 * Riley was given an 8 and a 7, so he is shown 7.5. The balancer reads
 * those same two scores shrunk toward the club's mean of 6.33, which is
 * 6.8, and that number must not appear anywhere on his page. The
 * fixture's third rating (Pat's 4) exists to hold the two apart.
 */
test("the number shown is what the club gave him, not the number that picks the teams", async ({ page }) => {
  await signInAs(page, U.rater, "/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });

  await expect(page.getByText("7.5", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("6.8", { exact: false })).toHaveCount(0);
});

/**
 * And the sentence that pre-empts "it says I'm 9, why am I on the
 * weaker team". It appears exactly while the two numbers differ.
 */
test("the page explains that teams are built cautiously on one or two ratings", async ({ page }) => {
  await signInAs(page, U.rater, "/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });
  await expect(
    page.getByText(/careful with it when picking teams/).first(),
  ).toBeVisible();
});

test("a player this club has never rated is shown the empty state, not an average", async ({ page }) => {
  await signInAs(page, U.guest, "/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });
  await expect(page.getByText("No ratings at this club yet", { exact: false }).first()).toBeVisible();
});

test("the dashboard tile is the CLUB rating, and it is the raw one", async ({ page }) => {
  await signInAs(page, U.rater, "/");
  await page.waitForURL(/\/$/, { timeout: 30_000 });
  // The tile used to be labelled "Rating" while showing a number blended
  // across every club the player was in.
  await expect(page.getByText("Club rating", { exact: false }).first()).toBeVisible();
  // Riley's own two scores average 7.5. The balancer's 6.8 belongs to
  // the team sheet and has no business on a dashboard.
  await expect(page.getByText("7.5", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("6.8", { exact: false })).toHaveCount(0);
});
