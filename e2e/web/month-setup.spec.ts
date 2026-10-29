/**
 * Monthly squad set-up on /admin/months (2026-10-29, Vets MNF's Day 1):
 *
 *   - the COMING month is on the page before MatchTime opens it: the
 *     organiser pastes the group's list, checks it, gives a "4 only"
 *     regular 4 games, and starts the month. It is in sign-up, and nothing
 *     is posted straight away;
 *   - priced, the "4 only" regular is asked for 4 games, everyone else for
 *     the month; changing the games works the amount out again, and more
 *     games than the month has is refused in words;
 *   - a season break: ticking a month saves it; a month already started
 *     here cannot be one.
 *
 * No model is called anywhere in this spec.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { testDb } from "../helpers/test-db";
import { monthFixtureDates, londonMonthStart } from "@/lib/squad-month-rules";
import { nextMonthStart } from "@/lib/month-signup-rules";
import { moneyLabel } from "@/lib/club-billing-view";

test.describe.configure({ mode: "serial" });

const NEXT = nextMonthStart(londonMonthStart(new Date()));
const AFTER = nextMonthStart(NEXT);
const at = (m: string) => new Date(`${m}T12:00:00.000Z`);
const NEXT_NAME = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "Europe/London" }).format(at(NEXT));
/** The fixture club plays Tuesdays: the coming month's games, and a "N only" one fewer. */
const GAMES = monthFixtureDates(NEXT, 2).length;
const FEWER = GAMES - 1;
const NEXT_LABEL = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "Europe/London" }).format(at(NEXT));

async function outbound(): Promise<number> {
  const db = testDb();
  return (await db.count(`SELECT COUNT(*) FROM "BotJob"`)) + (await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE kind <> 'signup-list-seen'`));
}

test.beforeAll(async () => {
  resetDb();
  await testDb().run(`UPDATE "Organisation" SET "squadMode" = 'monthly', "rollingSquadEnabled" = false WHERE id = $1`, [ORG_ID]);
});
test.afterAll(() => resetDb());

test("the coming month: started from the group's pasted list, with a fewer-games regular, and nothing posted", async ({ page, db }) => {
  const before = await outbound();
  await signInAs(page, U.admin, "/admin/months");
  const card = page.getByTestId("next-month-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("next-month-held")).toHaveText(`MatchTime is not posting a list for ${NEXT_LABEL} until you start it here.`);

  await card.getByTestId("next-start-paste-text").fill([`List for ${NEXT_NAME}`, "1. Patso", "2. Riley", "3. Ben (PAYG)"].join("\n"));
  await card.getByTestId("next-start-paste-read").click();
  await expect(card.getByTestId("next-start-paste-note")).toContainText("Players read from your list: 3.");
  await expect(card.getByTestId("next-start-paste-month")).toHaveCount(0);
  // Nothing about this month's games played, or its price, on this form.
  await expect(card.getByTestId("next-start-played")).toHaveCount(0);
  await expect(card.getByTestId("next-start-share")).toHaveCount(0);
  await card.locator(`[data-testid="next-start-row"][data-user="${U.rater}"]`).getByTestId("next-start-committed").fill(String(FEWER));
  await card.getByTestId("next-start-submit").click();
  await expect(card.getByTestId("month-members")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("month-status")).toHaveText("Sign-up open");

  const month = await db.one<{ id: string; status: string; gamesScheduled: number }>(
    `SELECT id, status, "gamesScheduled" FROM "SquadMonth" WHERE "orgId" = $1 AND "monthStart" = $2::date`,
    [ORG_ID, NEXT],
  );
  expect(month).toMatchObject({ status: "open" });
  const rows = await db.all<{ userId: string; kind: string; gamesCommitted: number | null }>(
    `SELECT "userId", kind, "gamesCommitted" FROM "SquadMonthMember" WHERE "monthId" = $1 ORDER BY "userId"`,
    [month!.id],
  );
  expect(rows.find((r) => r.userId === U.rater)).toMatchObject({ kind: "regular", gamesCommitted: FEWER });
  expect(rows.find((r) => r.userId === U.player)).toMatchObject({ kind: "regular", gamesCommitted: null });
  expect(rows.find((r) => r.userId === U.bench)).toMatchObject({ kind: "payg" });
  // The group's own list: nothing queued for WhatsApp.
  expect(await outbound()).toBe(before);
});

test("priced: the fewer-games regular is asked for fewer games; changing the games works it out again; too many is refused", async ({ page, db }) => {
  const games = GAMES;
  await signInAs(page, U.admin, "/admin/months");
  const card = page.getByTestId("next-month-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByTestId("price-share").fill("7.50");
  await card.getByTestId("price-save").click();
  const row = (userId: string) => card.locator(`[data-testid="month-member"][data-user="${userId}"]`);
  await expect(row(U.rater)).toContainText(moneyLabel(750 * FEWER), { timeout: 30_000 });
  await expect(row(U.rater).getByTestId("member-games")).toHaveText(`${FEWER} of ${games}`);
  await expect(row(U.player)).toContainText(moneyLabel(750 * games));

  await row(U.player).getByTestId("member-games-input").fill("2");
  await row(U.player).getByTestId("member-games-save").click();
  await expect(row(U.player).getByTestId("member-games")).toHaveText(`2 of ${games}`, { timeout: 30_000 });
  await expect(row(U.player)).toContainText(moneyLabel(1500));
  const pat = await db.one<{ gamesCommitted: number; amountDuePence: number }>(
    `SELECT m."gamesCommitted", m."amountDuePence" FROM "SquadMonthMember" m JOIN "SquadMonth" s ON s.id = m."monthId" WHERE s."orgId" = $1 AND m."userId" = $2`,
    [ORG_ID, U.player],
  );
  expect(pat).toEqual({ gamesCommitted: 2, amountDuePence: 1500 });

  await row(U.player).getByTestId("member-games-input").fill(String(games + 1));
  await row(U.player).getByTestId("member-games-save").click();
  await expect(row(U.player).getByTestId("member-games-error")).toHaveText("That is more games than the month has.");
});

test("a season break: a month is ticked off and saved; a month already started here cannot be one", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/months");
  const form = page.getByTestId("season-break");
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.locator(`[data-testid="season-break-month"][data-month="${AFTER.slice(0, 7)}"]`).check();
  await form.getByTestId("season-break-save").click();
  await expect.poll(async () => (await db.one<{ m: string[] }>(`SELECT "seasonBreakMonths" AS m FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.m).toEqual([
    AFTER.slice(0, 7),
  ]);

  await form.locator(`[data-testid="season-break-month"][data-month="${NEXT.slice(0, 7)}"]`).check();
  await form.getByTestId("season-break-save").click();
  await expect(form.getByTestId("season-break-error")).toContainText("has already started here, so it can't be a break month");
  expect((await db.one<{ m: string[] }>(`SELECT "seasonBreakMonths" AS m FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.m).toEqual([AFTER.slice(0, 7)]);
});
