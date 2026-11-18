/**
 * A COVERAGE CHANGE ON A PAID ROW SHOWS THE MONEY (review of #611, round
 * 4, item 1: the #464 rule). What somebody who paid, or says so, paid is
 * written down BEFORE their amount moves (`freezePaidAmount`, as the games
 * writer does), so the months page shows "owes £X more" after a raise and
 * "£X to give back" after a lowering. Nothing is ever recorded as paid.
 *
 * This month, £7.50 a game, started here before its first game. Every
 * player below joined just after that first game, so he covers SINCE of
 * the WHOLE games, and may be raised to the whole month or brought back.
 *
 *   Ian    says paid (no amount), raised          owes one game more
 *   Cara   confirmed at SINCE games, raised       owes one game more
 *   Ben    says paid for the whole month, lowered one game to give back
 *   Tom    confirmed at the whole month, lowered  one game to give back
 *   Pat    confirmed before a price was set       owes one game more
 *          (pricing gave him an amount, the payment none), raised
 *
 * Real Postgres and the real page; no model is called ($0).
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ACTIVITY_ID, ORG_ID } from "../helpers/constants";
import { testDb, type TestDb } from "../helpers/test-db";
import { monthKickoffs } from "@/lib/month-signup-rules";
import { londonMonthStart, monthStartToDate } from "@/lib/squad-month-rules";
import { pounds } from "@/lib/month-payment-copy";

test.describe.configure({ mode: "serial" });

const SHARE = 750;
const MONTH_ID = "e2e-web-covmoney-month";
const THIS = londonMonthStart(new Date());
const CALENDAR = monthKickoffs(THIS, 2, "20:00");
const FIRST = CALENDAR[0];
const NOW = Date.now();
const WHOLE = CALENDAR.length;
const SINCE = WHOLE - 1;
const JOINED = new Date(FIRST.getTime() + 60 * 60_000);
const CONFIRMED_AT = new Date(NOW - 3600_000);

const money = (db: TestDb, userId: string) =>
  db.one<{ gamesCovered: number; amountDuePence: number | null; paidAmountPence: number | null; paidClaimedAmountPence: number | null; confirmed: boolean; claimed: boolean }>(
    `SELECT "gamesCovered", "amountDuePence", "paidAmountPence", "paidClaimedAmountPence", ("paidAt" IS NOT NULL) AS confirmed, ("paidClaimedAt" IS NOT NULL) AS claimed
       FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
    [MONTH_ID, userId],
  );

async function addRow(db: TestDb, userId: string, slot: number, o: { covered: number; due: number | null; claimed?: boolean; confirmedPence?: number | null }) {
  const confirmed = o.confirmedPence !== undefined;
  await db.run(
    `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "amountDuePence", "paidClaimedAt", "paidClaimSource", "paidAt", "paidAmountPence", "paidConfirmedByUserId", source, "joinedAt", "updatedAt")
     VALUES ($1, $2, $3, 'regular', $4, $5, $6, $7, $8, $9, $10, $11, 'admin', $12, now())`,
    [
      `${MONTH_ID}-${userId}`,
      MONTH_ID,
      userId,
      slot,
      o.covered,
      o.due,
      o.claimed ? CONFIRMED_AT.toISOString() : null,
      o.claimed ? "organiser" : null,
      confirmed ? CONFIRMED_AT.toISOString() : null,
      confirmed ? o.confirmedPence : null,
      confirmed ? U.collector : null,
      JOINED.toISOString(),
    ],
  );
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(`UPDATE "Organisation" SET "squadMode" = 'monthly', "rollingSquadEnabled" = false WHERE id = $1`, [ORG_ID]);
  const startedAt = new Date(monthStartToDate(THIS).getTime() + 3600_000);
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart", "sharePerGamePence", "pricedAt", "startedMidMonthAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', $5, 0, $6, $7, $7, now())`,
    [MONTH_ID, ORG_ID, ACTIVITY_ID, THIS, WHOLE, SHARE, startedAt.toISOString()],
  );
  await addRow(db, U.fresh, 1, { covered: SINCE, due: SHARE * SINCE, claimed: true });
  await addRow(db, U.extra, 2, { covered: SINCE, due: SHARE * SINCE, confirmedPence: SHARE * SINCE });
  await addRow(db, U.bench, 3, { covered: WHOLE, due: SHARE * WHOLE, claimed: true });
  await addRow(db, U.third, 4, { covered: WHOLE, due: SHARE * WHOLE, confirmedPence: SHARE * WHOLE });
  // Confirmed before a price was set: pricing then gave him an amount
  // (`priceMonth`, a paid row with none), the payment none.
  await addRow(db, U.player, 5, { covered: SINCE, due: SHARE * SINCE, confirmedPence: null });
});
test.afterAll(() => resetDb());

test.beforeEach(() => {
  test.skip(FIRST.getTime() > NOW || WHOLE - SINCE !== 1, "needs this month's first Tuesday behind us");
});

const card = (page: import("@playwright/test").Page) => page.getByTestId("month-card");
const row = (page: import("@playwright/test").Page, userId: string) => card(page).locator(`[data-testid="month-member"][data-user="${userId}"]`);

async function setCover(page: import("@playwright/test").Page, userId: string, games: number) {
  const r = row(page, userId);
  await r.getByTestId("member-cover-select").selectOption(String(games));
  await r.getByTestId("member-cover-save").click();
  await expect(r.getByTestId("member-cover-error")).toHaveCount(0);
}

test("raised and lowered paid rows: the page shows what is owed or to give back; nothing is recorded as paid", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/months");
  await expect(row(page, U.fresh).getByTestId("member-cover-select")).toBeVisible({ timeout: 30_000 });

  // Ian says he paid (no amount): what he was asked for is written down first.
  await setCover(page, U.fresh, WHOLE);
  await expect(row(page, U.fresh).getByTestId("member-balance")).toHaveText(`owes ${pounds(SHARE)} more`, { timeout: 30_000 });
  expect(await money(db, U.fresh)).toMatchObject({ gamesCovered: WHOLE, amountDuePence: SHARE * WHOLE, paidClaimedAmountPence: SHARE * SINCE, confirmed: false, claimed: true });

  // Cara's confirmed payment stays what it was.
  await setCover(page, U.extra, WHOLE);
  await expect(row(page, U.extra).getByTestId("member-balance")).toHaveText(`owes ${pounds(SHARE)} more`, { timeout: 30_000 });
  expect(await money(db, U.extra)).toMatchObject({ gamesCovered: WHOLE, amountDuePence: SHARE * WHOLE, paidAmountPence: SHARE * SINCE, confirmed: true });

  // Ben said he paid the whole month; lowered, one game is his to get back.
  await setCover(page, U.bench, SINCE);
  await expect(row(page, U.bench).getByTestId("member-balance")).toHaveText(`${pounds(SHARE)} to give back`, { timeout: 30_000 });
  expect(await money(db, U.bench)).toMatchObject({ gamesCovered: SINCE, amountDuePence: SHARE * SINCE, paidClaimedAmountPence: SHARE * WHOLE, claimed: true, confirmed: false });

  // Tom's confirmed whole month, lowered.
  await setCover(page, U.third, SINCE);
  await expect(row(page, U.third).getByTestId("member-balance")).toHaveText(`${pounds(SHARE)} to give back`, { timeout: 30_000 });
  expect(await money(db, U.third)).toMatchObject({ gamesCovered: SINCE, amountDuePence: SHARE * SINCE, paidAmountPence: SHARE * WHOLE, confirmed: true });

  // Pat was confirmed before there was a price: his payment is written down
  // as what he was then asked for, so the raise shows.
  await setCover(page, U.player, WHOLE);
  await expect(row(page, U.player).getByTestId("member-balance")).toHaveText(`owes ${pounds(SHARE)} more`, { timeout: 30_000 });
  expect(await money(db, U.player)).toMatchObject({ gamesCovered: WHOLE, amountDuePence: SHARE * WHOLE, paidAmountPence: SHARE * SINCE, confirmed: true });
});
