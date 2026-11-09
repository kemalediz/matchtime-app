/**
 * SEEDS ARE NEVER ROUNDED (Kemal, 2026-11-09): "keep the ratings as they
 * are, never round them". A seed carried at full precision (Mustafa at
 * the Vets: 6.41666666666667) is shown to two places, "6.42", and:
 *
 *   - viewing it, or tabbing through the box, writes nothing: the stored
 *     value stays 6.41666666666667, on /admin/players and on the
 *     "Starting ratings" page alike
 *   - an admin can still type a whole number (7) or a decimal (6.5), and
 *     it is saved exactly as typed
 *   - an unseeded player's prefilled 6 is never written
 *
 * The isolated e2e database. No model calls.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { NAME, ORG_ID } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const EXACT = 6.41666666666667;

const seedOf = async (db: TestDb, userId: string) =>
  (await db.one<{ seedRating: number | null }>(`SELECT "seedRating" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`, [userId, ORG_ID]))
    ?.seedRating ?? null;

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Membership" SET "seedRating" = $1 WHERE "userId" = $2 AND "orgId" = $3`, [EXACT, U.player, ORG_ID]);
});

test.afterAll(() => {
  resetDb();
});

test("/admin/players shows a decimal seed as 6.42 and leaving it keeps 6.41666666666667", async ({ page, db }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInAs(page, U.admin, "/admin/players");
  const box = page.getByTestId(`player-row-${U.player}`).locator('input[type="number"]');
  await expect(box).toHaveValue("6.42", { timeout: 30_000 });

  await box.focus();
  await box.blur();
  await page.waitForTimeout(800);
  expect(await seedOf(db, U.player)).toBe(EXACT);

  // A whole number still works, saved as typed.
  await box.fill("7");
  await box.blur();
  await expect.poll(() => seedOf(db, U.player)).toBe(7);

  // So does a decimal.
  await box.fill("6.5");
  await box.blur();
  await expect.poll(() => seedOf(db, U.player)).toBe(6.5);

  await db.run(`UPDATE "Membership" SET "seedRating" = $1 WHERE "userId" = $2 AND "orgId" = $3`, [EXACT, U.player, ORG_ID]);
});

test("the Starting ratings page shows 6.42, saves nothing untouched, and a typed 6.5 is saved as 6.5", async ({ page, db }) => {
  expect(await seedOf(db, U.player)).toBe(EXACT);
  expect(await seedOf(db, U.rater)).toBeNull();

  await signInAs(page, U.admin, "/admin/players/ratings");
  await expect(page.getByTestId("seed-default-hint")).toBeVisible({ timeout: 30_000 });
  const boxOf = (name: string) => page.locator("li").filter({ hasText: name }).locator('input[type="number"]');
  await expect(boxOf(NAME.player)).toHaveValue("6.42");
  await expect(boxOf(NAME.rater)).toHaveValue("6");

  for (const name of [NAME.player, NAME.rater]) {
    await boxOf(name).focus();
    await boxOf(name).blur();
  }
  await page.waitForTimeout(1500);
  expect(await seedOf(db, U.player)).toBe(EXACT);
  expect(await seedOf(db, U.rater)).toBeNull();

  await boxOf(NAME.rater).fill("6.5");
  await boxOf(NAME.rater).blur();
  await expect(page.locator("li").filter({ hasText: NAME.rater }).getByText("Saved")).toBeVisible();
  await expect.poll(() => seedOf(db, U.rater)).toBe(6.5);
  expect(await seedOf(db, U.player)).toBe(EXACT);
});
