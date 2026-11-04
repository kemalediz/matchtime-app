/**
 * Every door honours the club's switches, in a real browser (club summary,
 * slice B7; decision K4, Kemal 2026-11-04). No model.
 *
 *   - attendance off: the match page has no "I'm in!" button and says the
 *     club doesn't take sign-ups through MatchTime; on: the button, as before.
 *   - player ratings off: the rate page says there's nothing to rate, and
 *     no rating is saved.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
  resetDb();
});

test("attendance on: the IN button, as before", async ({ page }) => {
  await signInAs(page, U.player, undefined);
  await page.goto(`/matches/${MATCH.upcoming}`);
  await expect(page.getByRole("button", { name: /I'm in!|Drop out/ }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("attendance-off")).toHaveCount(0);
});

test("attendance off (K4): no IN or OUT on the website, and the page says why", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET "featureAttendance" = false WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.player, undefined);
  await page.goto(`/matches/${MATCH.upcoming}`);
  await expect(page.getByTestId("attendance-off")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("attendance-off")).toContainText("doesn't take sign-ups through MatchTime");
  await expect(page.getByRole("button", { name: /I'm in!|Drop out/ })).toHaveCount(0);
});

test("player ratings off: the rate page says there's nothing to rate", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET "featurePlayerRating" = false WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.rater, undefined);
  await page.goto(`/matches/${MATCH.rate}/rate`);
  await expect(page.getByTestId("rate-off")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("rate-off")).toContainText("nothing to rate here");
  await expect(page.getByRole("button", { name: /submit/i })).toHaveCount(0);
  const n = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM "Rating" WHERE "matchId" = $1 AND "raterId" = $2`, [MATCH.rate, U.rater]);
  expect(n?.n).toBe(0);
});
