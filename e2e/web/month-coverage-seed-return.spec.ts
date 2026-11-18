/**
 * A SEED-LIST PLAYER TAKEN OFF AND ADDED BACK "FOR THE GAMES LEFT" (review
 * 2 of #611, item 1). The reviewers' Dan: on the list the month was started
 * from, taken off after game 1, added back later for the games left. He
 * covers the games left from when he is back, never the whole month, by
 * every door:
 *
 *   the months page   "Add a player", "The games left"
 *   HQ                "@Match Time add Tom to the <month> list for the games left"
 *   HQ                "@Match Time Pat covers the games left" (added back first, words saying neither)
 *
 * £5 a game, this month's calendar, at least two games played and one
 * still to play. Real Postgres and routes; the monthly reader and the admin
 * extractor are stubbed ($0).
 */
import type { APIRequestContext } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ACTIVITY_ID, ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearMonthlyReaderStub, clearPipelineStubs, engineOn, setMonthlyReaderStub } from "../helpers/stub";
import { testDb, type TestDb } from "../helpers/test-db";
import { monthKickoffs } from "@/lib/month-signup-rules";
import { londonMonthStart, monthStartToDate } from "@/lib/squad-month-rules";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000094@g.us";
const SHARE = 500;
const MONTH_ID = "e2e-cov-seedret-month";
const THIS = londonMonthStart(new Date());
const CALENDAR = monthKickoffs(THIS, 2, "20:00");
const NOW = Date.now();
const PLAYED = CALENDAR.filter((k) => k.getTime() <= NOW).length;
const LEFT = CALENDAR.length - PLAYED;
const WHOLE = CALENDAR.length;
const MONTH = formatInTimeZone(CALENDAR[0], "Europe/London", "MMMM");
const MONTH_NO = Number(THIS.slice(5, 7));

const TOM_LEFT = `@Match Time add Tom to the ${MONTH} list for the games left`;
const PAT_ADD = `@Match Time add Pat to the ${MONTH} list`;
const PAT_LEFT = "@Match Time Pat covers the games left";
const ZARA_LEFT = `@Match Time add Zara to the ${MONTH} list for the games left`;
const ZARA_WHOLE = "@Match Time Zara covers the whole month";
const YES = "@Match Time yes";

const reading = (name: string) => ({
  kind: "signup", month: 0, gameDay: 0, listOf: "", benchPart: false, lines: [], residual: "", choice: "in",
  signupMonth: MONTH_NO, signupFor: "other", signupWho: "", signupName: name, signupPaid: false, signupPaidPence: 0, days: [], games: 0,
});
const facts = (refs: string[], coverage: "" | "whole" | "left") => ({ route: "admin_ops", facts: { action: "month_coverage", coveredRefs: refs, coverage, toMatchTime: true } });

const rowOf = (db: TestDb, userId: string) =>
  db.one<{ kind: string; out: boolean; gamesCovered: number; amountDuePence: number | null; source: string }>(
    `SELECT kind, ("leftAt" IS NOT NULL) AS out, "gamesCovered", "amountDuePence", source FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
    [MONTH_ID, userId],
  );

let seq = 0;
async function hq(request: APIRequestContext, text: string) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", botMentioned: true, groupId: HQ, messageId: `e2e-covseed-${++seq}`, text, senderPhone: PHONE.admin.replace(/^\+/, ""), timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{ outcome: string; replyText: string | null }>;
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(`UPDATE "Organisation" SET "squadMode" = 'monthly', "rollingSquadEnabled" = false, "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  if (PLAYED < 2 || LEFT < 1) return;
  // The month was counted an hour after it began; the seed list's players joined then.
  const startedAt = new Date(monthStartToDate(THIS).getTime() + 3600_000);
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart", "sharePerGamePence", "pricedAt", "startedMidMonthAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', $5, 0, $6, $7, $7, now())`,
    [MONTH_ID, ORG_ID, ACTIVITY_ID, THIS, WHOLE, SHARE, startedAt.toISOString()],
  );
  // Riley, Tom and Pat: on the seed list, taken off after game 1.
  const off = new Date(CALENDAR[0].getTime() + 24 * 3600_000).toISOString();
  for (const [i, userId] of [U.rater, U.third, U.player].entries()) {
    await db.run(
      `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", source, "joinedAt", "leftAt", "updatedAt")
       VALUES ($1, $2, $3, 'regular', $4, $5, 'seed-list', $6, $7, now())`,
      [`${MONTH_ID}-${userId}`, MONTH_ID, userId, i + 1, WHOLE, startedAt.toISOString(), off],
    );
  }
  // Zara played and PAID the first two games pay as you go (review 2 of #611, item 4).
  for (const i of [0, 1]) {
    await db.run(`INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 12, 'COMPLETED', $3, now())`, [
      `e2e-covseed-played-${i}`,
      ACTIVITY_ID,
      CALENDAR[i].toISOString(),
    ]);
    await db.run(`INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "paidAt", "updatedAt") VALUES ($1, $2, $3, 'CONFIRMED', 1, $4, now())`, [
      `e2e-covseed-zara-${i}`,
      `e2e-covseed-played-${i}`,
      U.extra,
      CALENDAR[i].toISOString(),
    ]);
  }
  setMonthlyReaderStub({ bodies: { [TOM_LEFT]: reading("Tom"), [PAT_ADD]: reading("Pat"), [ZARA_LEFT]: reading("Zara") } });
  engineOn({
    [TOM_LEFT]: facts(["Tom"], "left"),
    [PAT_ADD]: facts(["Pat"], ""),
    [PAT_LEFT]: facts(["Pat"], "left"),
    [ZARA_LEFT]: facts(["Zara"], "left"),
    [ZARA_WHOLE]: facts(["Zara"], "whole"),
    // A priced month: the change waits for YES (Kemal, 2026-11-18).
    [YES]: { route: "approve" },
  });
});

