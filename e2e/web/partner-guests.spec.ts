/**
 * Guests from a partner club in the asking club's pages (cross-club ask,
 * slice S4, plan 3.7 and 3.10).
 *
 *   - /admin/players: the guest is labelled "Guest from Sutton Lenders",
 *     with no phone field and no merge button;
 *   - /admin/players/phones: the guest is not listed at all;
 *   - the match page: "Guests from partner clubs", and "Add to <club>"
 *     makes him an ordinary member.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const PARTNER = "e2e-xg-sutton";
const GUEST = "e2e-xg-guest";

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","createdAt","updatedAt") VALUES ($1,'Sutton Lenders',$1,$2,'approved',now(),now())`,
    [PARTNER, `${PARTNER}-invite`],
  );
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,'Ali Guestman',$2,'+447700900991',true,true,now())`,
    [GUEST, `${GUEST}@e2e-test.invalid`],
  );
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt") VALUES ('e2e-xg-m1',$1,$2,'PLAYER',now())`, [GUEST, PARTNER]);
  await db.run(
    `INSERT INTO "Membership" (id,"userId","orgId",role,"guestFromOrgId","guestMatchId","createdAt") VALUES ('e2e-xg-m2',$1,$2,'PLAYER',$3,$4,now())`,
    [GUEST, ORG_ID, PARTNER, MATCH.upcoming],
  );
  await db.run(
    `INSERT INTO "Attendance" (id,"matchId","userId",status,position,"createdAt","updatedAt") VALUES ('e2e-xg-att',$1,$2,'BENCH',9,now(),now())`,
    [MATCH.upcoming, GUEST],
  );
});

test.afterAll(() => {
  resetDb();
});

test("the players page labels the guest and shows no phone for him", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/players");
  const badge = page.getByTestId("guest-badge");
  await expect(badge).toHaveText("Guest from Sutton Lenders", { timeout: 30_000 });
  await expect(page.getByText("+447700900991")).toHaveCount(0);
  await expect(page.locator('input[type="tel"][value="+447700900991"]')).toHaveCount(0);
});

test("the phones page does not list the guest", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/players/phones");
  await expect(page.getByText("Alex Admin").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Ali Guestman")).toHaveCount(0);
});

test("the match page lists the guest and 'Add to' makes him a member", async ({ page, db }) => {
  await signInAs(page, U.admin, `/matches/${MATCH.upcoming}`);
  const panel = page.getByTestId("partner-guests-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId("partner-guest-row")).toContainText("Ali Guestman, guest from Sutton Lenders");
  // His standing at HIS club (2026-10-22): no rating there yet.
  await expect(panel.getByTestId("partner-guest-standing")).toHaveText("Sutton Lenders, not rated yet there");
  await panel.getByTestId("partner-guest-keep").click();
  await expect.poll(async () => (await db.one<{ g: string | null }>(`SELECT "guestFromOrgId" AS g FROM "Membership" WHERE id = 'e2e-xg-m2'`))?.g, { timeout: 15_000 }).toBeNull();
});

test("a player of the club does not see the guests panel", async ({ page, db }) => {
  await db.run(`UPDATE "Membership" SET "guestFromOrgId" = $1, "guestMatchId" = $2 WHERE id = 'e2e-xg-m2'`, [PARTNER, MATCH.upcoming]);
  await signInAs(page, U.player, `/matches/${MATCH.upcoming}`);
  await expect(page.getByText("Alex Admin").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("partner-guests-panel")).toHaveCount(0);
});
