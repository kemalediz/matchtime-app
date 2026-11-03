/**
 * MINIMUM PLAYERS ON THE EDIT FORM of /admin/activities (2026-11-03), end
 * to end in a browser against a real Postgres. No model is involved.
 *
 * The Vets play 7-a-side with 14 places and happily play one down. The
 * organiser sets the fewest the game is played with; empty is two full
 * sides, as every game had before. The places do not change.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ACTIVITY_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });
test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

const minOf = async (db: { all: (sql: string, params?: unknown[]) => Promise<unknown[]> }) =>
  ((await db.all(`SELECT "minPlayers" AS min FROM "Activity" WHERE id = $1`, [ACTIVITY_ID])) as Array<{ min: number | null }>)[0]?.min ?? null;

async function openEdit(page: import("@playwright/test").Page) {
  await signInAs(page, U.admin, "/admin/activities");
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  const box = page.getByTestId("activity-min-players");
  await expect(box).toBeVisible({ timeout: 30_000 });
  return box;
}

test("empty by default: two full sides, and the hint says so", async ({ page, db }) => {
  expect(await minOf(db)).toBeNull();
  const box = await openEdit(page);
  await expect(page.getByText("Minimum players", { exact: true })).toBeVisible();
  await expect(box).toHaveValue("");
  await expect(page.getByTestId("activity-min-players-hint")).toContainText("Leave it empty for two full sides");
});

// The fixture game is 5-a-side (10 places): one down is 9, as the Vets' 13 of 14.
test("an organiser sets one down (9 of 10); the list row says it; the places do not change", async ({ page, db }) => {
  const places = await db.all(`SELECT "maxPlayers" FROM "Match" WHERE "activityId" = $1 ORDER BY date`, [ACTIVITY_ID]);
  const box = await openEdit(page);
  await expect(box).toHaveAttribute("placeholder", "10");
  await box.fill("9");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => minOf(db)).toBe(9);
  await expect(page.getByTestId("activity-min-players-row").first()).toHaveText("· plays with 9 or more");
  expect(await db.all(`SELECT "maxPlayers" FROM "Match" WHERE "activityId" = $1 ORDER BY date`, [ACTIVITY_ID])).toEqual(places);
});

test("more than the places, or 1, is refused in words and nothing is saved", async ({ page, db }) => {
  const box = await openEdit(page);
  await expect(box).toHaveValue("9");
  const places = Number(await box.getAttribute("placeholder"));
  await box.fill(String(places + 1));
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(`Enter a whole number from 2 to ${places}, or leave it empty.`)).toBeVisible();
  await box.fill("1");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(`Enter a whole number from 2 to ${places}, or leave it empty.`).first()).toBeVisible();
  expect(await minOf(db)).toBe(9);
});

test("emptied: back to two full sides", async ({ page, db }) => {
  const box = await openEdit(page);
  await box.fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => minOf(db)).toBeNull();
  await expect(page.getByTestId("activity-min-players-row")).toHaveCount(0);
});
