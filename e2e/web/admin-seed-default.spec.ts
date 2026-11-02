/**
 * THE DEFAULT SEED IS 6 (Kemal, 2026-11-02): "so it gives the admins a
 * measurement for medium kind of players".
 *
 *   - /admin/players: a player nobody has seeded shows 6 in the Seed box,
 *     and the page says what the 6 means
 *   - tabbing through that 6 writes nothing: the seed stays NULL ("not set
 *     by an admin"), which is still read as 6 everywhere
 *   - /admin/players/ratings, the "Starting ratings" link new organisers
 *     are sent: every unseeded player shows 6; changing one to 8 saves 8,
 *     and the untouched ones stay NULL
 *
 * The fixture seeds no `Membership.seedRating` at all (e2e/helpers/seed.ts).
 * No model call anywhere.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { NAME, ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

async function seedOf(db: { one: <T>(sql: string, p?: unknown[]) => Promise<T | null> }, userId: string) {
  const row = await db.one<{ seedRating: number | null }>(
    `SELECT "seedRating" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`,
    [userId, ORG_ID],
  );
  return row?.seedRating ?? null;
}

test("/admin/players shows 6 for an unseeded player, and leaving it writes nothing", async ({ page, db }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await seedOf(db, U.walt)).toBeNull();

  await signInAs(page, U.admin, "/admin/players");
  await page.waitForURL("**/admin/players");
  await expect(page.locator(`input[value="${NAME.walt}"]`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("seed-default-hint").first()).toContainText(
    "A player nobody has rated starts at 6, a medium player.",
  );

  const row = page
    .locator("div")
    .filter({ has: page.locator(`input[value="${NAME.walt}"]`) })
    .filter({ has: page.getByTestId("club-rating") })
    .last();
  const seed = row.locator('input[type="number"]');
  await expect(seed).toHaveValue("6");

  await seed.focus();
  await seed.blur();
  // Give a stray save time to land before reading the row back.
  await page.waitForTimeout(800);
  expect(await seedOf(db, U.walt)).toBeNull();
});

test("the Starting ratings page shows 6 for every unseeded player; a change saves, the rest stay unset", async ({
  page,
  db,
}) => {
  expect(await seedOf(db, U.rater)).toBeNull();
  expect(await seedOf(db, U.player)).toBeNull();

  await signInAs(page, U.admin, "/admin/players/ratings");
  await page.waitForURL("**/admin/players/ratings");
  await expect(page.getByTestId("seed-default-hint")).toBeVisible({ timeout: 30_000 });

  const boxOf = (name: string) => page.locator("li").filter({ hasText: name }).locator('input[type="number"]');
  await expect(boxOf(NAME.rater)).toHaveValue("6");
  await expect(boxOf(NAME.player)).toHaveValue("6");

  // Untouched focus + blur on Pat: nothing written.
  await boxOf(NAME.player).focus();
  await boxOf(NAME.player).blur();

  // Riley up to 8.
  await boxOf(NAME.rater).fill("8");
  await boxOf(NAME.rater).blur();
  await expect(page.locator("li").filter({ hasText: NAME.rater }).getByText("Saved")).toBeVisible();

  await expect.poll(() => seedOf(db, U.rater)).toBe(8);
  expect(await seedOf(db, U.player)).toBeNull();
});
