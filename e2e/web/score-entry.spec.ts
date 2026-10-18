/**
 * Entering a played match's score from the dashboard (FNF, 2026-10-18).
 *
 * FNF's owner opened Fri 16 Oct (COMPLETED, no score) from Recent
 * results > View all > Past and found nowhere to enter the result: the
 * match page linked to the score box only for a match still to come.
 *
 *   - the Past tab marks an unscored match with "Add score" (admins only);
 *   - the match page shows "Enter score" on a COMPLETED unscored match,
 *     it opens the score box, and saving it stores the result;
 *   - with a score the button reads "Edit score";
 *   - a match played with teams only GENERATED (FNF posts its teams in
 *     WhatsApp and never publishes) still gets the score box;
 *   - a player sees none of it.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  resetDb();
});

test.afterAll(() => {
  resetDb();
});

const score = async (db: import("../helpers/test-db").TestDb, id: string) =>
  db.one<{ status: string; red: number | null; yellow: number | null }>(
    `SELECT status::text AS status, "redScore" AS red, "yellowScore" AS yellow FROM "Match" WHERE id = $1`,
    [id],
  );

test("Past tab: an admin sees Add score on the unscored match, the score on the scored one", async ({ page }) => {
  await signInAs(page, U.admin, "/matches");
  await page.getByRole("button", { name: /^Past/ }).click();
  const rows = page.getByTestId("past-result");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  // The PAY match is COMPLETED with no score; the RATE match is 3-2.
  const add = page.locator(`[data-testid="result-add-score"][href="/admin/matches/${MATCH.pay}/teams#score"]`);
  await expect(add).toHaveCount(1);
  await expect(add).toHaveText("Add score");
  await expect(page.locator(`[data-testid="result-add-score"][href*="${MATCH.rate}"]`)).toHaveCount(0);
  // The row's own link still opens the match page.
  await expect(page.locator(`[data-testid="past-result"] a[href="/matches/${MATCH.rate}"]`)).toHaveCount(1);
});

test("dashboard Recent results: the same Add score for an admin", async ({ page }) => {
  await signInAs(page, U.admin, "/");
  await expect(page.getByTestId("recent-result").first()).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator(`[data-testid="recent-result"] [data-testid="result-add-score"][href="/admin/matches/${MATCH.pay}/teams#score"]`),
  ).toHaveText("Add score");
});

test("match page: Enter score on a COMPLETED unscored match opens the box, and Save stores it", async ({ page, db }) => {
  expect(await score(db, MATCH.pay)).toEqual({ status: "COMPLETED", red: null, yellow: null });

  await signInAs(page, U.admin, `/matches/${MATCH.pay}`);
  const link = page.getByTestId("score-entry-link");
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(link).toHaveText("Enter score");
  await link.click();

  await expect(page).toHaveURL(new RegExp(`/admin/matches/${MATCH.pay}/teams#score$`));
  const box = page.getByTestId("score-section");
  await expect(box).toBeVisible({ timeout: 30_000 });
  await box.locator('input[type="number"]').nth(0).fill("4");
  await box.locator('input[type="number"]').nth(1).fill("2");
  await box.getByRole("button", { name: "Save score" }).click();

  await expect.poll(() => score(db, MATCH.pay)).toEqual({ status: "COMPLETED", red: 4, yellow: 2 });

  await page.goto(`/matches/${MATCH.pay}`);
  await expect(page.getByTestId("score-entry-link")).toHaveText("Edit score", { timeout: 30_000 });
});

test("a played match whose teams were generated but never published still gets the score box", async ({ page, db }) => {
  // The UPCOMING match, moved to an hour ago with teams generated: what a
  // WhatsApp-teams club looks like between kickoff and auto-completion.
  await db.run(
    `UPDATE "Match" SET status = 'TEAMS_GENERATED', date = now() - interval '1 hour', "attendanceDeadline" = now() - interval '6 hours' WHERE id = $1`,
    [MATCH.upcoming],
  );
  await signInAs(page, U.admin, `/matches/${MATCH.upcoming}`);
  const link = page.getByTestId("score-entry-link");
  await expect(link).toHaveText("Enter score", { timeout: 30_000 });
  await link.click();
  await expect(page.getByTestId("score-section")).toBeVisible({ timeout: 30_000 });
});

test("a cancelled match offers no score", async ({ page, db }) => {
  await db.run(`UPDATE "Match" SET status = 'CANCELLED' WHERE id = $1`, [MATCH.upcoming]);
  await signInAs(page, U.admin, `/matches/${MATCH.upcoming}`);
  await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("score-entry-link")).toHaveCount(0);
});

test("a player sees no score buttons", async ({ page }) => {
  resetDb();
  await signInAs(page, U.player, `/matches/${MATCH.pay}`);
  await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("score-entry-link")).toHaveCount(0);

  await page.goto("/matches");
  await page.getByRole("button", { name: /^Past/ }).click();
  await expect(page.getByTestId("past-result").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("result-add-score")).toHaveCount(0);
});

// ── The result and the admin actions sit at the TOP (Kemal, 2026-10-18) ──
// "Enter score" and "who's paid" used to sit below the team sheets and the
// full attendance list, so an admin on a phone had to scroll a long way to
// find them. On a played match they now sit in the result bar right under
// the header, and each action appears once on the page.

const SHOT_DIR = process.env.SCORE_TOP_SHOTS ?? "test-results/score-top";

/** True when `a` comes before `b` in DOM order. */
const before = (page: import("@playwright/test").Page, a: string, b: string) =>
  page.evaluate(
    ([sa, sb]) => {
      const ea = document.querySelector(sa);
      const eb = document.querySelector(sb);
      if (!ea || !eb) return false;
      return !!(ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING);
    },
    [a, b],
  );

