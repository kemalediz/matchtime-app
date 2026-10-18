/**
 * "Man of the Match chosen by: organisers pick" (2026-10-18) on the web:
 * the rate page offers no Man of the Match vote (players only rate each
 * other), and the organisers' pick wears the same crown on the player's
 * stats as a voted Man of the Match.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, NAME, ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "momChosenBy" = 'organisers' WHERE id = $1`, [ORG_ID]);
});

test.afterAll(async () => {
  resetDb();
});

test("the rate page has no Man of the Match vote, and submitting writes no vote", async ({ page, db }) => {
  await signInAs(page, U.rater, undefined);
  await page.goto(`/matches/${MATCH.rate}/rate`);
  const main = page.getByRole("main");
  await expect(main.getByText(NAME.player).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Tap a score for each player.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("mom-vote")).toHaveCount(0);
  await expect(page.locator("div.border-amber-200")).toHaveCount(0);

  await page.getByRole("button", { name: /submit/i }).click();
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });
  expect(await db.count(`SELECT COUNT(*) FROM "Rating" WHERE "matchId" = $1 AND "raterId" = $2`, [MATCH.rate, U.rater])).toBeGreaterThan(0);
  expect(await db.count(`SELECT COUNT(*) FROM "MoMVote" WHERE "matchId" = $1`, [MATCH.rate])).toBe(0);
});

test("the organisers' pick gives the player the Man of the Match crown on their stats", async ({ page, db }) => {
  // What `setMatchMom` writes for an organiser's pick: one MoMVote, by the organiser.
  await db.run(`INSERT INTO "MoMVote" (id, "matchId", "voterId", "playerId") VALUES ('e2e-web-pick', $1, $2, $3)`, [MATCH.rate, U.admin, U.rater]);
  await signInAs(page, U.rater, "/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });
  // The season tile: the count of MoM wins and the crown, as for a vote.
  const tile = page.locator("div.rounded-2xl").filter({ has: page.getByText("Man of the Match", { exact: true }) }).first();
  await expect(tile).toBeVisible();
  await expect(tile.locator("div").first()).toHaveText("1");
  await expect(tile).toContainText("👑");
});
