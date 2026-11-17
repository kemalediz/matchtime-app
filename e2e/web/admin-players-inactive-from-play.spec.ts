/**
 * Admin player pages: a member who plays for this club is never
 * "Inactive" (Sutton, 2026-11-17).
 *
 * Ersan Arik and Recai Gunay played on 17 Nov 2026 and the positions,
 * phones and ratings pages still badged them "Inactive" and hid them
 * under the default "Active" filter, because the pages read the global
 * `User.isActive` a rebuild script wrote once in April. The fix is
 * narrow: active = that flag OR played for THIS club in the stats page's
 * window, with the stats page's meaning of "played" (CONFIRMED on a
 * COMPLETED match). Proved here on the real query, against Postgres:
 *
 *   - flag false, CONFIRMED on yesterday's completed match: active;
 *   - flag true, never played: still active (nobody is made Inactive);
 *   - flag false and only a game at ANOTHER club, a CANCELLED match, a
 *     BENCH row, a DROPPED row, or a game four months ago: still Inactive.
 *
 * No model calls: the isolated e2e database, seeded here.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ACTIVITY_ID, MATCH, ORG_ID, SPORT_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const P = "e2e-ia";
const REGULAR = { id: `${P}-regular`, name: "Ezra Regular", flag: false };
const NEVER = { id: `${P}-never`, name: "Nate Neverplayed", flag: true };
const OTHER_CLUB = { id: `${P}-other`, name: "Otto Elsewhere", flag: false };
const CANCELLED = { id: `${P}-cancelled`, name: "Cara Cancelled", flag: false };
const BENCHED = { id: `${P}-bench`, name: "Bram Benched", flag: false };
const DROPPED = { id: `${P}-dropped`, name: "Dora Dropped", flag: false };
const OLD = { id: `${P}-old`, name: "Olaf Oldgame", flag: false };

const ACTIVE = [REGULAR, NEVER];
const INACTIVE = [OTHER_CLUB, CANCELLED, BENCHED, DROPPED, OLD];

test.beforeAll(async ({ db }) => {
  resetDb();
  for (const u of [...ACTIVE, ...INACTIVE]) {
    await db.run(
      `INSERT INTO "User" (id,name,email,onboarded,"isActive","updatedAt") VALUES ($1,$2,$3,true,$4,now())`,
      [u.id, u.name, `${u.id}@e2e-test.invalid`, u.flag],
    );
    await db.run(
      `INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt") VALUES ($1,$2,$3,'PLAYER',now() - interval '7 months')`,
      [`${u.id}-m`, u.id, ORG_ID],
    );
  }

  // Another club, with a game Otto played yesterday.
  const other = `${P}-otherclub`;
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","createdAt","updatedAt") VALUES ($1,'Elsewhere FC',$1,$2,'approved',now(),now())`,
    [other, `${other}-invite`],
  );
  await db.run(
    `INSERT INTO "Activity" (id,"orgId","sportId",name,"dayOfWeek",time,venue,"createdAt","updatedAt") VALUES ($1,$2,$3,'Elsewhere 5s',1,'20:00','Elsewhere Arena',now(),now())`,
    [`${other}-act`, other, SPORT_ID],
  );
  const match = async (id: string, activityId: string, status: string, when: string) =>
    db.run(
      `INSERT INTO "Match" (id,"activityId",date,"maxPlayers",status,"attendanceDeadline","updatedAt") VALUES ($1,$2,${when},10,$3,${when},now())`,
      [id, activityId, status],
    );
  await match(`${P}-m-other`, `${other}-act`, "COMPLETED", "now() - interval '1 day'");
  await match(`${P}-m-cancelled`, ACTIVITY_ID, "CANCELLED", "now() - interval '2 days'");
  await match(`${P}-m-old`, ACTIVITY_ID, "COMPLETED", "now() - interval '4 months'");

  const rows: Array<[string, string, string, number]> = [
    [MATCH.rate, REGULAR.id, "CONFIRMED", 20],
    [`${P}-m-other`, OTHER_CLUB.id, "CONFIRMED", 1],
    [`${P}-m-cancelled`, CANCELLED.id, "CONFIRMED", 1],
    [MATCH.rate, BENCHED.id, "BENCH", 21],
    [MATCH.rate, DROPPED.id, "DROPPED", 22],
    [`${P}-m-old`, OLD.id, "CONFIRMED", 1],
  ];
  for (const [matchId, userId, status, position] of rows) {
    await db.run(
      `INSERT INTO "Attendance" (id,"matchId","userId",status,position,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,now(),now())`,
      [`${P}-att-${userId}`, matchId, userId, status, position],
    );
  }
});

test.afterAll(() => {
  resetDb();
});

for (const path of ["/admin/players/positions", "/admin/players/phones", "/admin/players/ratings"]) {
  test(`${path}: only real play here rescues a stale-inactive member`, async ({ page }) => {
    await signInAs(page, U.admin, path);
    const row = (name: string) => page.locator("p", { hasText: name });
    const badge = (name: string) => row(name).getByText("Inactive", { exact: true });

    // Default filter is "Active".
    await expect(row(REGULAR.name)).toBeVisible({ timeout: 30_000 });
    for (const u of ACTIVE) {
      await expect(row(u.name)).toBeVisible();
      await expect(badge(u.name)).toHaveCount(0);
    }
    for (const u of INACTIVE) await expect(row(u.name)).toHaveCount(0);

    await page.getByRole("button", { name: "All", exact: true }).click();
    for (const u of INACTIVE) await expect(badge(u.name)).toBeVisible();
    for (const u of ACTIVE) await expect(badge(u.name)).toHaveCount(0);
  });
}
