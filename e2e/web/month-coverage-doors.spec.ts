/**
 * ONE "WHOLE MONTH, ALREADY PAID" ADD, THE SAME MONEY BY EVERY ADD DOOR
 * (review of #611, round 2, item 2). Paying meets coverage ONLY in an add
 * whose own words say both, for the player added (round 4, option a): the
 * coverage checked, then the sign-up, then the says-paid claim, then the
 * coverage the claim is for. Each such door leaves the row a seeded
 * says-paid regular has: priced as one who says he paid, and the
 * called-off week's credit kept for a later month (not used now).
 *
 * The fixture, the reviewers' shape on this month's calendar: £7.50 a
 * game, games already played, the next game called off before anybody
 * was added. The add doors:
 *
 *   the months page   "Add a player", "The whole month" (no payment: Kemal, 2026-11-18)
 *   HQ, said          "@Match Time add Zara ..., he's paid the whole month"
 *
 * and a regular seeded with the month who says he paid, for comparison.
 *
 * Everything else that changes coverage never records, changes or clears
 * a claim, and keeps what he paid or says he paid (round 4, option a):
 *
 *   - "add Ben ..., he's paid", then a plain "whole month", and "add Tom
 *     ..., he's paid", then "Tom covers the whole month": the SAME row,
 *     owing the difference, and the reply says how much;
 *   - "add Riley ..., he's paid the whole month" for one already on the
 *     month: his coverage, never a claim (a known limit, as before);
 *   - "Riley paid for the whole month", read as the monthly reader reads a
 *     sign-up and the admin extractor as not coverage: "already on the
 *     list", nothing recorded, as on main;
 *   - "add Pat for the games left, and Riley covers the whole month": Pat
 *     gets the games left, never Riley's coverage (round 4, item 3).
 *
 * Real Postgres and routes; the monthly reader, router and admin extractor
 * are stubbed. No model is called ($0).
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
import { pounds } from "@/lib/month-payment-copy";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000093@g.us";
const SHARE = 750;
const MONTH_ID = "e2e-cov-doors-month";
const OFF_ID = "e2e-cov-doors-off";
const THIS = londonMonthStart(new Date());
/** The seeded fixture: Tuesdays at 20:00. */
const CALENDAR = monthKickoffs(THIS, 2, "20:00");
const NOW = Date.now();
const PLAYED = CALENDAR.filter((k) => k.getTime() <= NOW).length;
const FUTURE = CALENDAR.filter((k) => k.getTime() > NOW);
/** The next game, called off before anybody was added. */
const OFF = FUTURE[0];
const WHOLE = CALENDAR.length;
const MONTH = formatInTimeZone(CALENDAR[0], "Europe/London", "MMMM");
const MONTH_NO = Number(THIS.slice(5, 7));

const ADD_SAID = `@Match Time add Zara to the ${MONTH} list, he's paid the whole month`;
const ADD_ASKED = `@Match Time add Ben to the ${MONTH} list, he's paid`;
const ANSWER = "@Match Time whole month";
const TOM_ASKED = `@Match Time add Tom to the ${MONTH} list, he's paid`;
const TOM_BY_NAME = "@Match Time Tom covers the whole month";
const YES = "@Match Time yes";
const RILEY_LEFT = `@Match Time add Riley to the ${MONTH} list for the games left`;
const RILEY_ADD_PAID = `@Match Time add Riley to the ${MONTH} list, he's paid the whole month`;
const RILEY_PAID = "@Match Time Riley paid for the whole month";
const PAT_AND_RILEY = `@Match Time add Pat to the ${MONTH} list for the games left, and Riley covers the whole month`;
const PAT_PAID = `@Match Time add Pat to the ${MONTH} list, he's paid`;

const reading = (name: string, paid = true) => ({
  kind: "signup", month: 0, gameDay: 0, listOf: "", benchPart: false, lines: [], residual: "", choice: "in",
  signupMonth: MONTH_NO, signupFor: "other", signupWho: "", signupName: name, signupPaid: paid, signupPaidPence: 0, days: [], games: 0,
});
const facts = (refs: string[], coverage: "" | "whole" | "left", route = "admin_ops") => ({
  route,
  facts: { action: "month_coverage", coveredRefs: refs, coverage, toMatchTime: true },
});
const notCoverage = { route: "admin_ops", facts: { action: "other", coveredRefs: [], coverage: "", toMatchTime: true } };

