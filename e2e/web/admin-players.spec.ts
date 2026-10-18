/**
 * Admin → Players.
 *
 *   - provisional NEW row shows the player's NAME (zero-width collapse
 *     regression, 2026-06-11) — checked at mobile width
 *   - add-player-by-name dedup: existing unique name is REUSED (no ghost),
 *     ambiguous name still creates a fresh player
 *   - merge flow: duplicate merged away
 *   - mobile-width render: no horizontal overflow (incl. admin subnav)
 *   - the banner keeps the space after the name ("Hamzahposted", 2026-09-29)
 *   - each row shows the club rating beside the seed: the raw club mean
 *     the player sees, "Not rated yet" when nobody has rated them
 */
import { mkdirSync } from "node:fs";
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { NAME, ORG_ID, PHONE } from "../helpers/constants";

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

test("banner spaces the name, and each row shows the club rating beside the seed", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInAs(page, U.admin, "/admin/players");
  await page.waitForURL("**/admin/players");

  await expect(page.getByText(`${NAME.walt} posted in the group and got auto-added.`, { exact: false })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(`${NAME.walt}posted`)).toHaveCount(0);
  // Same collapse, same page: "Seed ratingis the player's".
  await expect(page.getByText(/Seed rating is the player's starting skill score/)).toBeVisible();
  await expect(page.getByText(/Seed ratingis/)).toHaveCount(0);

  await expect(page.getByText("Club rating", { exact: true }).first()).toBeVisible();

  // Riley: rated 8 and 7 in one game (seed fixture), so 7.5 over 1 game.
  const rowOf = (name: string) =>
    page
      .locator("div")
      .filter({ has: page.locator(`input[value="${name}"]`) })
      .filter({ has: page.getByTestId("club-rating") })
      .last();
  await expect(rowOf(NAME.rater).getByTestId("club-rating")).toContainText("7.5");
  await expect(rowOf(NAME.rater).getByTestId("club-rating")).toContainText("1 rated game");
  // Pat: one 4.
  await expect(rowOf(NAME.player).getByTestId("club-rating")).toContainText("4.0");
  // Walt: nobody has rated him.
  await expect(rowOf(NAME.walt).getByTestId("club-rating")).toContainText("Not rated yet");

  // No em dash anywhere in the page's copy.
  const bodyText = await page.locator("main, body").first().innerText();
  expect(bodyText).not.toContain("\u2014");

  const shotDir = process.env.MT_E2E_SHOT_DIR;
  if (shotDir) {
    mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: `${shotDir}/admin-players-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${shotDir}/admin-players-mobile.png`, fullPage: true });
  }
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

// ── Account safety (2026-10-18, src/lib/player-account-guard.ts) ────────
// A number is a sign-in. The fixture seeds every user as signed in, so
// Pat Player is somebody who manages their own account.

test("an admin cannot change the name or number of a player who manages their own account", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/players");
  await page.waitForURL("**/admin/players");
  const nameInput = page.locator(`input[value="${NAME.player}"]`);
  await expect(nameInput).toBeVisible({ timeout: 30_000 });

  await nameInput.fill("Hijacked Name");
  await nameInput.blur();
  await expect(
    page.getByText("This player manages their own number and name on MatchTime, so only they can change them.").first(),
  ).toBeVisible({ timeout: 15_000 });

  const phoneInput = page.locator(`input[value="${PHONE.player}"]`);
  await phoneInput.fill("+447700900888");
  await phoneInput.blur();
  await expect(
    page.getByText("This player manages their own number and name on MatchTime, so only they can change them.").first(),
  ).toBeVisible({ timeout: 15_000 });

  const row = await db.one<{ name: string; phoneNumber: string }>(
    `SELECT name, "phoneNumber" FROM "User" WHERE id = $1`,
    [U.player],
  );
  expect(row).toEqual({ name: NAME.player, phoneNumber: PHONE.player });
});

test("adding a number that is already on MatchTime attaches nobody and names nobody", async ({ page, db }) => {
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","createdAt","updatedAt")
     VALUES ('e2e-other-club','Other Club','e2e-other-club','e2e-other-invite','approved',now(),now())`,
  );
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt")
     VALUES ('e2e-outsider','Olga Outsider','outsider@e2e-test.invalid','+447700900877',true,true,now())`,
  );
  await db.run(
    `INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt") VALUES ('e2e-outsider-m','e2e-outsider','e2e-other-club','PLAYER',now())`,
  );

  await signInAs(page, U.admin, "/admin/players");
  await page.waitForURL("**/admin/players");
  await expect(page.locator(`input[value="${NAME.player}"]`)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: /add player/i }).click();
  await page.getByPlaceholder(/name \(e\.g\./i).fill("Anyone");
  await page.getByPlaceholder(/phone \(optional/i).fill("+447700900877");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect(page.getByText("That number is already on MatchTime, so it can't be added here.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Olga Outsider")).toHaveCount(0);
  expect(
    await db.count(`SELECT COUNT(*) FROM "Membership" WHERE "userId" = 'e2e-outsider' AND "orgId" = $1`, [ORG_ID]),
  ).toBe(0);
});

test("merge flow folds a duplicate into the kept player", async ({ page, db }) => {
  // A duplicate is in real life a record the bot made for this club and
  // nobody signed in as; only such a record may be merged away.
  await db.run(
    `UPDATE "User" SET email = 'wa-sync+danny@matchtime.local', onboarded = false WHERE id = $1`,
    [U.dup],
  );
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
  await expect(page.getByText(`Merge ${NAME.dup} into another player.`, { exact: false })).toBeVisible();

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
