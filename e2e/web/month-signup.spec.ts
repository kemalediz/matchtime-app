/**
 * Monthly squad, slice 3 (MDs/monthly-squad-plan-2026-10-05.md, sections
 * 4.1, 9.2 and 9.3): the player's own sign-up page (/month) and the
 * sign-ups on /admin/months.
 *
 *   - a WEEKLY club has no /month page (404);
 *   - a player of a monthly club signs up for next month: in, pay as you
 *     go on the games they tick, not this month;
 *   - somebody who says they have paid cannot move themselves;
 *   - the organiser sees next month's sign-ups, PAYG players and who is
 *     waiting, and can make a waiting player a regular, move a regular to
 *     PAYG and take somebody off the month;
 *   - a player reaches none of the organiser's buttons;
 *   - nothing here is ever queued for WhatsApp, and no model is called.
 */
import { formatInTimeZone } from "date-fns-tz";
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ACTIVITY_ID, NAME, ORG_ID } from "../helpers/constants";
import { testDb, type TestDb } from "../helpers/test-db";
import { monthKickoffs, nextMonthStart } from "@/lib/month-signup-rules";
import { londonMonthStart } from "@/lib/squad-month-rules";

test.describe.configure({ mode: "serial" });

const LONDON = "Europe/London";
const NEXT = nextMonthStart(londonMonthStart(new Date()));
/** The seeded fixture: Tuesday, 20:00. */
const KICKOFFS = monthKickoffs(NEXT, 2, "20:00");
const DAYS = KICKOFFS.map((k) => Number(formatInTimeZone(k, LONDON, "d")));
const MONTH_NAME = formatInTimeZone(KICKOFFS[0], LONDON, "MMMM");
const MONTH_YEAR = formatInTimeZone(KICKOFFS[0], LONDON, "MMMM yyyy");
const MONTH_ID = "e2e-web-su-month";
const matchId = (i: number) => `e2e-web-su-match-${i}`;

async function setMode(mode: "weekly" | "monthly") {
  await testDb().run(`UPDATE "Organisation" SET "squadMode" = $2 WHERE id = $1`, [ORG_ID, mode]);
}

async function outbound(): Promise<number> {
  const db = testDb();
  return (await db.count(`SELECT COUNT(*) FROM "BotJob"`)) + (await db.count(`SELECT COUNT(*) FROM "SentNotification"`));
}

const member = (db: TestDb, userId: string) =>
  db.one<{ kind: string; slot: number | null; note: string | null; out: boolean; source: string; paygMatchIds: string[]; gamesCovered: number }>(
    `SELECT kind, slot, note, ("leftAt" IS NOT NULL) AS out, source, "paygMatchIds", "gamesCovered"
       FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
    [MONTH_ID, userId],
  );

async function addMember(db: TestDb, userId: string, o: { kind?: string; slot: number | null; note?: string | null; paid?: boolean }) {
  await db.run(
    `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, note, "gamesCovered", "paidClaimedAt", "paidClaimSource", source, "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'carry-over', now())`,
    [
      `${MONTH_ID}-${userId}`,
      MONTH_ID,
      userId,
      o.kind ?? "regular",
      o.slot,
      o.note ?? null,
      o.kind === "payg" ? 0 : KICKOFFS.length,
      o.paid ? new Date().toISOString() : null,
      o.paid ? "list" : null,
    ],
  );
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  // Next month's games, and its list, open for sign-up.
  for (const [i, k] of KICKOFFS.entries()) {
    await db.run(
      `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt")
       VALUES ($1, $2, $3, 10, 'UPCOMING', $4, now())`,
      [matchId(i), ACTIVITY_ID, k.toISOString(), new Date(k.getTime() - 5 * 60 * 60 * 1000).toISOString()],
    );
  }
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "listOpenedAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'open', $5, now(), now())`,
    [MONTH_ID, ORG_ID, ACTIVITY_ID, NEXT, KICKOFFS.length],
  );
  await addMember(db, U.rater, { slot: 1 });
  await addMember(db, U.third, { slot: 2, paid: true });
  await addMember(db, U.bench, { kind: "payg", slot: null, note: "waiting for a regular place" });
});
test.afterAll(() => resetDb());

test("a weekly club has no sign-up page", async ({ page }) => {
  await signInAs(page, U.player, "/");
  const res = await page.goto("/month");
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId("month-page")).toHaveCount(0);
});

test("a player signs up for next month: in, then pay as you go on two games, then not this month", async ({ page, db }) => {
  await setMode("monthly");
  const before = await outbound();
  await signInAs(page, U.player, "/month");
  await expect(page.getByTestId("month-page")).toBeVisible({ timeout: 30_000 });
  const card = page.getByTestId("month-signup");
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("heading", { name: `List for ${MONTH_NAME}` })).toBeVisible();
  await expect(card).toContainText(`${DAYS.length} games: ${DAYS.join(", ")}`);
  await expect(card.getByTestId("month-state")).toHaveText("You are not on this month's list yet.");

  await card.getByTestId("month-in").click();
  await expect(card.getByTestId("month-state")).toHaveText("You are in for the month, number 3 on the list.");
  expect(await member(db, U.player)).toMatchObject({ kind: "regular", slot: 3, out: false, source: "page", gamesCovered: KICKOFFS.length });

  await card.getByTestId(`month-day-${DAYS[0]}`).check();
  await card.getByTestId(`month-day-${DAYS[2]}`).check();
  await card.getByTestId("month-payg").click();
  await expect(card.getByTestId("month-state")).toHaveText(`You are pay-as-you-go on ${DAYS[0]}, ${DAYS[2]}.`);
  const payg = await member(db, U.player);
  expect(payg).toMatchObject({ kind: "payg", slot: null, out: false, gamesCovered: 0 });
  expect([...payg!.paygMatchIds].sort()).toEqual([matchId(0), matchId(2)].sort());

  await card.getByTestId("month-out").click();
  await expect(card.getByTestId("month-state")).toHaveText("You are not on this month's list.");
  // Off the month. The row is kept.
  expect(await member(db, U.player)).toMatchObject({ out: true });

  // Back in: the lowest free number again.
  await card.getByTestId("month-in").click();
  await expect(card.getByTestId("month-state")).toHaveText("You are in for the month, number 3 on the list.");

  // The page tells nobody anything on WhatsApp.
  expect(await outbound()).toBe(before);
});

