/**
 * "This game didn't happen" on the match page (2026-10-28, Kemal: Sutton
 * FC's Tuesday 5-a-side never happened, and MatchTime asked for its score
 * and sent rating links).
 *
 *   - an organiser sees the button on a past game inside the 7-day window,
 *     taps it, gets a confirm step, and "Keep it" changes nothing;
 *   - the yes marks it as not played (CANCELLED), the reply shows, and the
 *     button becomes "It did happen";
 *   - a rating link for it opens to "This game was cancelled, so there is
 *     nothing to rate.";
 *   - "It did happen" puts it back as played (COMPLETED);
 *   - a player sees no button; a scored game has none; a Turkish club reads
 *     it in Turkish.
 *
 * The fixture's PAY match is the game: 3 hours ago, COMPLETED, no score.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  resetDb();
});

test.afterAll(() => {
  resetDb();
});

const statusOf = async (db: import("../helpers/test-db").TestDb) =>
  (await db.one<{ status: string }>(`SELECT status::text AS status FROM "Match" WHERE id = $1`, [MATCH.pay]))!.status;

test("an organiser marks a past game as not played, with a confirm step; the rating page closes; then puts it back", async ({ page, db }) => {
  await signInAs(page, U.admin, `/matches/${MATCH.pay}`);
  const button = page.getByTestId("not-played-button");
  await expect(button).toBeVisible({ timeout: 30_000 });
  await expect(button).toHaveText("This game didn't happen");

  // The confirm step, and "Keep it" changes nothing.
  await button.click();
  const confirm = page.getByTestId("not-played-confirm");
  await expect(confirm).toContainText(/^Mark \w+'s E2E 5-a-side on \d{1,2} \w{3} as not played\? It won't count anywhere: no score, ratings or Man of the Match\./);
  await page.getByTestId("not-played-keep").click();
  await expect(confirm).toHaveCount(0);
  expect(await statusOf(db)).toBe("COMPLETED");

  // Yes: marked as not played, the reply shown.
  await page.getByTestId("not-played-button").click();
  await page.getByTestId("not-played-yes").click();
  await expect(page.getByText(/is marked as not played: no score, ratings or Man of the Match for it\./)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => statusOf(db)).toBe("CANCELLED");
  await expect(page.getByTestId("played-restore-button")).toHaveText("It did happen", { timeout: 15_000 });
  // Nothing posted to the players: no rating link had gone out.
  expect(await db.all(`SELECT id FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group' AND text LIKE '%rating links are closed%'`, [ORG_ID])).toHaveLength(0);

  // A player's rating link for it: one line, nothing to rate.
  await signInAs(page, U.rater, `/matches/${MATCH.pay}/rate`);
  await expect(page.getByTestId("rate-cancelled")).toHaveText("This game was cancelled, so there is nothing to rate.", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Submit ratings" })).toHaveCount(0);

  // "It did happen": back as played.
  await signInAs(page, U.admin, `/matches/${MATCH.pay}`);
  await page.getByTestId("played-restore-button").click();
  await page.getByTestId("not-played-yes").click();
  await expect(page.getByText(/is back on the record as played\./)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => statusOf(db)).toBe("COMPLETED");
  await expect(page.getByTestId("not-played-button")).toBeVisible({ timeout: 15_000 });
});

test("a player sees no button; a scored game has none", async ({ page }) => {
  await signInAs(page, U.player, `/matches/${MATCH.pay}`);
  await expect(page.getByRole("heading", { name: "E2E 5-a-side" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("not-played-button")).toHaveCount(0);

  // The RATE match is 3-2: it was played.
  await signInAs(page, U.admin, `/matches/${MATCH.rate}`);
  await expect(page.getByRole("heading", { name: "E2E 5-a-side" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("not-played-button")).toHaveCount(0);
});

test("a Turkish club: the button, the confirm and the rating page in Turkish", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, `/matches/${MATCH.pay}`);
  const button = page.getByTestId("not-played-button");
  await expect(button).toHaveText("Bu maç oynanmadı", { timeout: 30_000 });
  await button.click();
  await expect(page.getByTestId("not-played-confirm")).toContainText("oynanmadı olarak işaretlensin mi?");
  await page.getByTestId("not-played-yes").click();
  await expect.poll(() => statusOf(db)).toBe("CANCELLED");
  await signInAs(page, U.rater, `/matches/${MATCH.pay}/rate`);
  await expect(page.getByTestId("rate-cancelled")).toHaveText("Bu maç iptal edildi, puanlanacak bir şey yok.", { timeout: 30_000 });
});
