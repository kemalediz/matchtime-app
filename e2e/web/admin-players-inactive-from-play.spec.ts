/**
 * Admin player pages: "Inactive" comes from this club's real play
 * (Sutton, 2026-11-17).
 *
 * Ersan Arik and Recai Gunay played on 17 Nov 2026 and the positions,
 * phones and ratings pages still badged them "Inactive" and hid them
 * under the default "Active" filter, because the pages read the global
 * `User.isActive` a rebuild script wrote once in April. Now:
 *
 *   - "Ezra Regular" (global flag false, a long-standing member) played
 *     yesterday's match: listed under "Active", no badge;
 *   - "Arlo Away" (global flag true, a long-standing member) has no game
 *     in three months: hidden under "Active", badged under "All";
 *   - "Nina New" joined today and has not played yet: listed, no badge.
 *
 * No model calls: the isolated e2e database, seeded here.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const REGULAR = { id: "e2e-ia-regular", name: "Ezra Regular" };
const AWAY = { id: "e2e-ia-away", name: "Arlo Away" };
const NEW = { id: "e2e-ia-new", name: "Nina New" };

test.beforeAll(async ({ db }) => {
  resetDb();
  const users: Array<[typeof REGULAR, boolean, string]> = [
    [REGULAR, false, "now() - interval '7 months'"],
    [AWAY, true, "now() - interval '7 months'"],
    [NEW, true, "now()"],
  ];
  for (const [u, globalIsActive, joined] of users) {
    await db.run(
      `INSERT INTO "User" (id,name,email,onboarded,"isActive","updatedAt") VALUES ($1,$2,$3,true,$4,now())`,
      [u.id, u.name, `${u.id}@e2e-test.invalid`, globalIsActive],
    );
    await db.run(
      `INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt") VALUES ($1,$2,$3,'PLAYER',${joined})`,
      [`${u.id}-m`, u.id, ORG_ID],
    );
  }
  // Yesterday's completed match (the seed's rate match).
  await db.run(
    `INSERT INTO "Attendance" (id,"matchId","userId",status,position,"createdAt","updatedAt") VALUES ('e2e-ia-att',$1,$2,'CONFIRMED',20,now(),now())`,
    [MATCH.rate, REGULAR.id],
  );
});

test.afterAll(() => {
  resetDb();
});

for (const path of ["/admin/players/positions", "/admin/players/phones", "/admin/players/ratings"]) {
  test(`${path}: the badge and the Active filter follow real play`, async ({ page }) => {
    await signInAs(page, U.admin, path);
    const row = (name: string) => page.locator("p", { hasText: name });

    // Default filter is "Active".
    await expect(row(REGULAR.name)).toBeVisible({ timeout: 30_000 });
    await expect(row(REGULAR.name).getByText("Inactive", { exact: true })).toHaveCount(0);
    await expect(row(NEW.name)).toBeVisible();
    await expect(row(NEW.name).getByText("Inactive", { exact: true })).toHaveCount(0);
    await expect(row(AWAY.name)).toHaveCount(0);

    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(row(AWAY.name)).toBeVisible();
    await expect(row(AWAY.name).getByText("Inactive", { exact: true })).toBeVisible();
    await expect(row(REGULAR.name).getByText("Inactive", { exact: true })).toHaveCount(0);
  });
}