test.afterAll(() => {
  clearMonthlyReaderStub();
  clearPipelineStubs();
  resetDb();
});

test.beforeEach(() => {
  test.skip(PLAYED < 2 || LEFT < 1, "needs two games played this month and one still to come");
});

test("door 1, the months page: Riley back for the games left covers those games from now, £5 each", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/months");
  const add = page.getByTestId("month-card").getByTestId("member-add");
  await expect(add).toBeVisible({ timeout: 30_000 });
  await add.getByTestId("member-add-select").selectOption(U.rater);
  await add.getByTestId("member-add-cover-left").check();
  await add.getByTestId("member-add-regular").click();
  await expect.poll(async () => (await rowOf(db, U.rater))?.out, { timeout: 30_000 }).toBe(false);
  expect(await rowOf(db, U.rater)).toMatchObject({ kind: "regular", gamesCovered: LEFT, amountDuePence: SHARE * LEFT });
});

test("door 2, HQ: 'add Tom ... for the games left' covers the games left, £5 each", async ({ request, db }) => {
  const r = await hq(request, TOM_LEFT);
  expect(r.outcome, r.replyText ?? "").toBe("month-add-done");
  expect(await rowOf(db, U.third)).toMatchObject({ kind: "regular", out: false, gamesCovered: LEFT, amountDuePence: SHARE * LEFT });
});

test("door 3, HQ: Pat added back with words saying neither, then 'Pat covers the games left': the games left, never the whole month, £5 each", async ({ request, db }) => {
  const added = await hq(request, PAT_ADD);
  expect(added.outcome, added.replyText ?? "").toBe("month-add-done");
  expect(await rowOf(db, U.player)).toMatchObject({ kind: "regular", out: false, gamesCovered: LEFT });
  const r = await hq(request, PAT_LEFT);
  expect(r.outcome, r.replyText ?? "").toMatch(/coverage/);
  expect(await rowOf(db, U.player)).toMatchObject({ kind: "regular", gamesCovered: LEFT, amountDuePence: SHARE * LEFT });
});

test("review 2 of #611, item 4: Zara paid two games pay as you go, then is raised to the whole month: those two are never charged again", async ({ request, db }) => {
  expect((await hq(request, ZARA_LEFT)).outcome).toBe("month-add-done");
  expect(await rowOf(db, U.extra)).toMatchObject({ kind: "regular", gamesCovered: LEFT, amountDuePence: SHARE * LEFT });
  expect((await hq(request, ZARA_WHOLE)).outcome).toBe("hq-month-coverage-confirm");
  expect((await hq(request, YES)).outcome).toBe("hq-month-coverage-done");
  expect(await rowOf(db, U.extra)).toMatchObject({ kind: "regular", gamesCovered: WHOLE - 2, amountDuePence: SHARE * (WHOLE - 2) });
});