/** What a door leaves: the row's money, and the called-off week's credit. */
async function moneyOf(db: TestDb, userId: string) {
  const row = await db.one<Record<string, unknown>>(
    `SELECT "gamesCovered", "gamesCommitted", "creditsApplied", "amountDuePence", ("paidAt" IS NOT NULL) AS confirmed, ("paidClaimedAt" IS NOT NULL) AS claimed, "paidClaimSource", "paidClaimedAmountPence"
       FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
    [MONTH_ID, userId],
  );
  const credits = await db.all<{ appliedMonthId: string | null }>(
    `SELECT "appliedMonthId" FROM "SquadCredit" WHERE "userId" = $1 AND "earnedMatchId" = $2 AND reason = 'cancelled-week' AND "voidedAt" IS NULL`,
    [userId, OFF_ID],
  );
  return { ...row, weekOffCredits: credits.length, weekOffUsedNow: credits.filter((c) => c.appliedMonthId !== null).length };
}

let seq = 0;
async function hq(request: APIRequestContext, text: string) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", botMentioned: true, groupId: HQ, messageId: `e2e-covdoors-${++seq}`, text, senderPhone: PHONE.admin.replace(/^\+/, ""), timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{ outcome: string; replyText: string | null }>;
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(`UPDATE "Organisation" SET "squadMode" = 'monthly', "rollingSquadEnabled" = false, "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  if (!OFF) return;
  const startedAt = new Date(monthStartToDate(THIS).getTime() + 3600_000);
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart", "sharePerGamePence", "pricedAt", "startedMidMonthAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', $5, 0, $6, $7, $7, now())`,
    [MONTH_ID, ORG_ID, ACTIVITY_ID, THIS, WHOLE, SHARE, startedAt.toISOString()],
  );
  // The next game, called off an hour ago.
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 10, 'CANCELLED', $3, $4)`,
    [OFF_ID, ACTIVITY_ID, OFF.toISOString(), new Date(NOW - 3600_000).toISOString()],
  );
  // Colin was on the list the month was started from, and says he paid.
  await db.run(
    `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "amountDuePence", "paidClaimedAt", "paidClaimSource", source, "joinedAt", "updatedAt")
     VALUES ($1, $2, $3, 'regular', 1, $4, $5, $6, 'organiser', 'seed-tick', $6, now())`,
    [`${MONTH_ID}-colin`, MONTH_ID, U.collector, WHOLE, SHARE * WHOLE, startedAt.toISOString()],
  );
  setMonthlyReaderStub({
    bodies: {
      [ADD_SAID]: reading("Zara"),
      [ADD_ASKED]: reading("Ben"),
      [TOM_ASKED]: reading("Tom"),
      [RILEY_LEFT]: reading("Riley", false),
      [RILEY_ADD_PAID]: reading("Riley"),
      // As the monthly reader's prompt reads "<name> has paid": a sign-up, paid.
      [RILEY_PAID]: reading("Riley"),
      [PAT_AND_RILEY]: reading("Pat", false),
      [PAT_PAID]: reading("Pat"),
    },
  });
  engineOn({
    [ADD_SAID]: facts(["Zara"], "whole"),
    [ADD_ASKED]: facts(["Ben"], ""),
    [ANSWER]: facts([], "whole", "none"),
    [TOM_ASKED]: facts(["Tom"], ""),
    [TOM_BY_NAME]: facts(["Tom"], "whole"),
    // Kemal, 2026-11-18: a change that affects money waits for YES.
    [YES]: { route: "approve" },
    [RILEY_LEFT]: facts(["Riley"], "left"),
    [RILEY_ADD_PAID]: facts(["Riley"], "whole"),
    // The prompt: saying only that somebody has paid is not month_coverage.
    [RILEY_PAID]: notCoverage,
    [PAT_AND_RILEY]: facts(["Pat", "Riley"], ""),
    [PAT_PAID]: facts(["Pat"], ""),
  });
});

test.afterAll(() => {
  clearMonthlyReaderStub();
  clearPipelineStubs();
  resetDb();
});

test.beforeEach(() => {
  test.skip(PLAYED < 1 || FUTURE.length < 2, "needs a game played this month and two still to come");
});

test("the add doors: HQ said leaves the seeded says-paid regular's row; the months page records no payment (Kemal, 2026-11-18)", async ({ page, request, db }) => {
  // Door 1: the months page.
  await signInAs(page, U.admin, "/admin/months");
  const add = page.getByTestId("month-card").getByTestId("member-add");
  await expect(add).toBeVisible({ timeout: 30_000 });
  await add.getByTestId("member-add-select").selectOption(U.fresh);
  await add.getByTestId("member-add-cover-whole").check();
  await add.getByTestId("member-add-regular").click();
  await expect(page.locator(`[data-testid="month-member"][data-user="${U.fresh}"]`)).toBeVisible({ timeout: 30_000 });

  // Door 2: HQ, the add's own words say paid and the whole month.
  expect((await hq(request, ADD_SAID)).outcome).toBe("month-add-done");

  const seeded = await moneyOf(db, U.collector);
  // A seeded says-paid regular: the whole month, priced as one who says he
  // paid, the week off credited and kept for a later month.
  expect(seeded).toMatchObject({ gamesCovered: WHOLE, creditsApplied: 0, amountDuePence: SHARE * WHOLE, confirmed: false, claimed: true, paidClaimSource: "organiser", paidClaimedAmountPence: null, weekOffCredits: 1, weekOffUsedNow: 0 });
  // The months page records no payment (Kemal, 2026-11-18): the whole month, unpaid.
  expect(await moneyOf(db, U.fresh)).toMatchObject({ gamesCovered: WHOLE, confirmed: false, claimed: false, paidClaimSource: null });
  expect(await moneyOf(db, U.extra)).toEqual(seeded);
});

test("round 4, item 3: a plain answer and a by-name answer to the same question give the SAME row, owing the difference, and the reply says how much", async ({ request, db }) => {
  // Ben: "he's paid" with no coverage, then a plain "whole month".
  expect((await hq(request, ADD_ASKED)).outcome).toBe("month-add-done");
  const plain = await hq(request, ANSWER);
  expect(plain.outcome).toBe("hq-month-coverage-done");
  // Tom: the same add, then answered by name.
  expect((await hq(request, TOM_ASKED)).outcome).toBe("month-add-done");
  // By name: the change and its money first, applied on YES (Kemal, 2026-11-18).
  expect((await hq(request, TOM_BY_NAME)).outcome).toBe("hq-month-coverage-confirm");
  const byName = await hq(request, YES);
  expect(byName.outcome).toBe("hq-month-coverage-done");

  const ben = (await moneyOf(db, U.bench)) as Record<string, unknown>;
  const tom = (await moneyOf(db, U.third)) as Record<string, unknown>;
  expect(tom).toEqual(ben);
  // His claim was for the games left when he was added: kept, never cleared.
  expect(ben).toMatchObject({ gamesCovered: WHOLE, claimed: true, confirmed: false });
  expect(ben.paidClaimedAmountPence).not.toBeNull();
  const owes = Number(ben.amountDuePence) - Number(ben.paidClaimedAmountPence);
  expect(owes).toBeGreaterThan(0);
  const line = `He still shows ${pounds(owes)} to pay.`;
  expect(plain.replyText).toContain(line);
  expect(byName.replyText).toContain(line);
});

test("round 4, option a: 'he's paid the whole month' for one already on the month changes his coverage, never a claim; 'Riley paid for the whole month' goes where main sends it", async ({ request, db }) => {
  expect((await hq(request, RILEY_LEFT)).outcome).toBe("month-add-done");
  const before = (await moneyOf(db, U.rater)) as Record<string, unknown>;
  expect(before).toMatchObject({ claimed: false });
  expect(Number(before.gamesCovered)).toBeLessThan(WHOLE);

  // Already on the month: the coverage changes; "he's paid" records nothing (a known limit, as main).
  const asked = await hq(request, RILEY_ADD_PAID);
  expect(asked.outcome, asked.replyText ?? "").toBe("month-coverage-confirm");
  const r = await hq(request, YES);
  expect(r.outcome, r.replyText ?? "").toBe("hq-month-coverage-done");
  const after = (await moneyOf(db, U.rater)) as Record<string, unknown>;
  // The whole month, less the games he paid as pay as you go before he
  // joined (review 2 of #611, item 4; the seed world's paid game for him).
  const paygPaid = (await db.one<{ n: number }>(
    `SELECT COUNT(DISTINCT (a."matchId"))::int AS n FROM "Attendance" a JOIN "Match" m ON m.id = a."matchId"
      WHERE a."userId" = $1 AND a.status = 'CONFIRMED' AND (a."paidAt" IS NOT NULL OR a."paidViaUserId" IS NOT NULL)
        AND m."activityId" = $2 AND m.status <> 'CANCELLED' AND m.date >= $3 AND m.date < (SELECT "joinedAt" FROM "SquadMonthMember" WHERE "monthId" = $4 AND "userId" = $1)`,
    [U.rater, ACTIVITY_ID, monthStartToDate(THIS).toISOString(), MONTH_ID],
  ))!.n;
  expect(after).toMatchObject({ gamesCovered: WHOLE - paygPaid, claimed: false, confirmed: false, paidClaimedAmountPence: null });

  // Read as a sign-up by the monthly reader and as not coverage by the admin
  // extractor: "already on the list", nothing recorded, exactly as main does.
  const paid = await hq(request, RILEY_PAID);
  expect(paid.outcome).toBe("month-add-already");
  expect(await moneyOf(db, U.rater)).toEqual(after);
});

test("round 4, item 3: the add's coverage words naming somebody else give the player added none of it", async ({ request, db }) => {
  const before = await moneyOf(db, U.rater);
  const r = await hq(request, PAT_AND_RILEY);
  expect(r.outcome).toBe("month-add-done");
  // Pat is on for the games left (no coverage of Riley's put on him) ...
  const pat = (await moneyOf(db, U.player)) as Record<string, unknown>;
  expect(Number(pat.gamesCovered)).toBeLessThan(WHOLE);
  expect(pat.claimed).toBe(false);
  // ... Riley is left as he was, and the reply says so.
  expect(await moneyOf(db, U.rater)).toEqual(before);
  expect(r.replyText).toContain('I didn\'t change what Riley covers: tag me about that in a message of its own, for example "@Match Time Riley covers the whole month".');
});

test("known limit (as main): 'add Pat, he's paid' for one already on the month records nothing", async ({ request, db }) => {
  const before = await moneyOf(db, U.player);
  const r = await hq(request, PAT_PAID);
  expect(r.outcome).not.toBe("month-coverage-done");
  expect(await moneyOf(db, U.player)).toEqual(before);
});
