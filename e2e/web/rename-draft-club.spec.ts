/**
 * Admin > Settings > General: the club name.
 *
 * Reported live: an organiser created "Friday MT Community", needed a
 * different name before adding MatchTime to the WhatsApp group, and
 * could not change it.
 *
 *   - a DRAFT club's owner can rename it (the slug stays as it was);
 *   - the Save button is busy while the request runs, and a second
 *     press does not call the action again;
 *   - an APPROVED club's name is read-only, with a line saying why.
 *
 * Deterministic: no model is involved anywhere in this flow.
 */
import type { Request } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { testDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const SLUG = "e2e-test-fc";
const isAction = (r: Request) => r.method() === "POST" && r.headers()["next-action"] !== undefined;

/** The bot is on for an approved club only (a CHECK constraint says so). */
async function setStatus(status: "draft" | "approved") {
  await testDb().run(`UPDATE "Organisation" SET "approvalStatus" = $1, "whatsappBotEnabled" = $2 WHERE id = $3`, [
    status,
    status === "approved",
    ORG_ID,
  ]);
}

async function club() {
  return testDb().one<{ name: string; slug: string }>(`SELECT name, slug FROM "Organisation" WHERE id = $1`, [ORG_ID]);
}

test.beforeAll(() => {
  resetDb();
});

test.afterAll(async () => {
  await setStatus("approved");
});

test("a draft club: the owner renames it, the button is busy meanwhile, the slug stays", async ({ page }) => {
  await setStatus("draft");
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");

  const name = page.getByLabel("Organisation name", { exact: true });
  await expect(name).toBeEnabled({ timeout: 30_000 });
  await expect(name).toHaveValue("E2E Test FC");
  const save = page.getByRole("button", { name: "Save name" });
  await expect(save, "nothing to save yet").toBeDisabled();
  await expect(page.getByLabel("URL slug")).toBeDisabled();

  // Hold the action open so the busy state can be looked at.
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let calls = 0;
  await page.route(
    (url) => url.pathname === "/admin/settings",
    async (route) => {
      if (!isAction(route.request())) return route.continue();
      calls++;
      await opened;
      await route.continue();
    },
  );

  await name.fill("  Friday Football  ");
  await save.click();
  const busy = page.getByRole("button", { name: "Saving..." });
  await expect(busy).toBeDisabled();
  await busy.click({ force: true });
  await name.press("Enter");
  await page.waitForTimeout(500);
  expect(calls, "action calls while the first is running").toBe(1);

  open();
  await expect(page.getByTestId("club-name-saved")).toBeVisible({ timeout: 30_000 });
  await expect(name).toHaveValue("Friday Football");
  expect(await club()).toEqual({ name: "Friday Football", slug: SLUG });

  // It is the saved name after a reload, and the slug field still shows the old slug.
  await page.reload();
  await expect(page.getByLabel("Organisation name", { exact: true })).toHaveValue("Friday Football", { timeout: 30_000 });
  await expect(page.getByLabel("URL slug")).toHaveValue(SLUG);
});

test("a draft club: a name that is too short cannot be saved", async ({ page }) => {
  await setStatus("draft");
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");

  const name = page.getByLabel("Organisation name", { exact: true });
  await expect(name).toBeEnabled({ timeout: 30_000 });
  await name.fill("A");
  await expect(page.getByRole("button", { name: "Save name" })).toBeDisabled();
  expect((await club())?.name).toBe("Friday Football");
});

test("an approved club: the name is read-only, with a line saying why", async ({ page }) => {
  await setStatus("approved");
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");

  const name = page.getByLabel("Organisation name", { exact: true });
  await expect(name).toHaveValue("Friday Football", { timeout: 30_000 });
  await expect(name).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save name" })).toHaveCount(0);
  await expect(page.getByTestId("club-name-locked")).toHaveText(
    "The name can no longer be changed here. MatchTime approves a club by its name.",
  );
});
