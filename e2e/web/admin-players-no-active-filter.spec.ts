/**
 * Admin player pages: no "Inactive" badge and no "Active / All" filter
 * (owner, 2026-11-17: "remove this inactive or active label, it doesn't
 * make sense").
 *
 * The positions, phones and ratings pages used to badge a member
 * "Inactive" and hide him under a default "Active" filter. Now every
 * club member is listed, with no badge and no filter; the search box
 * stays. A member who has left the club is still not listed. A member whose `User.isActive` is false (the flag the squad and
 * merge code still read) is listed like anyone else. The phones page
 * keeps its "Missing phone" toggle, which is about phones, not activity.
 *
 * No model calls: the isolated e2e database, seeded here.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const P = "e2e-naf";
const FLAG_OFF = { id: `${P}-off`, name: "Fenna Flagoff", flag: false, phone: null };
const FLAG_ON = { id: `${P}-on`, name: "Nico Flagon", flag: true, phone: "+447700900971" };
const MEMBERS = [FLAG_OFF, FLAG_ON];
/** Left the club: not a current member, so on none of the three pages. */
const LEFT = { id: `${P}-left`, name: "Lena Leftclub", flag: true, phone: null };

test.beforeAll(async ({ db }) => {
  resetDb();
  for (const u of MEMBERS) {
    await db.run(
      `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,$2,$3,$4,true,$5,now())`,
      [u.id, u.name, `${u.id}@e2e-test.invalid`, u.phone, u.flag],
    );
    await db.run(
      `INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt") VALUES ($1,$2,$3,'PLAYER',now() - interval '7 months')`,
      [`${u.id}-m`, u.id, ORG_ID],
    );
  }
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,$2,$3,$4,true,$5,now())`,
    [LEFT.id, LEFT.name, `${LEFT.id}@e2e-test.invalid`, LEFT.phone, LEFT.flag],
  );
  await db.run(
    `INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt","leftAt") VALUES ($1,$2,$3,'PLAYER',now() - interval '7 months',now() - interval '1 month')`,
    [`${LEFT.id}-m`, LEFT.id, ORG_ID],
  );
});

test.afterAll(() => {
  resetDb();
});

for (const path of ["/admin/players/positions", "/admin/players/phones", "/admin/players/ratings"]) {
  test(`${path}: every member listed, no Inactive badge, no Active/All filter`, async ({ page }) => {
    await signInAs(page, U.admin, path);
    const row = (name: string) => page.locator("p", { hasText: name });

    await expect(row(FLAG_OFF.name)).toBeVisible({ timeout: 30_000 });
    await expect(row(FLAG_ON.name)).toBeVisible();
    await expect(row(LEFT.name)).toHaveCount(0);
    await expect(page.getByText("Inactive", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Active", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "All", exact: true })).toHaveCount(0);

    // The search box stays and narrows the list.
    await page.getByPlaceholder(/^Search/).fill("Fenna");
    await expect(row(FLAG_OFF.name)).toBeVisible();
    await expect(row(FLAG_ON.name)).toHaveCount(0);
  });
}

test("/admin/players/phones: the Missing phone toggle still narrows to members without a phone", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/players/phones");
  const row = (name: string) => page.locator("p", { hasText: name });
  await expect(row(FLAG_ON.name)).toBeVisible({ timeout: 30_000 });

  const toggle = page.getByRole("button", { name: "Missing phone", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(row(FLAG_OFF.name)).toBeVisible();
  await expect(row(FLAG_ON.name)).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(row(FLAG_ON.name)).toBeVisible();
});
