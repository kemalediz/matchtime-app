/**
 * Admin → Settings + Activities.
 *
 *   - money-collector picker shows the seeded collector
 *   - payment-method toggle persists (UI → DB → reload → pay page)
 *   - responsive: no horizontal overflow at mobile width on settings,
 *     activities and the admin subnav
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID, MATCH } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

test("money-collector picker has the seeded collector selected", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");
  const select = page.locator("select").filter({ hasText: "Colin Collector" }).first();
  await expect(select).toBeVisible({ timeout: 30_000 });
  await expect(select).toHaveValue(U.collector);
});

test("payment-method toggle persists and gates the pay page", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");

  // The "↳ Pay by Bank" feature row's switch.
  const bankRow = page
    .locator("div")
    .filter({ hasText: /Pay by Bank/ })
    .filter({ has: page.getByRole("switch") })
    .last();
  const bankSwitch = bankRow.getByRole("switch");
  await expect(bankSwitch).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });

  // OFF → persists to the org row…
  await bankSwitch.click();
  await expect
    .poll(async () => {
      const org = await db.one<{ payMethodPayByBank: boolean }>(
        `SELECT "payMethodPayByBank" FROM "Organisation" WHERE id = $1`,
        [ORG_ID],
      );
      return org?.payMethodPayByBank;
    })
    .toBe(false);

  // …survives a reload…
  await page.reload();
  await expect(
    page
      .locator("div")
      .filter({ hasText: /Pay by Bank/ })
      .filter({ has: page.getByRole("switch") })
      .last()
      .getByRole("switch"),
  ).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });

  // …and actually hides the method on the pay page.
  await page.goto(`/pay/${MATCH.pay}`);
  await expect(page.getByRole("button", { name: /Card, Apple or Google Pay/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /^Pay by Bank/ })).toHaveCount(0);

  // Restore for later specs.
  await db.run(`UPDATE "Organisation" SET "payMethodPayByBank" = true WHERE id = $1`, [ORG_ID]);
});

test("Weekly routine: the rolling squad switch persists, and its info opens (EN and TR)", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");
  const section = page.getByTestId("weekly-routine");
  await expect(section.getByRole("heading", { name: "Weekly routine" })).toBeVisible({ timeout: 30_000 });
  const toggle = section.getByRole("switch", { name: "Rolling squad" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  // The ⓘ explains it.
  await section.getByRole("button", { name: "What is Rolling squad?" }).click();
  await expect(page.getByRole("dialog")).toContainText("Everyone who played the last match is put in the squad for the next one automatically");
  await page.getByRole("button", { name: "Close" }).click();

  // ON persists to the org row and survives a reload.
  await toggle.click();
  await expect
    .poll(async () =>
      (await db.one<{ v: boolean }>(`SELECT "rollingSquadEnabled" AS v FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.v,
    )
    .toBe(true);
  await page.reload();
  await expect(page.getByTestId("weekly-routine").getByRole("switch", { name: "Rolling squad" })).toHaveAttribute(
    "aria-checked",
    "true",
    { timeout: 30_000 },
  );

  // A Turkish club reads it in Turkish.
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await page.reload();
  const tr = page.getByTestId("weekly-routine");
  await expect(tr.getByRole("heading", { name: "Haftalık düzen" })).toBeVisible({ timeout: 30_000 });
  await tr.getByRole("button", { name: "Kadro devam eder nedir?" }).click();
  await expect(page.getByRole("dialog")).toContainText("Son maçta oynayan herkes bir sonraki maçın kadrosuna otomatik olarak girer");

  // Restore for later specs.
  await db.run(`UPDATE "Organisation" SET language = 'en', "rollingSquadEnabled" = false WHERE id = $1`, [ORG_ID]);
});

test("Badge announcements: ON by default, the switch persists, and it reads in Turkish", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");
  const row = page.getByTestId("feature-badge-announcements");
  const toggle = row.getByRole("switch", { name: "Badge announcements" });
  await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await expect(row.getByText(/Two days after each match, posts the new badges in the group/)).toBeVisible();

  // OFF persists to the org row and survives a reload.
  await toggle.click();
  await expect
    .poll(async () =>
      (await db.one<{ v: boolean }>(`SELECT "featureBadgeAnnouncements" AS v FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.v,
    )
    .toBe(false);
  await page.reload();
  await expect(
    page.getByTestId("feature-badge-announcements").getByRole("switch", { name: "Badge announcements" }),
  ).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });

  // A Turkish club reads it in Turkish.
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await page.reload();
  await expect(
    page.getByTestId("feature-badge-announcements").getByRole("switch", { name: "Rozet duyuruları" }),
  ).toBeVisible({ timeout: 30_000 });

  // Restore for later specs.
  await db.run(`UPDATE "Organisation" SET language = 'en', "featureBadgeAnnouncements" = true WHERE id = $1`, [ORG_ID]);
});

test("Match-day kit reminder: follows the club's setting, the switch persists, and it reads in Turkish", async ({ page, db }) => {
  const read = async () =>
    (await db.one<{ v: boolean }>(`SELECT "featureGearReminder" AS v FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.v;
  // A new club's column default is off.
  await db.run(`UPDATE "Organisation" SET "featureGearReminder" = DEFAULT WHERE id = $1`, [ORG_ID]);
  expect(await read()).toBe(false);
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");
  const row = page.getByTestId("feature-gear-reminder");
  const toggle = row.getByRole("switch", { name: "Match-day kit reminder" });
  await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });
  await expect(row.getByText(/reminds the group to bring goalie gloves, a ball and spare bibs/)).toBeVisible();

  // ON persists to the org row and survives a reload.
  await toggle.click();
  await expect.poll(read).toBe(true);
  await page.reload();
  await expect(
    page.getByTestId("feature-gear-reminder").getByRole("switch", { name: "Match-day kit reminder" }),
  ).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });

  // A Turkish club reads it in Turkish.
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await page.reload();
  await expect(
    page.getByTestId("feature-gear-reminder").getByRole("switch", { name: "Maç günü malzeme hatırlatması" }),
  ).toBeVisible({ timeout: 30_000 });

  // Restore for later specs.
  await db.run(`UPDATE "Organisation" SET language = 'en', "featureGearReminder" = true WHERE id = $1`, [ORG_ID]);
});

test("Weekly routine: the drop-out deadline and list time persist, refuse bad input, and explain themselves (EN and TR)", async ({
  page,
  db,
}) => {
  // The seeded club plays Tuesday 20:00 ("E2E 5-a-side").
  const row = () =>
    db.one<{ dd: number | null; dt: string | null; pd: number | null; pt: string | null }>(
      `SELECT "dropOutDeadlineDay" AS dd, "dropOutDeadlineTime" AS dt, "listPublishDay" AS pd, "listPublishTime" AS pt
       FROM "Organisation" WHERE id = $1`,
      [ORG_ID],
    );
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");
  const section = page.getByTestId("weekly-routine");
  await expect(section.getByRole("heading", { name: "Weekly routine" })).toBeVisible({ timeout: 30_000 });

  // The ⓘ for each.
  await section.getByRole("button", { name: "What is Drop-out deadline?" }).click();
  await expect(page.getByRole("dialog")).toContainText("About 3 hours before the deadline (not before 09:00), MatchTime reminds the group");
  await page.getByRole("button", { name: "Close" }).click();
  await section.getByRole("button", { name: "What is List published?" }).click();
  await expect(page.getByRole("dialog")).toContainText("MatchTime stops its daily 17:00 post, except on match day");
  await page.getByRole("button", { name: "Close" }).click();

  // Monday 21:00 and Tuesday 19:00: saved.
  await section.getByTestId("wd-dropout-day").selectOption("1");
  await section.getByTestId("wd-dropout-time").fill("21:00");
  await section.getByTestId("wd-dropout-save").click();
  await expect.poll(async () => await row()).toMatchObject({ dd: 1, dt: "21:00" });
  await section.getByTestId("wd-publish-day").selectOption("2");
  await section.getByTestId("wd-publish-time").fill("19:00");
  await section.getByTestId("wd-publish-save").click();
  await expect.poll(async () => await row()).toEqual({ dd: 1, dt: "21:00", pd: 2, pt: "19:00" });

  // A list time on match day after kickoff is refused, and nothing changes.
  await section.getByTestId("wd-publish-time").fill("20:30");
  await section.getByTestId("wd-publish-save").click();
  await expect(section.getByTestId("wd-publish-error")).toHaveText("On match day, pick a time before kickoff.");
  expect(await row()).toMatchObject({ pd: 2, pt: "19:00" });

  // Half a pair is refused.
  await section.getByTestId("wd-dropout-day").selectOption("");
  await section.getByTestId("wd-dropout-save").click();
  await expect(section.getByTestId("wd-dropout-error")).toHaveText("Pick both a day and a time, or neither.");

  // After a reload the saved values are shown.
  await page.reload();
  const again = page.getByTestId("weekly-routine");
  await expect(again.getByTestId("wd-dropout-day")).toHaveValue("1", { timeout: 30_000 });
  await expect(again.getByTestId("wd-dropout-time")).toHaveValue("21:00");
  await expect(again.getByTestId("wd-publish-time")).toHaveValue("19:00");

  // A Turkish club reads it in Turkish, errors included.
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await page.reload();
  const tr = page.getByTestId("weekly-routine");
  await expect(tr.getByRole("heading", { name: "Haftalık düzen" })).toBeVisible({ timeout: 30_000 });
  await tr.getByRole("button", { name: "Son çıkış saati nedir?" }).click();
  await expect(page.getByRole("dialog")).toContainText("MatchTime kadroyla birlikte gruba hatırlatır");
  await page.getByRole("button", { name: "Kapat" }).click();
  // 08:30 was allowed until 2026-10-13 (08:00 to 21:30); the allowed times are 09:00 to 22:30 now.
  await tr.getByTestId("wd-dropout-time").fill("08:30");
  await tr.getByTestId("wd-dropout-save").click();
  await expect(tr.getByTestId("wd-dropout-error")).toHaveText("09:00 ile 22:30 arasında bir saat seçin.");

  // Clear returns the club to today's behaviour.
  await tr.getByTestId("wd-dropout-clear").click();
  await expect.poll(async () => (await row())?.dd ?? null).toBeNull();
  await tr.getByTestId("wd-publish-clear").click();
  await expect.poll(async () => await row()).toEqual({ dd: null, dt: null, pd: null, pt: null });

  // Restore for later specs.
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});

test("settings + activities render with no horizontal overflow at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");
  await expect(page.getByText(/Money collector/i).first()).toBeVisible({ timeout: 30_000 });
  let overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "settings page horizontal overflow").toBeLessThanOrEqual(0);

  await page.goto("/admin/activities");
  await expect(page.getByText("E2E 5-a-side").first()).toBeVisible({ timeout: 30_000 });
  overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "activities page horizontal overflow").toBeLessThanOrEqual(0);
});
