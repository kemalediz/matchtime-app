/**
 * Admin → Switch match format, end to end (2026-09-08 incident).
 *
 * Each format is its own Activity with its own London wall-clock `time`.
 * `switchMatchFormat` used to re-point `activityId` and reset
 * `maxPlayers` while leaving `Match.date` on the OLD format's kickoff, so
 * every downstream post — chase, squad announcement, team sheet, the
 * two-hour pre-kickoff message, all of which read `Match.date` — stated a
 * time the match was no longer at. On Sutton FC (7-a-side 21:30 ↔
 * 5-a-side 21:15) the owner had to spot it himself, four hours before a
 * real match.
 *
 * The arithmetic is unit-tested in src/lib/__tests__/format-switch-time
 * and the action's payload in src/app/actions/__tests__. THIS spec proves
 * the whole path: a real admin session, the real page, the real server
 * action, the real Postgres row — including the London → UTC conversion
 * running in a real Node process rather than against a mock.
 *
 * The fixture world has one activity, so the spec creates the second
 * format itself (a 7-a-side Sport + Activity 30 minutes later) rather
 * than widening the shared seed, which every other spec file depends on.
 *
 * TIMESTAMP READS: `Match.date` is `timestamp` WITHOUT time zone holding
 * UTC, and node-pg parses that column into a Date using the *process*
 * timezone — which is not UTC on a London dev machine. So every instant
 * is read as epoch milliseconds and every wall clock is rendered by
 * Postgres itself. Never `new Date(row.date)`.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { testDb } from "../helpers/test-db";
import { ORG_ID, MATCH } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const SPORT_7 = "e2e-sport-7aside";
const ACTIVITY_7 = "e2e-activity-7aside";
const ACTIVITY_5 = "e2e-activity"; // the seeded 5-a-side activity, 20:00
/** The new activity's London wall clock — 30 min after the seeded 20:00. */
const NEW_TIME = "20:30";
const NEW_DEADLINE_HOURS = 5;
const HOUR_MS = 60 * 60 * 1000;

interface MatchRow {
  activityId: string;
  maxPlayers: number;
  /** Kickoff as epoch milliseconds (Postgres reads the column as UTC). */
  dateMs: string;
  deadlineMs: string;
  /** Kickoff rendered in Europe/London by Postgres — what a player reads. */
  londonHHmm: string;
}

const MATCH_SQL = `
  SELECT "activityId",
         "maxPlayers",
         (extract(epoch from date) * 1000)::bigint::text                AS "dateMs",
         (extract(epoch from "attendanceDeadline") * 1000)::bigint::text AS "deadlineMs",
         to_char(date AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London', 'HH24:MI') AS "londonHHmm"
    FROM "Match" WHERE id = $1`;

const readMatch = (db: { one: <T>(sql: string, p: unknown[]) => Promise<T | null> }) =>
  db.one<MatchRow>(MATCH_SQL, [MATCH.upcoming]);

/**
 * THE ANNOUNCEMENT LANDS AFTER THE ROW. `switchMatchFormat` updates the
 * Match first, then recuts the squad, reads the roster twice and only
 * then inserts the BotJob. So the moment the poll above sees the new
 * Match row, the announcement may not exist yet: read once, and the
 * first test gets null and the second gets the PREVIOUS test's message.
 * On an unloaded machine that window is milliseconds and the spec passed;
 * on a busy one it failed 4 runs in 7.
 *
 * To make that deterministic rather than a matter of machine load, each
 * test holds the action's BotJob INSERT back by LATE_MS with a trigger,
 * so the Match row is always visible well before the announcement is.
 * The trigger function goes quiet on its own after a minute, so a run
 * killed mid-test cannot leave every later spec's BotJob inserts slow.
 */
const LATE_MS = 3_000;

async function armLateBotJob(db: { run: (sql: string, p?: unknown[]) => Promise<void> }) {
  const expires = new Date(Date.now() + 60_000).toISOString();
  await db.run(`
    CREATE OR REPLACE FUNCTION e2e_late_botjob() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF clock_timestamp() < '${expires}'::timestamptz THEN
        PERFORM pg_sleep(${LATE_MS / 1000});
      END IF;
      RETURN NEW;
    END $fn$`);
  await db.run(`DROP TRIGGER IF EXISTS e2e_late_botjob ON "BotJob"`);
  await db.run(
    `CREATE TRIGGER e2e_late_botjob BEFORE INSERT ON "BotJob"
       FOR EACH ROW EXECUTE FUNCTION e2e_late_botjob()`,
  );
}