test("somebody who says they have paid cannot move themselves", async ({ page, db }) => {
  await signInAs(page, U.third, "/month");
  const card = page.getByTestId("month-signup");
  await expect(card.getByTestId("month-state")).toHaveText("You are in for the month, number 2 on the list.", { timeout: 30_000 });
  await expect(card.getByTestId("month-locked")).toHaveText("You have said you paid for this month, so your place is not changed here. Ask an organiser.");
  await expect(card.getByTestId("month-out")).toHaveCount(0);
  await expect(card.getByTestId("month-payg")).toHaveCount(0);
  expect(await member(db, U.third)).toMatchObject({ kind: "regular", slot: 2, out: false });
});

test("the organiser sees next month's sign-ups and who is waiting", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/months");
  await expect(page.getByTestId("months-page")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("next-month")).toContainText(`Next month: ${MONTH_YEAR}`);
  const card = page.getByTestId("next-month-card");
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("month-status")).toHaveText("Sign-up open");
  await expect(card.getByTestId("month-signup-state")).toContainText("Sign-up is open until");
  await expect(card.getByTestId("month-signup-counts")).toHaveText("Regulars: 3 of 10. PAYG: 0. Waiting for a regular place: 1.");
  await expect(card.getByTestId("info-mth_signup")).toBeVisible();

  const row = (userId: string) => card.locator(`[data-testid="month-member"][data-user="${userId}"]`);
  await expect(row(U.rater)).toContainText(NAME.rater);
  await expect(row(U.rater).locator("[data-kind]")).toHaveAttribute("data-kind", "regular");
  await expect(row(U.third).locator("[data-paid]")).toHaveText("Says paid");
  await expect(row(U.bench).locator("[data-kind]")).toHaveText("Waiting for a regular place");
  await expect(row(U.player).locator("[data-kind]")).toHaveText("Regular");
});

test("the organiser makes a waiting player a regular, moves a regular to PAYG and takes somebody off", async ({ page, db }) => {
  const before = await outbound();
  await signInAs(page, U.admin, "/admin/months");
  const card = page.getByTestId("next-month-card");
  const row = (userId: string) => card.locator(`[data-testid="month-member"][data-user="${userId}"]`);
  await expect(row(U.bench)).toBeVisible({ timeout: 30_000 });

  await row(U.bench).getByTestId("member-make-regular").click();
  await expect(row(U.bench).locator("[data-kind]")).toHaveText("Regular");
  expect(await member(db, U.bench)).toMatchObject({ kind: "regular", slot: 4, note: null, source: "carry-over", gamesCovered: KICKOFFS.length });

  await row(U.rater).getByTestId("member-make-payg").click();
  await expect(row(U.rater).locator("[data-kind]")).toHaveText("PAYG");
  expect(await member(db, U.rater)).toMatchObject({ kind: "payg", slot: null, gamesCovered: 0 });

  // Taking somebody off who says they have paid is the organiser's to do.
  // The row, and what it knows of money, stays.
  await row(U.third).getByTestId("member-remove").click();
  await expect(row(U.third)).toHaveCount(0);
  const third = await db.one<{ out: boolean; claimed: boolean }>(
    `SELECT ("leftAt" IS NOT NULL) AS out, ("paidClaimedAt" IS NOT NULL) AS claimed FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
    [MONTH_ID, U.third],
  );
  expect(third).toEqual({ out: true, claimed: true });
  await expect(card.getByTestId("month-signup-counts")).toHaveText("Regulars: 2 of 10. PAYG: 1. Waiting for a regular place: 0.");

  // "Add a player": a club player who is not on the month (and the one just taken off).
  const add = card.getByTestId("member-add");
  await expect(add.getByTestId("member-add-regular")).toBeDisabled();
  await add.getByTestId("member-add-select").selectOption(U.fresh);
  await add.getByTestId("member-add-regular").click();
  await expect(row(U.fresh).locator("[data-kind]")).toHaveText("Regular");
  expect(await member(db, U.fresh)).toMatchObject({ kind: "regular", slot: 1, out: false, source: "admin" });
  await add.getByTestId("member-add-select").selectOption(U.third);
  await add.getByTestId("member-add-payg").click();
  await expect(row(U.third).locator("[data-kind]")).toHaveText("PAYG");
  expect(await outbound()).toBe(before);
});

test("in Turkish", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  try {
    await signInAs(page, U.player, "/month");
    const card = page.getByTestId("month-signup");
    await expect(card.getByTestId("month-state")).toHaveText("Bu ay varsın, listede 3 numarasın.", { timeout: 30_000 });
    await expect(card.getByTestId("month-in")).toHaveText("Bu ay varım");
    await expect(card.getByTestId("month-out")).toHaveText("Bu ay yokum");
  } finally {
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  }
});
