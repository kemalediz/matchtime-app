/**
 * THE FEWEST AND MOST PLAYERS ON THE EDIT FORM of /admin/activities
 * (2026-11-03), end to end in a browser against a real Postgres. No model
 * is involved.
 *
 * The Vets play 6, 7 or 8 a side by numbers: their organiser sets the fewest
 * and the most players (even numbers), and the form says what that allows.
 * Empty is the game's own size, as every game had before. Saving the range
 * changes no match: one match changes size only when an organiser switches it.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ACTIVITY_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });
test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

type Db = { all: (sql: string, params?: unknown[]) => Promise<unknown[]> };
const rangeOf = async (db: Db) =>
  ((await db.all(`SELECT "minPlayers" AS min, "maxPlayers" AS max FROM "Activity" WHERE id = $1`, [ACTIVITY_ID])) as Array<{ min: number | null; max: number | null }>)[0];

async function openEdit(page: import("@playwright/test").Page) {
  await signInAs(page, U.admin, "/admin/activities");
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  const min = page.getByTestId("activity-min-players");
  await expect(min).toBeVisible({ timeout: 30_000 });
  return { min, max: page.getByTestId("activity-max-players") };
}

test("empty by default: the game's own size, and the form says so", async ({ page, db }) => {
  expect(await rangeOf(db)).toEqual({ min: null, max: null });
  const { min, max } = await openEdit(page);
  await expect(page.getByText("Minimum players", { exact: true })).toBeVisible();
  await expect(page.getByText("Maximum players", { exact: true })).toBeVisible();
  await expect(min).toHaveValue("");
  await expect(max).toHaveValue("");
  await expect(page.getByTestId("activity-min-players-hint")).toContainText("Leave it empty for two full sides");
  // The fixture game is 5-a-side: 10 places.
  await expect(page.getByTestId("activity-player-range-allows")).toHaveText("With 10 players you play 5 a side.");
});

test("an organiser sets 8 to 12: the form says 4, 5 or 6 a side, the list row too, and no match changes", async ({ page, db }) => {
  const places = await db.all(`SELECT "maxPlayers" FROM "Match" WHERE "activityId" = $1 ORDER BY date`, [ACTIVITY_ID]);
  const { min, max } = await openEdit(page);
  await expect(min).toHaveAttribute("placeholder", "10");
  await min.fill("8");
  await max.fill("12");
  await expect(page.getByTestId("activity-player-range-allows")).toHaveText("With 8 to 12 players you can play 4, 5 or 6 a side.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => rangeOf(db)).toEqual({ min: 8, max: 12 });
  await expect(page.getByTestId("activity-player-range-row").first()).toHaveText("· 4, 5 or 6 a side");
  expect(await db.all(`SELECT "maxPlayers" FROM "Match" WHERE "activityId" = $1 ORDER BY date`, [ACTIVITY_ID])).toEqual(places);
});

test("odd numbers, a minimum above the places and a maximum below them are refused in words; nothing is saved", async ({ page, db }) => {
  const { min, max } = await openEdit(page);
  await expect(min).toHaveValue("8");
  await min.fill("9");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Players have to be an even number, so both sides are the same size: for example 12 or 14.").first()).toBeVisible();
  await min.fill("8");
  await max.fill("11");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Players have to be an even number, so both sides are the same size: for example 12 or 14.").first()).toBeVisible();
  await max.fill("8");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("has 10 places, so the maximum has to be at least 10.").first()).toBeVisible();
  await max.fill("12");
  await min.fill("12");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("has 10 places, so the minimum can be 10 at most.").first()).toBeVisible();
  expect(await rangeOf(db)).toEqual({ min: 8, max: 12 });
});

test("emptied: back to the game's own size", async ({ page, db }) => {
  const { min, max } = await openEdit(page);
  await min.fill("");
  await max.fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => rangeOf(db)).toEqual({ min: null, max: null });
  await expect(page.getByTestId("activity-player-range-row")).toHaveCount(0);
});
