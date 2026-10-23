/**
 * A partner guest with NO name on the admin roster pages (prod, MT Test,
 * 2026-10-23).
 *
 * `/api/players` hides a guest's email (null, by design). A guest the
 * nameless-volunteer flow added has `User.name` NULL too, so the players
 * page's `(p.name ?? p.email).charAt(0)` threw in the browser and the
 * whole page showed "This page couldn't load".
 *
 *   - /admin/players renders; the guest's avatar is "?" and his row reads
 *     "Guest from <club>"; the merge picker on another row names him too;
 *   - the ratings and positions pages' search does not throw on him.
 *
 * No model calls: the isolated e2e database, seeded here.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, NAME, ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const PARTNER = "e2e-ng-friday";
const GUEST = "e2e-ng-guest";

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","createdAt","updatedAt") VALUES ($1,'Friday Lenders',$1,$2,'approved',now(),now())`,
    [PARTNER, `${PARTNER}-invite`],
  );
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,NULL,$2,'+447700900992',true,true,now())`,
    [GUEST, `${GUEST}@e2e-test.invalid`],
  );
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt") VALUES ('e2e-ng-m1',$1,$2,'PLAYER',now())`, [GUEST, PARTNER]);
  await db.run(
    `INSERT INTO "Membership" (id,"userId","orgId",role,"guestFromOrgId","guestMatchId","createdAt") VALUES ('e2e-ng-m2',$1,$2,'PLAYER',$3,$4,now())`,
    [GUEST, ORG_ID, PARTNER, MATCH.upcoming],
  );
});

test.afterAll(() => {
  resetDb();
});

test("the players page renders a nameless guest as '?' and 'Guest from <club>'", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signInAs(page, U.admin, "/admin/players");
  await expect(page.getByTestId("guest-badge")).toHaveText("Guest from Friday Lenders", { timeout: 30_000 });
  const row = page.getByTestId(`player-row-${GUEST}`);
  await expect(row.getByTestId("player-initial")).toHaveText("?");
  await expect(row.locator('input[type="text"]').first()).toHaveAttribute("placeholder", "Guest from Friday Lenders");
  await expect(page.getByText(/couldn.t load/)).toHaveCount(0);

  // The merge picker on a member's row lists the guest by the same label.
  const admin = page.locator(`input[value="${NAME.admin}"]`);
  await expect(admin).toBeVisible();
  await page.getByTestId(`player-row-${U.admin}`).getByRole("button", { name: /Merge/ }).click();
  await expect(page.getByRole("button", { name: "Guest from Friday Lenders" })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const path of ["/admin/players/ratings", "/admin/players/positions"]) {
  test(`${path}: searching does not throw on a guest with no email`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await signInAs(page, U.admin, path);
    const search = page.getByPlaceholder("Search…");
    await expect(search).toBeVisible({ timeout: 30_000 });
    await search.fill("alex");
    await expect(page.getByText(NAME.admin).first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}
