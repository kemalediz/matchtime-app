/**
 * /admin/settings, "Quiet hours" (2026-10-16).
 *
 *   - the card, its ⓘ, and the default: On, 23:00 to 09:00;
 *   - new times persist; the same time twice is refused;
 *   - Off persists, disables the times and keeps them; On again restores them;
 *   - a Turkish club reads it in Turkish.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const row = async (db: import("../helpers/test-db").TestDb) =>
  db.one<{ enabled: boolean; from: string; to: string }>(
    `SELECT "quietHoursEnabled" AS enabled, "quietHoursFrom" AS "from", "quietHoursTo" AS "to" FROM "Organisation" WHERE id = $1`,
    [ORG_ID],
  );

test.beforeAll(() => {
  resetDb();
});

test.afterAll(() => {
  resetDb();
});

test("the default, the ⓘ, new times, a refused pair, Off and On again", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/settings");
  const card = page.getByTestId("quiet-hours");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("heading", { name: "Quiet hours" })).toBeVisible();
  // Every existing club starts On, 23:00 to 09:00: today's message hours.
  const sw = card.getByTestId("quiet-hours-switch");
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(card.getByTestId("quiet-hours-from")).toHaveValue("23:00");
  await expect(card.getByTestId("quiet-hours-to")).toHaveValue("09:00");
  expect(await row(db)).toEqual({ enabled: true, from: "23:00", to: "09:00" });

  await card.getByRole("button", { name: "What is Quiet hours?" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("During quiet hours MatchTime holds the messages it sends on its own");
  await expect(sheet).toContainText("These never wait");
  await page.getByRole("button", { name: "Close" }).click();

  await card.getByTestId("quiet-hours-from").fill("21:30");
  await card.getByTestId("quiet-hours-from").blur();
  await expect.poll(() => row(db)).toEqual({ enabled: true, from: "21:30", to: "09:00" });
  await card.getByTestId("quiet-hours-to").fill("10:00");
  await card.getByTestId("quiet-hours-to").blur();
  await expect.poll(() => row(db)).toEqual({ enabled: true, from: "21:30", to: "10:00" });

  // The same time twice is no window: refused, nothing saved.
  await card.getByTestId("quiet-hours-to").fill("21:30");
  await card.getByTestId("quiet-hours-to").blur();
  await expect(card.getByTestId("quiet-hours-error")).toHaveText("Pick two different times.");
  expect(await row(db)).toEqual({ enabled: true, from: "21:30", to: "10:00" });

  // Off: nothing waits. The times are kept, and greyed out.
  await sw.click();
  await expect.poll(() => row(db)).toEqual({ enabled: false, from: "21:30", to: "10:00" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(card.getByTestId("quiet-hours-from")).toBeDisabled();
  await expect(card.getByTestId("quiet-hours-off-note")).toHaveText("Off: nothing waits. MatchTime sends at any hour.");

  await page.reload();
  await expect(page.getByTestId("quiet-hours-switch")).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });

  // On again: the saved times come back.
  await page.getByTestId("quiet-hours-switch").click();
  await expect.poll(() => row(db)).toEqual({ enabled: true, from: "21:30", to: "10:00" });
  await expect(page.getByTestId("quiet-hours-from")).toHaveValue("21:30");
});

test("a Turkish club reads the card in Turkish", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/admin/settings");
  const card = page.getByTestId("quiet-hours");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("heading", { name: "Sessiz saatler" })).toBeVisible();
  await expect(card.getByText("Başlangıç")).toBeVisible();
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});
