/**
 * Admin → Players.
 *
 *   - provisional NEW row shows the player's NAME (zero-width collapse
 *     regression, 2026-06-11) — checked at mobile width
 *   - add-player-by-name dedup: existing unique name is REUSED (no ghost),
 *     ambiguous name still creates a fresh player
 *   - merge flow: duplicate merged away
 *   - mobile-width render: no horizontal overflow (incl. admin subnav)
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { NAME, ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

test("provisional NEW row shows the player's name at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, U.admin, "/admin/players");
  await page.waitForURL("**/admin/players");

  // Provisional banner names Walt.
  await expect(page.getByText(/new player(s)? joined via WhatsApp/i)).toBeVisible({ timeout: 30_000 });

  // The name input in Walt's row must hold his name AND have real width
  // (the bug collapsed it to zero so the row looked nameless on phones).
  const waltInput = page.locator(`input[value="${NAME.walt}"]`);
  await expect(waltInput).toBeVisible();
  const box = await waltInput.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(60);

  // NEW badge + Confirm action visible on the row.
  await expect(page.getByText("New", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /confirm/i }).first()).toBeVisible();

  // No horizontal overflow anywhere on the page (incl. the admin subnav).
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("adding an existing unique name reuses the member — no ghost", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/players");
  await page.waitForURL("**/admin/players");
  await expect(page.locator(`input[value="${NAME.player}"]`)).toBeVisible({ timeout: 30_000 });

  const usersBefore = await db.count(`SELECT COUNT(*) FROM "User"`);

  await page.getByRole("button", { name: /add player/i }).click();
  await page.getByPlaceholder(/name \(e\.g\./i).fill(NAME.player);
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect(page.getByText("Added existing player to this group")).toBeVisible();
  expect(await db.count(`SELECT COUNT(*) FROM "User"`)).toBe(usersBefore); // reused
  expect(await db.count(`SELECT COUNT(*) FROM "User" WHERE name = $1`, [NAME.player])).toBe(1);
});

test("adding an ambiguous name still creates a fresh player", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/players");
  await page.waitForURL("**/admin/players");
  await expect(page.locator(`input[value="${NAME.omar1}"]`)).toBeVisible({ timeout: 30_000 });

  const usersBefore = await db.count(`SELECT COUNT(*) FROM "User"`);

  await page.getByRole("button", { name: /add player/i }).click();
  await page.getByPlaceholder(/name \(e\.g\./i).fill("Omar");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect(page.getByText("Added Omar")).toBeVisible();
  // Two existing Omars are ambiguous → a NEW user is the safe outcome.
  expect(await db.count(`SELECT COUNT(*) FROM "User"`)).toBe(usersBefore + 1);
  expect(await db.count(`SELECT COUNT(*) FROM "User" WHERE name = 'Omar'`)).toBe(1);
});

test("merge flow folds a duplicate into the kept player", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/players");
  await page.waitForURL("**/admin/players");
  await expect(page.locator(`input[value="${NAME.dup}"]`)).toBeVisible({ timeout: 30_000 });

  // Open the merge picker on Danny Dup's row.
  const dannyRow = page
    .locator("div")
    .filter({ has: page.locator(`input[value="${NAME.dup}"]`) })
    .filter({ has: page.getByRole("button", { name: /merge/i }) })
    .last();
  await dannyRow.getByRole("button", { name: /^merge$/i }).click();

  // Accept the confirm() dialog, then pick the merge target. The target
  // picker renders OUTSIDE the tight name-cell container, so locate the
  // button globally — it only exists while Danny's picker is open.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: NAME.player, exact: true }).click();

  await expect(page.getByText("Players merged")).toBeVisible({ timeout: 15_000 });

  // mergePlayers deletes the duplicate user row entirely.
  await expect
    .poll(async () => db.count(`SELECT COUNT(*) FROM "User" WHERE id = $1`, [U.dup]))
    .toBe(0);
  await expect
    .poll(async () =>
      db.count(`SELECT COUNT(*) FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`, [U.dup, ORG_ID]),
    )
    .toBe(0);
});