test("top bar: an admin on a played unscored match sees Enter score and who's paid above the attendance list", async ({ page }) => {
  resetDb();
  await signInAs(page, U.admin, `/matches/${MATCH.pay}`);
  const bar = page.getByTestId("match-result-bar");
  await expect(bar).toBeVisible({ timeout: 30_000 });
  const enter = bar.getByTestId("score-entry-link");
  await expect(enter).toHaveText("Enter score");
  await expect(bar.getByTestId("payments-link")).toBeVisible();
  // Each action once on the page.
  await expect(page.getByTestId("score-entry-link")).toHaveCount(1);
  await expect(page.getByTestId("payments-link")).toHaveCount(1);
  await expect(bar.getByTestId("match-result")).toHaveCount(0);
  expect(await before(page, '[data-testid="match-result-bar"]', '[data-testid="attendance-section"]')).toBe(true);
});

test("top bar: an admin on a scored match sees the result with the team labels and Edit score, above the teams", async ({ page }) => {
  await signInAs(page, U.admin, `/matches/${MATCH.rate}`);
  const bar = page.getByTestId("match-result-bar");
  await expect(bar).toBeVisible({ timeout: 30_000 });
  const result = bar.getByTestId("match-result");
  await expect(result).toBeVisible();
  await expect(result.getByTestId("result-red-label")).toHaveText("Red");
  await expect(result.getByTestId("result-yellow-label")).toHaveText("Yellow");
  await expect(result.getByTestId("result-red-score")).toHaveText("3");
  await expect(result.getByTestId("result-yellow-score")).toHaveText("2");
  await expect(bar.getByTestId("score-entry-link")).toHaveText("Edit score");
  await expect(page.getByTestId("score-entry-link")).toHaveCount(1);
  await expect(page.getByTestId("payments-link")).toHaveCount(1);
  expect(await before(page, '[data-testid="match-result-bar"]', '[data-testid="teams-section"]')).toBe(true);
});

test("top bar: a player sees the result but no admin buttons, and rates from the top", async ({ page }) => {
  await signInAs(page, U.player, `/matches/${MATCH.rate}`);
  const bar = page.getByTestId("match-result-bar");
  await expect(bar.getByTestId("match-result")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("score-entry-link")).toHaveCount(0);
  await expect(page.getByTestId("payments-link")).toHaveCount(0);
  const rateHref = `a[href="/matches/${MATCH.rate}/rate"]`;
  await expect(page.locator(rateHref)).toHaveCount(1);
  await expect(bar.locator(rateHref)).toBeVisible();
});

test("an upcoming match keeps its layout: no result bar, who's paid once at the bottom", async ({ page }) => {
  await signInAs(page, U.admin, `/matches/${MATCH.upcoming}`);
  await expect(page.getByTestId("attendance-section")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("match-result-bar")).toHaveCount(0);
  await expect(page.getByTestId("payments-link")).toHaveCount(1);
});

test("at phone width (390px) the result bar fits, sits above the teams, and the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, U.admin, `/matches/${MATCH.rate}`);
  const bar = page.getByTestId("match-result-bar");
  await expect(bar).toBeVisible({ timeout: 30_000 });
  const edit = bar.getByTestId("score-entry-link");
  await expect(edit).toBeInViewport();
  await expect(bar.getByTestId("payments-link")).toBeInViewport();
  const box = await bar.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollW).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${SHOT_DIR}/match-scored-390.png`, fullPage: true });

  await page.goto(`/matches/${MATCH.pay}`);
  await expect(page.getByTestId("match-result-bar").getByTestId("score-entry-link")).toBeInViewport({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOT_DIR}/match-unscored-390.png`, fullPage: true });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/matches/${MATCH.rate}`);
  await expect(page.getByTestId("match-result-bar")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOT_DIR}/match-scored-desktop.png`, fullPage: true });
  await page.goto(`/matches/${MATCH.pay}`);
  await expect(page.getByTestId("match-result-bar")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOT_DIR}/match-unscored-desktop.png`, fullPage: true });
});
