/**
 * Admin → Switch format → a size inside the game's range (2026-11-03, the
 * Vets play 6, 7 or 8 a side), end to end: a real admin session, the real
 * page, the real server action and core (`format-resize.ts`), the real
 * Postgres row. No model is involved.
 *
 * The fixture game is 5-a-side (10 places). With 8 to 12 players set, the
 * page offers 4, 5 and 6 a side, the current size disabled; a pick changes
 * only the match's places (same Activity, same kickoff) and posts the new
 * list once.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID, MATCH, ACTIVITY_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });
test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

type Db = {
  run: (sql: string, p?: unknown[]) => Promise<void>;
  all: <T>(sql: string, p?: unknown[]) => Promise<T[]>;
  one: <T>(sql: string, p: unknown[]) => Promise<T | null>;
};

const matchRow = (db: Db) =>
  db.one<{ activityId: string; maxPlayers: number; dateMs: string }>(
    `SELECT "activityId", "maxPlayers", (extract(epoch from date) * 1000)::bigint::text AS "dateMs" FROM "Match" WHERE id = $1`,
    [MATCH.upcoming],
  );

test("no range: the page shows no sizes", async ({ page }) => {
  await signInAs(page, U.admin, `/admin/matches/${MATCH.upcoming}/switch-format`);
  await expect(page.getByText("Switch match format")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("switch-sizes")).toHaveCount(0);
});

test("8 to 12 players: 4, 5 or 6 a side; picking 6 makes the match 12 places, same game and kickoff, one list post", async ({ page, db }) => {
  await (db as Db).run(`UPDATE "Activity" SET "minPlayers" = 8, "maxPlayers" = 12 WHERE id = $1`, [ACTIVITY_ID]);
  // The fixture's small squad has 5 places; a real 5-a-side match has 10.
  await (db as Db).run(`UPDATE "Match" SET "maxPlayers" = 10 WHERE id = $1`, [MATCH.upcoming]);
  const before = await matchRow(db as Db);
  expect(before?.maxPlayers).toBe(10);
  const jobsBefore = (await (db as Db).all<{ id: string }>(`SELECT id FROM "BotJob" WHERE "orgId" = $1`, [ORG_ID])).map((r) => r.id);

  await signInAs(page, U.admin, `/admin/matches/${MATCH.upcoming}/switch-format`);
  await expect(page.getByTestId("switch-sizes")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("switch-size-4")).toHaveText("4-a-side (8)");
  await expect(page.getByTestId("switch-size-5")).toBeDisabled();
  await expect(page.getByTestId("switch-size-confirm")).toBeDisabled();
  await page.getByTestId("switch-size-6").click();
  await page.getByTestId("switch-size-confirm").click();

  await expect.poll(async () => (await matchRow(db as Db))?.maxPlayers, { timeout: 30_000 }).toBe(12);
  const after = await matchRow(db as Db);
  expect(after?.activityId).toBe(before?.activityId);
  expect(after?.dateMs).toBe(before?.dateMs);
  let group: Array<{ text: string }> = [];
  await expect
    .poll(async () => {
      group = await (db as Db).all<{ text: string }>(
        `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group' AND NOT (id = ANY($2::text[]))`,
        [ORG_ID, jobsBefore],
      );
      return group.length;
    }, { timeout: 30_000 })
    .toBe(1);
  expect(group[0].text).toMatch(/is 6-a-side now\* \(12 places\)\./);
  expect(group[0].text).not.toMatch(/[–—]/);
});
