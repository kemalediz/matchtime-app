/**
 * /admin/settings, "Weekly routine" → "Teams ready" (2026-10-14).
 *
 *   - hidden while the club has no admin group linked;
 *   - with one linked: the row, its ⓘ, the default 10:00;
 *   - a new time and Off persist.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const HQ = "120363777000000051@g.us";
const setting = async (db: import("../helpers/test-db").TestDb) =>
  (await db.one<{ v: string }>(`SELECT "teamsReadyTime" AS v FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.v;

test.beforeAll(() => {
  resetDb();
});

test.afterAll(() => {
  resetDb();
});

test("no admin group linked: no Teams ready row", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/settings");
  await expect(page.getByTestId("weekly-routine")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("admin-channel-section")).toBeVisible();
  await expect(page.getByTestId("teams-ready")).toHaveCount(0);
});

test("with an admin group: the row and its ⓘ, then a time and Off persist", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2 WHERE id = $1`, [ORG_ID, HQ]);
  await signInAs(page, U.admin, "/admin/settings");
  const row = page.getByTestId("teams-ready");
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText("Teams ready", { exact: true })).toBeVisible();
  // Not set, and MatchTime announces this club's list: the default is Off.
  await expect(row.getByTestId("teams-ready-off")).toBeChecked();
  await expect(row.getByTestId("teams-ready-default")).toHaveText("Not set yet, so this is your club's default.");
  expect(await setting(db)).toBeNull();

  await row.getByRole("button", { name: "What is Teams ready?" }).click();
  await expect(page.getByText(/On match day at this time MatchTime builds balanced teams/)).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  // Turning it on stores 10:00 explicitly.
  await row.getByTestId("teams-ready-off").uncheck();
  await expect.poll(() => setting(db)).toBe("10:00");
  await expect(row.getByTestId("teams-ready-default")).toHaveCount(0);

  await row.getByTestId("teams-ready-time").fill("11:30");
  await row.getByTestId("teams-ready-time").blur();
  await expect.poll(() => setting(db)).toBe("11:30");

  await row.getByTestId("teams-ready-off").check();
  await expect.poll(() => setting(db)).toBe("off");
  await expect(row.getByTestId("teams-ready-time")).toBeDisabled();
});

test("not set and the organisers announce: the default shown is 10:00", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET "teamsReadyTime" = NULL, "listAnnouncer" = 'organisers' WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/admin/settings");
  const row = page.getByTestId("teams-ready");
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByTestId("teams-ready-off")).not.toBeChecked();
  await expect(row.getByTestId("teams-ready-time")).toHaveValue("10:00");
  await expect(row.getByTestId("teams-ready-default")).toBeVisible();
});
