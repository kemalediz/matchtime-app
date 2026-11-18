/**
 * WHAT A MONTHLY REGULAR COVERS, ON /admin/months (2026-11-16, Kemal, and
 * the review of PR #611).
 *
 * A player added to a month already under way covered only the games
 * left, even one who paid the whole month from the organiser's pre-paid
 * list, and nothing could raise it. The fixture: this month, priced at
 * £7.50, started part-way here, its FIRST game called off; players who
 * joined just after that first game, with games played since.
 *
 *   - "Add a player" asks first: the whole month (already paid, its
 *     PLAYABLE games named) or the games left. The whole month is the
 *     seed's rule, records the organiser's "says paid" claim (item 5), and
 *     is credited for the called-off week as a seeded regular is (item 7);
 *   - the coverage editor offers only the bounds the server checks (item
 *     1): never fewer than he played since he joined plus the games left,
 *     so the games already played are never cut; a seeded regular has no
 *     editor at all; it refuses fewer games than the credits, in words;
 *   - nothing is paid by any of it, and nothing is queued for WhatsApp.
 *
 * Real Postgres and the real pages; no model is called anywhere here ($0).
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ACTIVITY_ID, ORG_ID } from "../helpers/constants";
import { testDb, type TestDb } from "../helpers/test-db";
import { monthKickoffs } from "@/lib/month-signup-rules";
import { londonMonthStart, monthStartToDate } from "@/lib/squad-month-rules";

test.describe.configure({ mode: "serial" });

const SHARE = 750;
const MONTH_ID = "e2e-web-cov-month";
const CANCELLED_ID = "e2e-web-cov-off";
const THIS = londonMonthStart(new Date());
/** The seeded fixture: Tuesdays at 20:00. The FIRST is called off. */
const CALENDAR = monthKickoffs(THIS, 2, "20:00");
const FIRST = CALENDAR[0];
const GAMES = CALENDAR.slice(1);
const NOW = Date.now();
const LEFT = GAMES.filter((k) => k.getTime() > NOW).length;
/** The whole month, as the seed counts it: the called-off week included. */
const WHOLE = CALENDAR.length;
const PLAYABLE = WHOLE - 1;
/**
 * Joined just after the SECOND game (the first was called off, the second
 * played): covered for every game since, one played game fewer than the
 * playable month, so raising him to the whole month is a real change.
 */
const JOINED = new Date(CALENDAR[1].getTime() + 60 * 60_000);
const SINCE = CALENDAR.length - 2;
/** The add's "games left": at least one. */
const LOW = Math.max(1, LEFT);

