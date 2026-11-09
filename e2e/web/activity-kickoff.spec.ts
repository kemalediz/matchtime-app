/**
 * A NEW KICKOFF ON THE EDIT FORM MOVES THE GAMES NOT YET PLAYED (Kemal,
 * 2026-11-09), end to end in a browser against a real Postgres. No model.
 *
 * Monday night vets went from 20:30 to 20:15 on /admin/activities, and
 * tonight's and next week's games, already made, still said 20:30. Now a
 * save of the day or time moves every game still to be played with it,
 * quietly (src/lib/activity-kickoff-move.ts), and the matches page shows
 * the new time.
 *
 * The fixture world: the E2E activity plays at 20:00; its upcoming game is
 * two London days ahead at 20:00, and yesterday's game was played.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ACTIVITY_ID, MATCH, londonAt } from "../helpers/constants";
import type { TestDb as Db } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });
test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

const BY_HAND = "e2e-match-kickoff-by-hand";

const gameOf = async (db: Db, id: string) =>
  ((await db.all(`SELECT date, "attendanceDeadline" AS deadline FROM "Match" WHERE id = $1`, [id])) as Array<{ date: Date; deadline: Date }>)[0];
const count = async (db: Db, table: string) => Number(((await db.all(`SELECT count(*)::int AS n FROM "${table}"`)) as Array<{ n: number }>)[0].n);

test("an organiser moves the game from 20:00 to 19:45: the upcoming game follows, quietly, and the matches page says 19:45", async ({ page, db }) => {
  // A game an organiser put at 18:00 by hand (a block booking): it stays.
  const byHand = londonAt(3, 18, 0);
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 10, 'UPCOMING', $4, now())`,
    [BY_HAND, ACTIVITY_ID, byHand, new Date(byHand.getTime() - 5 * 3600_000)],
  );
  const played = await gameOf(db, MATCH.rate);
  const jobsBefore = await count(db, "BotJob");
  const sentBefore = await count(db, "SentNotification");

  await signInAs(page, U.admin, "/admin/activities");
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  const time = page.getByTestId("activity-edit-time");
  await expect(time).toBeVisible({ timeout: 30_000 });
  await expect(time).toHaveValue("20:00");
  await expect(page.getByTestId("activity-kickoff-hint")).toHaveText(
    "Games not yet played move to the new time, and to the new day in the same week. MatchTime sends no message about it.",
  );
  await time.fill("19:45");
  await page.getByRole("button", { name: "Save changes" }).click();

  const moved = londonAt(2, 19, 45);
  await expect
    .poll(async () => (await gameOf(db, MATCH.upcoming)).date.toISOString(), { timeout: 15_000 })
    .toBe(moved.toISOString());
  // The sign-up deadline moved by as much (it was kickoff minus 5 hours).
  expect((await gameOf(db, MATCH.upcoming)).deadline.toISOString()).toBe(new Date(moved.getTime() - 5 * 3600_000).toISOString());
  // The played game and the one set by hand did not move.
  expect((await gameOf(db, MATCH.rate)).date.toISOString()).toBe(played.date.toISOString());
  expect((await gameOf(db, BY_HAND)).date.toISOString()).toBe(byHand.toISOString());
  // Nothing was queued or posted about it.
  expect(await count(db, "BotJob")).toBe(jobsBefore);
  expect(await count(db, "SentNotification")).toBe(sentBefore);

  await page.goto("/matches");
  const card = page.locator(`a[href="/matches/${MATCH.upcoming}"]`);
  await expect(card).toContainText("19:45");
  await expect(card).not.toContainText("20:00");
});

test("in Turkish the hint is the club's language", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = (SELECT "orgId" FROM "Activity" WHERE id = $1)`, [ACTIVITY_ID]);
  try {
    await signInAs(page, U.admin, "/admin/activities");
    await page.getByRole("button", { name: "Edit", exact: true }).first().click();
    await expect(page.getByTestId("activity-kickoff-hint")).toHaveText(
      "Henüz oynanmamış maçlar yeni saate ve aynı haftadaki yeni güne taşınır. MatchTime bu konuda mesaj göndermez.",
      { timeout: 30_000 },
    );
  } finally {
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = (SELECT "orgId" FROM "Activity" WHERE id = $1)`, [ACTIVITY_ID]);
  }
});
