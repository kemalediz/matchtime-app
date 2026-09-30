/**
 * The match page's "Carry over last squad" button (2026-09-30, rolling
 * squad slice 1). Admin of a rolling club, an EMPTY upcoming match: one
 * press copies the last played squad onto it, recorded as the admin, and
 * the button is gone afterwards (the match is seeded, and no longer
 * empty). A club without the setting never sees it.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ACTIVITY_ID, ORG_ID, londonAt } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const EMPTY = "e2e-match-carry-over";

test.beforeEach(async ({ db }) => {
  resetDb();
  const kickoff = londonAt(9, 20, 0);
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
     VALUES ($1, $2, $3, 10, 'UPCOMING', $4, now())`,
    [EMPTY, ACTIVITY_ID, kickoff.toISOString(), new Date(kickoff.getTime() - 5 * 60 * 60 * 1000).toISOString()],
  );
});

test.afterAll(() => resetDb());

test("a club without the rolling squad never sees the button", async ({ page }) => {
  await signInAs(page, U.admin, `/matches/${EMPTY}`);
  await expect(page.getByRole("heading", { name: "Attendance" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Carry over last squad" })).toHaveCount(0);
});

test("an admin of a rolling club carries the last squad over in one press", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET "rollingSquadEnabled" = true WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, `/matches/${EMPTY}`);
  const button = page.getByRole("button", { name: "Carry over last squad" });
  await expect(button).toBeVisible({ timeout: 30_000 });
  await button.click();

  await expect
    .poll(async () => db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1`, [EMPTY]))
    .toBeGreaterThan(0);
  const rows = await db.all<{ userId: string; status: string }>(
    `SELECT "userId", status::text AS status FROM "Attendance" WHERE "matchId" = $1`,
    [EMPTY],
  );
  for (const u of [U.collector, U.player]) {
    expect(rows.find((r) => r.userId === u)?.status).toBe("CONFIRMED");
  }
  const events = await db.all<{ cause: string; actorKind: string; actorUserId: string }>(
    `SELECT cause, "actorKind", "actorUserId" FROM "AttendanceEvent" WHERE "matchId" = $1`,
    [EMPTY],
  );
  expect(events.length).toBe(rows.length);
  for (const e of events) expect(e).toEqual({ cause: "rolling-squad", actorKind: "admin", actorUserId: U.admin });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Attendance" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Carry over last squad" })).toHaveCount(0);
});
