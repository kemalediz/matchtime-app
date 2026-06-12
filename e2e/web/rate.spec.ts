/**
 * Rate page (/matches/[matchId]/rate).
 *
 *   - submit ratings + MoM as a confirmed player → rows land, redirect
 *     to /profile/stats
 *   - STALE-PLAYER GUARD (P2003 Rating_playerId_fkey regression,
 *     2026-06-11): a player listed on the open page is merged/deleted
 *     before submit — submission must still succeed for everyone else,
 *     never 500.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, NAME } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

test("confirmed player submits ratings + MoM and lands on their stats", async ({ page, db }) => {
  await signInAs(page, U.rater, undefined);
  await page.goto(`/matches/${MATCH.rate}/rate`);

  // Self is excluded; the other four confirmed players are listed.
  // (Scoped to main — the sidebar shows the signed-in user's own name.)
  const main = page.getByRole("main");
  await expect(main.getByText(NAME.player).first()).toBeVisible({ timeout: 30_000 });
  await expect(main.getByText(NAME.rater)).toHaveCount(0);

  // Score Pat an 8 (his card's "8" button), leave others at default 6.
  const patCard = page
    .locator("div.bg-white")
    .filter({ hasText: NAME.player })
    .filter({ has: page.getByRole("button", { name: "8", exact: true }) })
    .first();
  await patCard.getByRole("button", { name: "8", exact: true }).click();

  // Pick Pat as Man of the Match — the MoM card is the amber-bordered
  // section (anchoring on text alone matches the page subtitle instead).
  await page
    .locator("div.border-amber-200")
    .getByRole("button", { name: new RegExp(NAME.player) })
    .first()
    .click();

  await page.getByRole("button", { name: /submit/i }).click();
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });

  const ratings = await db.all<{ playerId: string; score: number }>(
    `SELECT "playerId", score FROM "Rating" WHERE "matchId" = $1 AND "raterId" = $2`,
    [MATCH.rate, U.rater],
  );
  expect(ratings.length).toBe(4); // player, third, stale, opt
  expect(ratings.find((r) => r.playerId === U.player)?.score).toBe(8);

  const mom = await db.one<{ playerId: string }>(
    `SELECT "playerId" FROM "MoMVote" WHERE "matchId" = $1 AND "voterId" = $2`,
    [MATCH.rate, U.rater],
  );
  expect(mom?.playerId).toBe(U.player);
});

test("stale playerId guard: a player deleted after page load must not 500 the submission", async ({ page, db }) => {
  // Fresh state so Riley has no ratings yet this time.
  resetDb();

  await signInAs(page, U.rater, undefined);
  await page.goto(`/matches/${MATCH.rate}/rate`);
  await expect(page.getByText(NAME.stale).first()).toBeVisible({ timeout: 30_000 });

  // While the page sits open, an admin merges/deletes Sam Stale —
  // exactly the race that produced P2003 Rating_playerId_fkey.
  await db.run(`DELETE FROM "Rating" WHERE "playerId" = $1 OR "raterId" = $1`, [U.stale]);
  await db.run(`DELETE FROM "TeamAssignment" WHERE "userId" = $1`, [U.stale]);
  await db.run(`DELETE FROM "Attendance" WHERE "userId" = $1`, [U.stale]);
  await db.run(`DELETE FROM "User" WHERE id = $1`, [U.stale]);

  await page.getByRole("button", { name: /submit/i }).click();

  // The submission must SUCCEED (survivors' ratings land) — not 500.
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });
  const ratings = await db.all<{ playerId: string }>(
    `SELECT "playerId" FROM "Rating" WHERE "matchId" = $1 AND "raterId" = $2`,
    [MATCH.rate, U.rater],
  );
  expect(ratings.map((r) => r.playerId).sort()).toEqual([U.opt, U.player, U.third].sort());
});
