/**
 * MATCH LENGTH ON THE EDIT FORM of /admin/activities (2026-10-15), end to
 * end in a browser against a real Postgres. No model is involved.
 *
 * An organiser (FNF, 20:30 to 22:00) could not change an existing game
 * from 60 to 90 minutes: "Match duration (min)" was only on the create
 * form. Now the edit form has it, and the sign-up deadline, each prefilled
 * and sent only when changed (src/lib/activity-timings.ts).
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ACTIVITY_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });
test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

const timingsOf = (db: { all: (sql: string, params?: unknown[]) => Promise<unknown[]> }) =>
  db.all(`SELECT "matchDurationMins" AS mins, "deadlineHours" AS hours FROM "Activity" WHERE id = $1`, [ACTIVITY_ID]);

async function openEdit(page: import("@playwright/test").Page) {
  await signInAs(page, U.admin, "/admin/activities");
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  const duration = page.getByTestId("activity-duration");
  await expect(duration).toBeVisible({ timeout: 30_000 });
  return duration;
}

test("an organiser changes an existing game from 60 to 90 minutes", async ({ page, db }) => {
  expect(await timingsOf(db)).toEqual([{ mins: 60, hours: 5 }]);
  const duration = await openEdit(page);
  await expect(page.getByText("Match duration (min)")).toBeVisible();
  await expect(duration).toHaveValue("60");
  await expect(page.getByTestId("activity-deadline")).toHaveValue("5");
  await expect(page.getByTestId("activity-timings-hint")).toHaveText(
    "A new match length applies to every game of this activity, including ones already created. A new deadline applies to matches created after you save.",
  );

  // The ⓘ beside the field explains what match length decides.
  await page.getByTestId("info-act_duration").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "Match length" })).toBeVisible();
  await expect(sheet).toContainText("kick-off plus this many minutes");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Closing the popup leaves the edit form open.
  await expect(duration).toBeVisible();

  await duration.fill("90");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => timingsOf(db)).toEqual([{ mins: 90, hours: 5 }]);
  await expect(page.getByText(/90min/)).toBeVisible();
});

test("out of bounds is refused in words and nothing is saved", async ({ page, db }) => {
  const duration = await openEdit(page);
  await expect(duration).toHaveValue("90");
  await duration.fill("200");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Match duration must be 20 to 180 minutes.")).toBeVisible();
  await duration.fill("90");
  await page.getByTestId("activity-deadline").fill("0");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("The deadline must be 1 to 48 hours before kick-off.")).toBeVisible();
  expect(await timingsOf(db)).toEqual([{ mins: 90, hours: 5 }]);
});

test("a stored deadline of 0 (Sutton's) does not block a change of match length, and stays 0", async ({ page, db }) => {
  await db.run(`UPDATE "Activity" SET "deadlineHours" = 0 WHERE id = $1`, [ACTIVITY_ID]);
  const duration = await openEdit(page);
  await expect(page.getByTestId("activity-deadline")).toHaveValue("0");
  await duration.fill("75");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => timingsOf(db)).toEqual([{ mins: 75, hours: 0 }]);
});

test("the deadline can be changed on its own", async ({ page, db }) => {
  await db.run(`UPDATE "Activity" SET "deadlineHours" = 5 WHERE id = $1`, [ACTIVITY_ID]);
  await openEdit(page);
  await page.getByTestId("activity-deadline").fill("24");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => timingsOf(db)).toEqual([{ mins: 75, hours: 24 }]);
});

test("in Turkish", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = (SELECT "orgId" FROM "Activity" WHERE id = $1)`, [ACTIVITY_ID]);
  try {
    await openEdit(page);
    await expect(page.getByText("Maç süresi (dk)")).toBeVisible();
    await expect(page.getByText("Son kayıt (saat önce)")).toBeVisible();
    await page.getByTestId("activity-duration").fill("10");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Maç süresi 20 ile 180 dakika arasında olmalı.")).toBeVisible();
  } finally {
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = (SELECT "orgId" FROM "Activity" WHERE id = $1)`, [ACTIVITY_ID]);
  }
});
