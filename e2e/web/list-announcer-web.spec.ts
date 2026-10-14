/**
 * /admin/settings "Who announces the list and teams" (2026-10-14,
 * src/lib/list-announcer.ts): the control shows MatchTime by default,
 * saves "The organisers" to the club, survives a reload, and has its ⓘ.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

test("settings: who announces the list and teams persists", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/settings");
  const row = page.getByTestId("wr-announce");
  const mode = page.getByTestId("wr-announce-mode");
  await expect(mode).toHaveValue("matchtime", { timeout: 30_000 });
  await expect(row).toContainText("Who announces the list and teams");

  await row.getByRole("button", { name: "What is Who announces the list and teams?" }).click();
  await expect(page.getByText(/never posts the list or the teams there/)).toBeVisible();
  await page.keyboard.press("Escape");

  await mode.selectOption("organisers");
  await expect
    .poll(async () => (await db.one<{ v: string }>(`SELECT "listAnnouncer" AS v FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.v)
    .toBe("organisers");
  await page.reload();
  await expect(page.getByTestId("wr-announce-mode")).toHaveValue("organisers", { timeout: 30_000 });

  await page.getByTestId("wr-announce-mode").selectOption("matchtime");
  await expect
    .poll(async () => (await db.one<{ v: string }>(`SELECT "listAnnouncer" AS v FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.v)
    .toBe("matchtime");
});
