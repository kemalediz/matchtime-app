/**
 * Links into /admin/settings land on their section (2026-10-21).
 *
 * The partner-club notice DMs link to /admin/settings#partner-clubs, and the
 * payment DMs to #payments. Both sections are drawn only after the page's
 * data has loaded, so the browser's own jump to the #section found nothing
 * and the owner landed at the top, about 4200px above the Accept button.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const PARTNER = "e2e-hash-partner";

test.beforeAll(() => {
  resetDb();
});

test.afterAll(() => {
  resetDb();
});

test("the partner-club link lands on the pending pairing's Accept button", async ({ page, db }) => {
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","createdAt","updatedAt")
     VALUES ($1,'Hash Partners',$1,$2,'approved',now(),now())`,
    [PARTNER, `${PARTNER}-invite`],
  );
  await db.run(
    `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,"createdByUserId","createdAt","updatedAt")
     VALUES ($1,$2,$3,'proposed',$4,now(),now())`,
    [`${PARTNER}-pair`, ORG_ID, PARTNER, U.admin],
  );
  await signInAs(page, U.admin, "/admin/settings#partner-clubs");
  const section = page.getByTestId("partner-clubs");
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.getByTestId("partner-accept")).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test("the payments link lands on the Payments section", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET "paymentCollectionEnabled" = true WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/admin/settings#payments");
  await expect(page.locator("#payments")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#payments")).toBeInViewport();
});

test("with no #section the page still opens at the top", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/settings");
  await expect(page.getByTestId("partner-clubs")).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