const member = (db: TestDb, userId: string) =>
  db.one<{ kind: string; gamesCovered: number; gamesCommitted: number | null; amountDuePence: number | null; paidAt: Date | null; claimed: boolean; source: string }>(
    `SELECT kind, "gamesCovered", "gamesCommitted", "amountDuePence", "paidAt", ("paidClaimedAt" IS NOT NULL) AS claimed, source
       FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
    [MONTH_ID, userId],
  );
const cancelledCredits = (db: TestDb, userId: string) =>
  db.count(`SELECT COUNT(*) FROM "SquadCredit" WHERE "userId" = $1 AND "earnedMatchId" = $2 AND reason = 'cancelled-week' AND "voidedAt" IS NULL`, [userId, CANCELLED_ID]);

async function outbound(): Promise<number> {
  return testDb().count(`SELECT COUNT(*) FROM "BotJob"`);
}

async function addRow(db: TestDb, userId: string, o: { slot: number; covered: number; source?: string; claimed?: boolean; credits?: number; due?: number | null }) {
  await db.run(
    `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "creditsApplied", "amountDuePence", "paidClaimedAt", "paidClaimSource", source, "joinedAt", "updatedAt")
     VALUES ($1, $2, $3, 'regular', $4, $5, $6, $7, $8, $9, $10, $11, now())`,
    [
      `${MONTH_ID}-${userId}`,
      MONTH_ID,
      userId,
      o.slot,
      o.covered,
      o.credits ?? 0,
      o.due === undefined ? SHARE * Math.max(0, o.covered - (o.credits ?? 0)) : o.due,
      o.claimed ? new Date().toISOString() : null,
      o.claimed ? "organiser" : null,
      o.source ?? "admin",
      o.source?.startsWith("seed") ? new Date(monthStartToDate(THIS).getTime() + 3600_000).toISOString() : JOINED.toISOString(),
    ],
  );
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(`UPDATE "Organisation" SET "squadMode" = 'monthly', "rollingSquadEnabled" = false WHERE id = $1`, [ORG_ID]);
  const startedAt = new Date(monthStartToDate(THIS).getTime() + 3600_000);
  // This month, started here before its first game, priced.
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "gamesPlayedBeforeStart", "sharePerGamePence", "pricedAt", "startedMidMonthAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', $5, 0, $6, $7, $7, now())`,
    [MONTH_ID, ORG_ID, ACTIVITY_ID, THIS, WHOLE, SHARE, startedAt.toISOString()],
  );
  // Its first game, called off (an hour before it).
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 10, 'CANCELLED', $3, $4)`,
    [CANCELLED_ID, ACTIVITY_ID, FIRST.toISOString(), new Date(FIRST.getTime() - 3600_000).toISOString()],
  );
  // Riley joined after it, for the games since, and says he paid.
  await addRow(db, U.rater, { slot: 1, covered: SINCE, claimed: true });
  // Tom joined after it too, but on the whole month.
  await addRow(db, U.third, { slot: 2, covered: WHOLE });
  // Pat: the whole month, with a credit taken off it for every game.
  await addRow(db, U.player, { slot: 3, covered: WHOLE, credits: WHOLE, due: 0, claimed: true });
  // Colin was on the organiser's list when the month was started here.
  await addRow(db, U.collector, { slot: 4, covered: WHOLE, source: "seed-tick" });
});
test.afterAll(() => resetDb());

test.beforeEach(() => {
  test.skip(CALENDAR[1].getTime() > NOW, "needs this month's first two Tuesdays behind us");
});

const card = (page: import("@playwright/test").Page) => page.getByTestId("month-card");
const row = (page: import("@playwright/test").Page, userId: string) => card(page).locator(`[data-testid="month-member"][data-user="${userId}"]`);

test("Add a player in a month under way: the whole month (its playable games, says paid, credited for the week off) or the games left", async ({ page, db }) => {
  const before = await outbound();
  await signInAs(page, U.admin, "/admin/months");
  const add = card(page).getByTestId("member-add");
  await expect(add).toBeVisible({ timeout: 30_000 });
  const choice = add.getByTestId("member-add-cover");
  await expect(choice).toContainText("The month has started. They cover:");
  // Item 7: the week called off is not a game the form counts.
  await expect(choice).toContainText(`The whole month, already paid (${PLAYABLE} games)`);
  await expect(choice).toContainText(`The games left (${LEFT})`);

  // Not before a choice: a regular's coverage is never guessed.
  await add.getByTestId("member-add-select").selectOption(U.fresh);
  await expect(add.getByTestId("member-add-regular")).toBeDisabled();
  await add.getByTestId("member-add-cover-whole").check();
  await add.getByTestId("member-add-regular").click();
  await expect(row(page, U.fresh).locator("[data-kind]")).toHaveText("Regular", { timeout: 30_000 });
  // The whole month by the seed's rule; the organiser's "says paid" claim
  // (item 5), never a confirmation; credited for the week off as a seeded
  // regular is (item 7). The claim comes first (round 2, item 2), so, as a
  // seeded says-paid regular, the credit is kept for a later month and
  // what he is asked for is the whole month.
  await expect.poll(() => cancelledCredits(db, U.fresh)).toBe(1);
  expect(await member(db, U.fresh)).toMatchObject({ kind: "regular", gamesCovered: WHOLE, amountDuePence: SHARE * WHOLE, paidAt: null, claimed: true, source: "admin" });

  await add.getByTestId("member-add-select").selectOption(U.bench);
  await add.getByTestId("member-add-cover-left").check();
  await add.getByTestId("member-add-regular").click();
  await expect(row(page, U.bench).locator("[data-kind]")).toHaveText("Regular", { timeout: 30_000 });
  expect(await member(db, U.bench)).toMatchObject({ kind: "regular", gamesCovered: LOW, paidAt: null, claimed: false });
  expect(await cancelledCredits(db, U.bench)).toBe(0);

  // Pay as you go needs no choice.
  await add.getByTestId("member-add-select").selectOption(U.extra);
  await add.getByTestId("member-add-payg").click();
  await expect(row(page, U.extra).locator("[data-kind]")).toHaveText("PAYG", { timeout: 30_000 });
  expect(await outbound()).toBe(before);
});

test("the editor: the games he played are never cut (item 1); raised to the whole month he owes it and is credited for the week off; nothing is paid", async ({ page, db }) => {
  const before = await outbound();
  await signInAs(page, U.admin, "/admin/months");
  const riley = row(page, U.rater);
  const select = riley.getByTestId("member-cover-select");
  await expect(select).toHaveValue(String(SINCE), { timeout: 30_000 });
  // Only what the server allows: from the games since he joined to the whole month.
  await expect(select.locator("option")).toHaveText([`${SINCE} of ${PLAYABLE}, the fewest (played since joining, weeks off credited, and left)`, `${PLAYABLE} of ${PLAYABLE}, the whole month`]);
  await expect(riley.getByTestId("member-cover-save")).toHaveCount(0);

  await select.selectOption(String(WHOLE));
  await riley.getByTestId("member-cover-save").click();
  // The games column reads it as the editor does: in playable games (round 4, item 6).
  await expect(riley.getByTestId("member-games")).toHaveText(String(PLAYABLE), { timeout: 30_000 });
  // He says he paid for the games since he joined: that amount is kept (round
  // 4, item 1). Now he owes more than he paid, so the week off is credited and
  // comes off this month at once (the #464 rule for one who paid but still
  // owes): asked for the whole month less it, owing the one game between.
  expect(await member(db, U.rater)).toMatchObject({ gamesCovered: WHOLE, amountDuePence: SHARE * (WHOLE - 1), paidAt: null, claimed: true });
  await expect.poll(() => cancelledCredits(db, U.rater)).toBe(1);
  await expect(riley.getByTestId("member-balance")).toHaveText(`owes £${((SHARE * (WHOLE - 1 - SINCE)) / 100).toFixed(2)} more`);

  // A seeded regular counts from the month's first game: no editor at all.
  await expect(row(page, U.collector).getByTestId("member-cover-form")).toHaveCount(0);
  expect(await outbound()).toBe(before);
});

test("round 2, item 1: a whole-month member credited for the week off is never lowered past it; credits refuse in words", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/months");
  await expect(row(page, U.rater).getByTestId("member-games")).toHaveText(String(PLAYABLE), { timeout: 30_000 });
  // Tom covers the whole month and was credited for the week called off. His
  // floor is the games since he joined, that credited week and the games
  // left (stored), read as the games left of the playable month: nothing
  // below it is offered.
  expect(await cancelledCredits(db, U.third)).toBe(1);
  const tom = row(page, U.third).getByTestId("member-cover-select");
  await expect(tom).toHaveValue(String(WHOLE));
  // Every game since he joined is played or left (SINCE), whatever today's
  // date: the floor is those plus the credited week (2026-11-18: written as
  // LEFT + 1, it failed once a game had been played since he joined).
  const floor = SINCE + 1;
  await expect(tom.locator("option").first()).toHaveAttribute("value", String(floor));
  await expect(tom.locator("option").first()).toHaveText(`${SINCE} of ${PLAYABLE}, the fewest (played since joining, weeks off credited, and left)`);

  // Pat has credits for every game of the month: covering fewer would break the CHECK.
  const pat = row(page, U.player);
  await pat.getByTestId("member-cover-select").selectOption(String(floor));
  await pat.getByTestId("member-cover-save").click();
  await expect(pat.getByTestId("member-cover-error")).toHaveText("They have more credits taken off this month than that. Take a credit back first.");
  expect(await member(db, U.player)).toMatchObject({ gamesCovered: WHOLE });

  // A regular added for the games left keeps his editor, from them up.
  const ben = row(page, U.bench).getByTestId("member-cover-select");
  await expect(ben).toHaveValue(String(LOW));
  await expect(ben.locator("option").first()).toHaveText(`${LOW} of ${PLAYABLE}, the fewest (played since joining, weeks off credited, and left)`);
});

test("in Turkish", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  try {
    await signInAs(page, U.admin, "/admin/months");
    const add = card(page).getByTestId("member-add");
    await expect(add.getByTestId("member-add-cover")).toContainText("Ay başladı. Oyuncunun kapsadığı:", { timeout: 30_000 });
    await expect(add.getByTestId("member-add-cover")).toContainText(`Ayın tamamı, ödendi (${PLAYABLE} maç)`);
    await expect(row(page, U.bench).getByText("Kapsadığı")).toBeVisible();
  } finally {
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  }
});

test("round 4, item 6: the games column and a '4 only' read the editor's playable number, never the stored whole month", async ({ page, db }) => {
  // Colin covers the whole month (the called-off week included, as stored)
  // and said he plays one game fewer than the playable month.
  await db.run(`UPDATE "SquadMonthMember" SET "gamesCommitted" = $3 WHERE "monthId" = $1 AND "userId" = $2`, [MONTH_ID, U.collector, PLAYABLE - 1]);
  await signInAs(page, U.admin, "/admin/months");
  await expect(row(page, U.collector).getByTestId("member-games")).toHaveText(`${PLAYABLE - 1} of ${PLAYABLE}`, { timeout: 30_000 });
  await expect(row(page, U.third).getByTestId("member-games")).toHaveText(String(PLAYABLE));
});
