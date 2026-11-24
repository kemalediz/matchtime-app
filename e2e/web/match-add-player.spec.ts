/**
 * Match page: "Add a player to this match" (FNF 2026-11-23, review of #631).
 *
 * A typed full name that shares only a first name with a member is a new
 * player, as the form promises ("No match ... so this creates a new
 * player"); it is never quietly taken for the member.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, NAME } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

test("a full name that only shares a first name adds a new player", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInAs(page, U.admin, `/matches/${MATCH.upcoming}`);
  await page.waitForURL(`**/matches/${MATCH.upcoming}`);

  await page.getByRole("button", { name: /add player/i }).first().click();
  const box = page.getByPlaceholder(/search existing players/i);
  await box.fill("Riley Newcombe");
  await expect(page.getByText(/so this creates a new player/i)).toBeVisible();
  await page.getByRole("button", { name: /^add$/i }).click();

  await expect(page.getByText("Riley Newcombe").first()).toBeVisible({ timeout: 30_000 });
  // The member who shares the first name was not put in instead.
  expect(NAME.rater).toBe("Riley Rater");
});