async function disarmLateBotJob(db: { run: (sql: string, p?: unknown[]) => Promise<void> }) {
  await db.run(`DROP TRIGGER IF EXISTS e2e_late_botjob ON "BotJob"`);
  await db.run(`DROP FUNCTION IF EXISTS e2e_late_botjob()`);
}

test.beforeAll(async () => {
  resetDb();
  await disarmLateBotJob(testDb());
});

test.afterEach(async ({ db }) => {
  await disarmLateBotJob(db);
});

test("switching format moves the kickoff to the new activity's London time", async ({
  page,
  db,
}) => {
  // ── a second format for the same sport family, 30 minutes later ────
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, preset, "playersPerTeam", positions, "teamLabels", "mvpLabel", "createdAt", "updatedAt")
     VALUES ($1, $2, 'Football 7-a-side', 'football-7aside', 7, ARRAY['GK','DEF','MID','FWD'], ARRAY['Red','Yellow'], 'Man of the Match', now(), now())`,
    [SPORT_7, ORG_ID],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "isActive", "deadlineHours", "matchDurationMins", "ratingWindowHours", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'E2E 7-a-side', 2, $4, 'E2E Arena', true, $5, 60, 120, now(), now())`,
    [ACTIVITY_7, ORG_ID, SPORT_7, NEW_TIME, NEW_DEADLINE_HOURS],
  );

  // Seeded at 20:00 London — the activity's default, so the switch is
  // entitled to restamp it.
  const before = await readMatch(db);
  expect(before!.londonHHmm).toBe("20:00");

  // ── drive the real admin page ──────────────────────────────────────
  await signInAs(page, U.admin, `/admin/matches/${MATCH.upcoming}/switch-format`);
  await page.waitForURL(`**/admin/matches/${MATCH.upcoming}/switch-format`);

  const select = page.locator("select");
  await expect(select).toBeVisible({ timeout: 30_000 });
  await select.selectOption(ACTIVITY_7);
  await armLateBotJob(db);
  await page.getByRole("button", { name: /Confirm switch/ }).click();

  // ── the row, not the toast ─────────────────────────────────────────
  // 20:00 → 20:30 is +30 min on the same London day (no DST boundary
  // sits between them), derived from the row we read rather than from
  // Date.now(), so a run straddling London midnight can't disagree with
  // the fixture.
  const expectedMs = Number(before!.dateMs) + 30 * 60 * 1000;
  await expect
    .poll(async () => await readMatch(db), { timeout: 30_000 })
    .toMatchObject({
      activityId: ACTIVITY_7,
      maxPlayers: 14,
      dateMs: String(expectedMs),
      londonHHmm: NEW_TIME,
      // re-derived from the NEW kickoff and the NEW activity's deadlineHours
      deadlineMs: String(expectedMs - NEW_DEADLINE_HOURS * HOUR_MS),
    });

  // The group is told the new kickoff, in London wall clock.
  const job = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE "orgId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [ORG_ID],
  );
  expect(job!.text).toContain("Football 7-a-side");
  expect(job!.text).toContain(NEW_TIME);
  expect(job!.text).toContain("20:00");
});

test("switching back to a same-time format leaves the kickoff exactly where it is", async ({
  page,
  db,
}) => {
  // Line the two activities up on the same wall clock: the switch back
  // must then be a pure format change, with the schedule untouched.
  await db.run(`UPDATE "Activity" SET time = $1 WHERE id = $2`, [NEW_TIME, ACTIVITY_5]);
  const before = await readMatch(db);
  expect(before!.activityId).toBe(ACTIVITY_7);

  await signInAs(page, U.admin, `/admin/matches/${MATCH.upcoming}/switch-format`);
  await page.waitForURL(`**/admin/matches/${MATCH.upcoming}/switch-format`);

  const select = page.locator("select");
  await expect(select).toBeVisible({ timeout: 30_000 });
  await select.selectOption(ACTIVITY_5);
  await armLateBotJob(db);
  await page.getByRole("button", { name: /Confirm switch/ }).click();

  await expect
    .poll(async () => await readMatch(db), { timeout: 30_000 })
    .toMatchObject({
      activityId: ACTIVITY_5,
      maxPlayers: 10,
      // untouched — a no-op must be a no-op, not a rewrite
      dateMs: before!.dateMs,
      deadlineMs: before!.deadlineMs,
    });

  const job = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE "orgId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [ORG_ID],
  );
  expect(job!.text).not.toMatch(/kickoff/i);
});
