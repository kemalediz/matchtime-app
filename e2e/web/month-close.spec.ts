/**
 * MONTHLY SQUAD, SLICE 6: THE CREDITS LEDGER, AWAY WEEKS, THE MATCH PAGE'S
 * LABELS, A CANCELLED WEEK, LEAVING AND JOINING PART-WAY, A SHARE CHANGED
 * AFTER PAYMENTS, REFUNDS AND THE MONTH'S SUMMARY, ON THE PAGES.
 *
 * MDs/monthly-squad-plan-2026-10-05.md, sections 4.4, 5.2, 7 and 9. No
 * model is called anywhere in this file: every one of these is a tick, a
 * button or arithmetic.
 *
 * One monthly club ("Vets MNF", 6 places) with three months:
 *   - NEXT month, Mondays: started by its organiser, priced at £7.50 a
 *     game, with four regulars (one confirmed, one says paid, one unpaid,
 *     one confirmed) and a PAYG player;
 *   - NEXT month, Wednesdays: sign-up open, no price yet;
 *   - LAST month, Mondays: closed.
 *
 *   1. the credits ledger: "Add credit" and "Remove credit" each need a
 *      reason, nothing is deleted, a used credit cannot be removed, and
 *      only an organiser of a monthly club sees the page;
 *   2. a credit comes off the next month's amount exactly once, and one
 *      earned after the amounts were posted waits for the month after;
 *   3. a regular ticks the games they will miss: `absentMatchIds`, the
 *      credit rule, and a game with no match row yet gets one, silently;
 *   4. the match page shows who is monthly, who is PAYG and who has paid
 *      but can't play; a weekly club's match page shows none of it;
 *   5. cancelling a game credits the regulars and says so in the one
 *      announcement;
 *   6. a regular who paid and is taken off the month is shown as owed; the
 *      collector records the refund; MatchTime sends no money and no DM;
 *   7. a share changed after payments: nobody's payment changes, the
 *      difference is shown, and an overpayment is refunded by the collector;
 *   8. a closed month: its summary, reached from "Earlier", and a payment
 *      that arrives late is still confirmed;
 *   9. a player joins a month under way from their page.
 */
import { formatInTimeZone } from "date-fns-tz";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, signInAs, asAdmin, asPlayer, resetDb } from "../fixtures";
import { engineOn } from "../helpers/stub";
import { E2E } from "../helpers/env";
import { MATCH, ORG_ID } from "../helpers/constants";
import { testDb, type TestDb } from "../helpers/test-db";
import { buildMatchCancelledAnnouncement } from "@/lib/group-copy";
import { dayTimeLabel } from "@/lib/i18n/dates";
import { pounds } from "@/lib/month-payment-copy";
import { defaultPayBy } from "@/lib/month-payment-rules";
import { monthKickoffs, nextMonthStart, previousMonthStart } from "@/lib/month-signup-rules";
import { londonMonthStart } from "@/lib/squad-month-rules";

test.describe.configure({ mode: "serial" });

const ORG = "e2e-mcw-org";
const GROUP = "e2e-monthclose-web@g.us";
const ACT = "e2e-mcw-act";
const ACT2 = "e2e-mcw-act2";
const MONTH = "e2e-mcw-month";
const MONTH2 = "e2e-mcw-month2";
const PAST = "e2e-mcw-past";

const LONDON = "Europe/London";
const THIS = londonMonthStart(new Date());
const NEXT = nextMonthStart(THIS);
const PREV = previousMonthStart(THIS);
const MONTH_NAME = formatInTimeZone(new Date(`${NEXT}T12:00:00.000Z`), LONDON, "MMMM");
const PREV_NAME = formatInTimeZone(new Date(`${PREV}T12:00:00.000Z`), LONDON, "MMMM");
const PREV_LABEL = formatInTimeZone(new Date(`${PREV}T12:00:00.000Z`), LONDON, "MMMM yyyy");
/** Mondays and Wednesdays of next month, 20:00 London. */
const G = monthKickoffs(NEXT, 1, "20:00");
const W = monthKickoffs(NEXT, 3, "20:00");
const N = G.length;
const PREV_GAMES = monthKickoffs(PREV, 1, "20:00").length;
const SHARE = 750;
const matchId = (i: number) => `e2e-mcw-match-${i}`;
const dayOf = (d: Date) => formatInTimeZone(d, LONDON, "yyyy-MM-dd");
/** The game that is called off in test 5. */
const OFF = 2;

const P = {
  rob: { id: "e2e-mcw-rob", name: "Rob Hale", phone: "+447700960001" },
  adam: { id: "e2e-mcw-adam", name: "Adam Admin", phone: "+447700960002" },
  alex: { id: "e2e-mcw-alex", name: "Alex Carter", phone: "+447700960003" },
  bilal: { id: "e2e-mcw-bilal", name: "Bilal Aydin", phone: "+447700960004" },
  carl: { id: "e2e-mcw-carl", name: "Carl Young", phone: "+447700960005" },
  dev: { id: "e2e-mcw-dev", name: "Dev Patel", phone: "+447700960006" },
  omar: { id: "e2e-mcw-omar", name: "Omar Khan", phone: "+447700960007" },
  tom: { id: "e2e-mcw-tom", name: "Tom Reed", phone: "+447700960008" },
} as const;
type Person = (typeof P)[keyof typeof P];
const digits = (phone: string) => phone.replace(/^\+/, "");

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };

async function poll(request: APIRequestContext, now: Date): Promise<void> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(GROUP)}`, { headers: { ...KEY, "x-test-now": now.toISOString() } });
  expect(res.status(), await res.text()).toBe(200);
}

interface CreditRow {
  userId: string;
  reason: string;
  note: string | null;
  earnedMatchId: string | null;
  appliedMonthId: string | null;
  voidedAt: Date | null;
  voidedById: string | null;
  voidNote: string | null;
  createdById: string | null;
}
const credits = (db: TestDb, who?: Person) =>
  db.all<CreditRow>(
    `SELECT "userId", reason, note, "earnedMatchId", "appliedMonthId", "voidedAt", "voidedById", "voidNote", "createdById"
       FROM "SquadCredit" WHERE "orgId" = $1 AND ($2::text IS NULL OR "userId" = $2) ORDER BY "createdAt", id`,
    [ORG, who?.id ?? null],
  );
const liveOf = (rows: CreditRow[]) => rows.filter((c) => c.voidedAt === null);

const member = (db: TestDb, who: Person, month = MONTH) =>
  db.one<{
    kind: string;
    gamesCovered: number;
    creditsApplied: number;
    amountDuePence: number | null;
    paidAt: Date | null;
    paidAmountPence: number | null;
    paidClaimedAmountPence: number | null;
    refundedPence: number;
    leftAt: Date | null;
    absentMatchIds: string[];
  }>(
    `SELECT kind, "gamesCovered", "creditsApplied", "amountDuePence", "paidAt", "paidAmountPence", "paidClaimedAmountPence", "refundedPence", "leftAt", "absentMatchIds"
       FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
    [month, who.id],
  );

const dms = (db: TestDb, who: { phone: string }) =>
  db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt"`, [ORG, digits(who.phone)]);
const groupPosts = (db: TestDb) => db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group' ORDER BY "createdAt"`, [ORG]);

async function person(db: TestDb, p: { id: string; name: string; phone: string }, role = "PLAYER") {
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [p.id, `${p.id}@e2e.test`, p.name, p.phone]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4::"MemberRole")`, [`mem-${p.id}`, p.id, ORG, role]);
}

async function attend(db: TestDb, mId: string, who: Person, status: string, position: number, monthly: boolean) {
  await db.run(
    `WITH a AS (
       INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "paymentMethod", "updatedAt")
       VALUES ($1, $2, $3, $4::"AttendanceStatus", $5, $6, now()) RETURNING "matchId", "userId", status, position
     )
     INSERT INTO "AttendanceEvent" (id, "matchId", "userId", "orgId", "toStatus", "toPosition", cause, "actorKind")
     SELECT $7, "matchId", "userId", $8, status, position, 'test-fixture', 'system' FROM a`,
    [`att-${mId}-${who.id}`, mId, who.id, status, position, monthly ? "monthly" : null, `ev-${mId}-${who.id}`, ORG],
  );
}

async function memberRow(db: TestDb, monthId: string, p: Person, o: { kind?: string; slot: number | null; games: number; due: number | null; paid?: "confirmed" | "claimed" | "none" }) {
  const paid = o.paid ?? "none";
  await db.run(
    `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, slot, "gamesCovered", "amountDuePence", "paidClaimedAt", "paidClaimSource",
                                     "paidAt", "paidAmountPence", "paidConfirmedByUserId", source, "joinedAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'seed-tick', now() - interval '2 days', now())`,
    [
      `${monthId}-${p.id}`,
      monthId,
      p.id,
      o.kind ?? "regular",
      o.slot,
      o.games,
      o.due,
      paid === "claimed" ? new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() : null,
      paid === "claimed" ? "dm" : null,
      paid === "confirmed" ? new Date().toISOString() : null,
      paid === "confirmed" ? o.due : null,
      paid === "confirmed" ? P.rob.id : null,
    ],
  );
}

const card = (page: Page, activity: string) => page.locator(`[data-testid="next-month-card"][data-activity="${activity}"]`);
const row = (page: Page, activity: string, who: Person) => card(page, activity).locator(`[data-testid="month-member"][data-user="${who.id}"]`);

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "squadMode", "paygPricePence",
                                 "adminChannelMode", language, "updatedAt")
     VALUES ($1, 'Vets MNF', $1, $2, $3, true, 'monthly', 800, 'each-admin', 'en', now())`,
    [ORG, `${ORG}-invite`, GROUP],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ('e2e-mcw-sport', $1, 'Basketball', 3, ARRAY['G','F'], ARRAY['Red','Yellow'], now())`,
    [ORG],
  );
  for (const [id, name, dow, venue] of [
    [ACT, "Monday 7-a-side", 1, "Goals"],
    [ACT2, "Wednesday 5-a-side", 3, "Powerleague"],
  ] as const) {
    await db.run(
      `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
       VALUES ($1, $2, 'e2e-mcw-sport', $3, $4, '20:00', $5, 5, now())`,
      [id, ORG, name, dow, venue],
    );
  }
  await person(db, P.rob, "OWNER");
  await person(db, P.adam, "ADMIN");
  for (const p of [P.alex, P.bilal, P.carl, P.dev, P.omar, P.tom]) await person(db, p);
  await db.run(`UPDATE "Organisation" SET "paymentHolderId" = $2 WHERE id = $1`, [ORG, P.rob.id]);

  // NEXT month, Mondays: started by the organiser an hour ago, priced.
  // Match rows for the first three games only, as in a month started
  // part-way; the squad is already on the first.
  for (const [i, k] of G.entries()) {
    if (i > 2) break;
    await db.run(
      `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "rollingSeededAt", "updatedAt")
       VALUES ($1, $2, $3, 6, 'UPCOMING', $4, $5, now())`,
      [matchId(i), ACT, k.toISOString(), new Date(k.getTime() - 5 * 60 * 60 * 1000).toISOString(), i === 0 ? new Date().toISOString() : null],
    );
  }
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "sharePerGamePence", "pricedAt", "payByAt",
                               "startedMidMonthAt", "startedByUserId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'running', $5, $6, $8, $9, $8, $7, $8, now())`,
    // Instants from this process, not the database's now(): the columns
    // carry no time zone, and the squad's seed below is compared with them.
    [MONTH, ORG, ACT, NEXT, N, SHARE, P.rob.id, new Date(Date.now() - 60 * 60 * 1000).toISOString(), new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()],
  );
  await memberRow(db, MONTH, P.alex, { slot: 1, games: N, due: SHARE * N, paid: "confirmed" });
  await memberRow(db, MONTH, P.bilal, { slot: 2, games: N, due: SHARE * N, paid: "claimed" });
  await memberRow(db, MONTH, P.carl, { slot: 3, games: N, due: SHARE * N });
  await memberRow(db, MONTH, P.dev, { slot: 4, games: N, due: SHARE * N, paid: "confirmed" });
  await memberRow(db, MONTH, P.omar, { kind: "payg", slot: null, games: 0, due: null });
  // The first game's squad: three regulars in, Bilal out, Omar pay-as-you-go.
  await attend(db, matchId(0), P.alex, "CONFIRMED", 1, true);
  await attend(db, matchId(0), P.bilal, "DROPPED", 2, true);
  await attend(db, matchId(0), P.carl, "CONFIRMED", 3, true);
  await attend(db, matchId(0), P.dev, "CONFIRMED", 4, true);
  await attend(db, matchId(0), P.omar, "CONFIRMED", 5, false);

  // NEXT month, Wednesdays: sign-up open since yesterday, no price yet.
  for (const [i, k] of W.entries()) {
    await db.run(
      `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 6, 'UPCOMING', $4, now())`,
      [`e2e-mcw-wed-${i}`, ACT2, k.toISOString(), new Date(k.getTime() - 5 * 60 * 60 * 1000).toISOString()],
    );
  }
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "listOpenedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'open', $5, $6, $6, now())`,
    [MONTH2, ORG, ACT2, NEXT, W.length, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()],
  );
  await memberRow(db, MONTH2, P.alex, { slot: 1, games: W.length, due: null });
  await memberRow(db, MONTH2, P.bilal, { slot: 2, games: W.length, due: null });

  // LAST month, Mondays: closed. Alex paid; Carl never did.
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "sharePerGamePence", "pricedAt", "closedAt",
                               "summarySentAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'closed', $5, 750, now() - interval '40 days', now() - interval '2 days', now() - interval '30 days',
             now() - interval '45 days', now())`,
    [PAST, ORG, ACT, PREV, PREV_GAMES],
  );
  await memberRow(db, PAST, P.alex, { slot: 1, games: PREV_GAMES, due: 3000, paid: "confirmed" });
  await memberRow(db, PAST, P.carl, { slot: 2, games: PREV_GAMES, due: 3000 });
  // A credit of Bilal's that was used against last month.
  await db.run(
    `INSERT INTO "SquadCredit" (id, "orgId", "userId", games, reason, "appliedMonthId", "appliedAt", "createdAt")
     VALUES ('e2e-mcw-credit-used', $1, $2, 1, 'missed', $3, now() - interval '40 days', now() - interval '50 days')`,
    [ORG, P.bilal.id, PAST],
  );
  engineOn({});
});
test.afterAll(() => resetDb());

test("1. the credits ledger: add and remove need a reason, nothing is deleted, a used credit stays", async ({ page, db }) => {
  await signInAs(page, P.adam.id, "/admin/months");
  await expect(page.getByTestId("months-page")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("months-credits-link").click();
  await expect(page.getByTestId("credits-page")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("info-mcr")).toBeVisible();

  // No reason, no credit.
  const add = page.getByTestId("credit-add");
  await add.getByTestId("credit-add-player").selectOption(P.alex.id);
  await add.getByTestId("credit-add-games").fill("2");
  await add.getByTestId("credit-add-reason").fill("x");
  await add.getByTestId("credit-add-save").click();
  await expect(add.getByTestId("credit-add-error")).toHaveText("Give a reason of 3 to 200 characters.");
  expect(await credits(db, P.alex)).toEqual([]);

  // With one: a ledger row a game, in the organiser's own words.
  await add.getByTestId("credit-add-reason").fill("missed 5 Oct, before we started here");
  await add.getByTestId("credit-add-save").click();
  const alex = page.locator(`[data-testid="credits-player"][data-user="${P.alex.id}"]`);
  await expect(alex.getByTestId("credit-row")).toHaveCount(2);
  await expect(alex.getByTestId("credits-available")).toHaveText("2 games available");
  await expect(alex.getByTestId("credit-why").first()).toHaveText("Added by an organiser: missed 5 Oct, before we started here");
  await expect(alex.getByTestId("credit-where").first()).toHaveText("Available");
  const added = await credits(db, P.alex);
  expect(added.map((c) => [c.reason, c.note, c.createdById, c.appliedMonthId, c.voidedAt])).toEqual([
    ["manual", "missed 5 Oct, before we started here", P.adam.id, null, null],
    ["manual", "missed 5 Oct, before we started here", P.adam.id, null, null],
  ]);

  // Removing needs a reason too, and the row stays.
  await alex.getByTestId("credit-remove").first().click();
  await alex.getByTestId("credit-remove-confirm").click();
  await expect(alex.getByTestId("credit-remove-error")).toHaveText("Give a reason of 3 to 200 characters.");
  await alex.getByTestId("credit-remove-reason").fill("added one too many");
  await alex.getByTestId("credit-remove-confirm").click();
  await expect(alex.getByTestId("credits-available")).toHaveText("1 game available");
  await expect(alex.getByTestId("credit-row")).toHaveCount(2);
  await expect(alex.locator('[data-testid="credit-row"][data-state="removed"]').getByTestId("credit-where")).toHaveText("Removed by an organiser (added one too many)");
  const after = await credits(db, P.alex);
  expect(after).toHaveLength(2);
  expect(after.filter((c) => c.voidedAt !== null).map((c) => [c.voidedById, c.voidNote])).toEqual([[P.adam.id, "added one too many"]]);

  // A credit that has already come off a month cannot be removed.
  const bilal = page.locator(`[data-testid="credits-player"][data-user="${P.bilal.id}"]`);
  await expect(bilal.getByTestId("credit-where")).toHaveText(`Used for ${PREV_LABEL}`);
  await expect(bilal.getByTestId("credit-remove")).toHaveCount(0);
  await expect(bilal.getByTestId("credits-available")).toHaveText("0 games available");
});

test("1b. only an organiser of a monthly club sees the ledger", async ({ page }) => {
  // A player of the club is turned away.
  await signInAs(page, P.alex.id, "/admin/months/credits");
  await expect(page.getByTestId("credits-page")).toHaveCount(0);
  // A weekly club (the fixture club): the page does not exist.
  await asAdmin(page);
  const res = await page.goto("/admin/months/credits");
  expect(res?.status()).toBe(404);
});

test("2. a credit comes off the next month's amount exactly once, and one earned after pricing waits", async ({ page, db }) => {
  await signInAs(page, P.adam.id, "/admin/months");
  const wed = card(page, ACT2);
  const form = wed.getByTestId("price-form");
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByTestId("price-share").fill("7.50");
  await form.getByTestId("price-save").click();
  await expect(wed.getByTestId("month-share")).toContainText("Share per game: £7.50");

  // Alex holds one credit (test 1): one game off. Bilal holds none.
  const games = W.length;
  expect(await member(db, P.alex, MONTH2)).toMatchObject({ creditsApplied: 1, amountDuePence: SHARE * (games - 1) });
  expect(await member(db, P.bilal, MONTH2)).toMatchObject({ creditsApplied: 0, amountDuePence: SHARE * games });
  const used = (await credits(db, P.alex)).filter((c) => c.appliedMonthId === MONTH2);
  expect(used).toHaveLength(1);

  // A credit earned AFTER the amounts were posted, and the price saved
  // again with a new pay-by date: nobody's amount moves, nothing is taken
  // twice, and the new credit waits for the month after.
  await db.run(`INSERT INTO "SquadCredit" (id, "orgId", "userId", games, reason) VALUES ('e2e-mcw-credit-late', $1, $2, 1, 'manual')`, [ORG, P.bilal.id]);
  const payBy = new Date(defaultPayBy(W[0], new Date()).getTime() - 60 * 60 * 1000);
  await form.getByTestId("price-payby").fill(formatInTimeZone(payBy, LONDON, "yyyy-MM-dd'T'HH:mm"));
  await form.getByTestId("price-save").click();
  await expect(wed.getByTestId("month-payby")).toContainText(formatInTimeZone(payBy, LONDON, "HH:mm"));
  expect(await member(db, P.alex, MONTH2)).toMatchObject({ creditsApplied: 1, amountDuePence: SHARE * (games - 1) });
  expect(await member(db, P.bilal, MONTH2)).toMatchObject({ creditsApplied: 0, amountDuePence: SHARE * games });
  expect((await credits(db)).filter((c) => c.appliedMonthId === MONTH2)).toHaveLength(1);
  expect((await credits(db, P.bilal)).find((c) => c.reason === "manual")!.appliedMonthId).toBeNull();
});

test("3. away weeks: a regular ticks the games they will miss", async ({ page, db }) => {
  await signInAs(page, P.alex.id, "/month");
  const away = page.locator(`[data-testid="month-away"][data-month="${MONTH}"]`);
  await expect(away).toBeVisible({ timeout: 30_000 });
  // The squad is on the first game already: that one is said the usual way.
  await expect(away.getByTestId("month-away-seeded")).toHaveCount(1);
  await expect(away.getByTestId(`month-away-${dayOf(G[0])}`)).toHaveCount(0);
  // Every other game of the month can be ticked, the ones with no match row yet included.
  for (let i = 1; i < N; i++) await expect(away.getByTestId(`month-away-${dayOf(G[i])}`)).toBeVisible();

  const groupBefore = (await groupPosts(db)).length;
  const last = N - 1;
  await away.getByTestId(`month-away-${dayOf(G[last])}`).check();
  await away.getByTestId("month-away-save").click();
  await expect(away.getByTestId("month-away-note")).toHaveText("Saved.");

  // The game had no match row: it has exactly one now, and nothing was posted.
  const made = await db.all<{ id: string }>(`SELECT id FROM "Match" WHERE "activityId" = $1 AND date = $2`, [ACT, G[last].toISOString()]);
  expect(made).toHaveLength(1);
  expect((await groupPosts(db)).length).toBe(groupBefore);
  expect((await member(db, P.alex))!.absentMatchIds).toEqual([made[0].id]);
  // The club's credit rule applies: he has paid, so the game is a credit.
  const earned = (await credits(db, P.alex)).filter((c) => c.earnedMatchId === made[0].id);
  expect(earned.map((c) => [c.reason, c.voidedAt])).toEqual([["missed", null]]);

  // The same ticks again write nothing more.
  await away.getByTestId("month-away-save").click();
  await expect(away.getByTestId("month-away-note")).toHaveText("Saved.");
  expect((await credits(db, P.alex)).filter((c) => c.earnedMatchId === made[0].id)).toHaveLength(1);

  // Unticked: he is playing after all, and the credit is taken back.
  await page.reload();
  await expect(away.getByTestId(`month-away-${dayOf(G[last])}`)).toBeChecked();
  await away.getByTestId(`month-away-${dayOf(G[last])}`).uncheck();
  await away.getByTestId("month-away-save").click();
  await expect(away.getByTestId("month-away-note")).toHaveText("Saved.");
  expect((await member(db, P.alex))!.absentMatchIds).toEqual([]);
  const back = (await credits(db, P.alex)).filter((c) => c.earnedMatchId === made[0].id);
  expect(back).toHaveLength(1);
  expect(back[0].voidedAt).not.toBeNull();
  expect(back[0].voidedById).toBeNull();

  // A PAYG player has no away weeks to tick.
  await signInAs(page, P.omar.id, "/month");
  await expect(page.getByTestId("month-page")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("month-away")).toHaveCount(0);
});

test("4. the match page shows who is monthly, who is PAYG and who has paid but can't play", async ({ page }) => {
  await signInAs(page, P.alex.id, `/matches/${matchId(0)}`);
  const panel = page.getByTestId("monthly-week-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const tag = (slot: number) => panel.locator(`[data-testid="monthly-slot"][data-slot="${slot}"]`);
  await expect(tag(1)).toContainText(P.alex.name);
  await expect(tag(1).getByTestId("monthly-tag")).toHaveText("Monthly, paid");
  // Carl has not paid: never shown as paid.
  await expect(tag(3).getByTestId("monthly-tag")).toHaveText("Monthly");
  await expect(tag(5)).toContainText(P.omar.name);
  await expect(tag(5).getByTestId("monthly-tag")).toHaveText("PAYG");
  // An empty place carries no label.
  await expect(tag(2).getByTestId("monthly-tag")).toHaveCount(0);
  await expect(panel.getByTestId("monthly-cant-paid")).toContainText("Paid but can't play");
  await expect(panel.getByTestId("monthly-cant-paid")).toContainText(P.bilal.name);
  await expect(panel.getByTestId("monthly-open")).toHaveText("2 places open");

  // A weekly club's match page (the fixture club) shows none of it.
  await asPlayer(page, `/matches/${MATCH.upcoming}`);
  await expect(page.getByRole("heading", { name: "Attendance" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("monthly-week-panel")).toHaveCount(0);
});

test("5. cancelling a game credits the regulars and says so in the one announcement", async ({ page, db }) => {
  const before = (await groupPosts(db)).length;
  await signInAs(page, P.adam.id, `/admin/matches/${matchId(OFF)}/cancel`);
  await page.getByRole("button", { name: "Cancel match", exact: true }).click();
  await page.waitForURL(/\/matches$/, { timeout: 30_000 });

  const posts = await groupPosts(db);
  expect(posts.length).toBe(before + 1);
  expect(posts.at(-1)!.text).toBe(
    `${buildMatchCancelledAnnouncement({ activityName: "Monday 7-a-side", whenLabel: dayTimeLabel("en", G[OFF]), lang: "en" })}\nRegulars get 1 game credit for it.`,
  );

  const now = (await credits(db)).filter((c) => c.earnedMatchId === matchId(OFF));
  expect(now.map((c) => c.userId).sort()).toEqual([P.alex.id, P.bilal.id, P.carl.id, P.dev.id].sort());
  expect(now.every((c) => c.reason === "cancelled-week" && c.voidedAt === null)).toBe(true);
  // Carl has not paid: it comes off this month at once. The others keep theirs.
  expect(now.find((c) => c.userId === P.carl.id)!.appliedMonthId).toBe(MONTH);
  expect(await member(db, P.carl)).toMatchObject({ creditsApplied: 1, amountDuePence: SHARE * (N - 1) });
  expect(now.filter((c) => c.userId !== P.carl.id).every((c) => c.appliedMonthId === null)).toBe(true);
  expect(await member(db, P.alex)).toMatchObject({ creditsApplied: 0, amountDuePence: SHARE * N });
});

test("6. a regular who paid and is taken off the month is owed: shown to the collector, recorded, never sent", async ({ page, request, db }) => {
  // An organiser takes Dev off the month.
  await signInAs(page, P.adam.id, "/admin/months");
  await row(page, ACT, P.dev).getByTestId("member-remove").click();
  const leaver = card(page, ACT).locator(`[data-testid="month-leaver"][data-user="${P.dev.id}"]`);
  await expect(leaver).toBeVisible({ timeout: 30_000 });
  await expect(row(page, ACT, P.dev)).toHaveCount(0);

  // Every game of the month was still to play: the ones left, and the one
  // called off (he holds that credit already). Valued at the month's share.
  await expect(leaver.getByTestId("leaver-owed")).toHaveText(`Owed: ${N} games (${pounds(SHARE * N)})`);
  const owed = liveOf(await credits(db, P.dev));
  expect(owed.filter((c) => c.reason === "left-mid-month")).toHaveLength(N - 1);
  expect(owed.filter((c) => c.reason === "cancelled-week")).toHaveLength(1);
  // LEAVING DESTROYS NOTHING: the row and the payment stand.
  const devRow = (await member(db, P.dev))!;
  expect(devRow.leftAt).not.toBeNull();
  expect(devRow.paidAt).not.toBeNull();
  expect(devRow).toMatchObject({ paidAmountPence: SHARE * N, refundedPence: 0 });
  // The page shows it: an organiser's own change sends the organisers no
  // message. An admin who is not the collector cannot record a refund.
  expect((await dms(db, P.rob)).filter((d) => d.text.includes("has left"))).toEqual([]);
  await expect(leaver.getByTestId("refund-form")).toHaveCount(0);

  // The collector gives it back his own way and records it.
  await signInAs(page, P.rob.id, "/admin/months");
  const mine = card(page, ACT).locator(`[data-testid="month-leaver"][data-user="${P.dev.id}"]`);
  await expect(mine.getByTestId("refund-amount")).toHaveValue((SHARE * N / 100).toFixed(2));
  await mine.getByTestId("refund-save").click();
  await expect(mine.getByTestId("leaver-owed")).toHaveText("Nothing owed");
  await expect(mine.getByTestId("leaver-refunded")).toHaveText(`Refunded ${pounds(SHARE * N)}`);
  await expect(mine.getByTestId("refund-form")).toHaveCount(0);

  expect((await member(db, P.dev))!.refundedPence).toBe(SHARE * N);
  const settled = await credits(db, P.dev);
  expect(liveOf(settled)).toEqual([]);
  expect(settled.every((c) => c.voidedById === P.rob.id && c.voidNote === "refunded")).toBe(true);
  // MatchTime sent Dev nothing and moved nothing.
  expect(await dms(db, P.dev)).toEqual([]);

  // A later sweep never writes them again.
  await poll(request, new Date());
  expect(liveOf(await credits(db, P.dev))).toEqual([]);
  expect((await dms(db, P.rob)).filter((d) => d.text.includes("has left"))).toEqual([]);
});

test("7. a share changed after payments: nobody's payment changes, and the difference is shown", async ({ page, db }) => {
  await signInAs(page, P.adam.id, "/admin/months");
  const mon = card(page, ACT);
  // The price form will not change the share once somebody has paid.
  await expect(mon.getByTestId("price-locked")).toBeVisible({ timeout: 30_000 });
  const form = mon.getByTestId("share-change-form");
  await expect(form.getByTestId("share-change-save")).toBeDisabled();
  await form.getByTestId("share-change-share").fill("8");
  await form.getByTestId("share-change-ack").check();
  await form.getByTestId("share-change-save").click();
  await expect(mon.getByTestId("month-share")).toContainText("Share per game: £8");

  const more = 50 * N;
  // Alex paid £7.50 a game: his payment stands, and he owes the difference.
  expect(await member(db, P.alex)).toMatchObject({ amountDuePence: 800 * N, paidAmountPence: SHARE * N });
  expect((await member(db, P.alex))!.paidAt).not.toBeNull();
  await expect(row(page, ACT, P.alex).getByTestId("member-balance")).toHaveText(`owes ${pounds(more)} more`);
  // Bilal SAYS he paid: what he was asked for then is written down. Still only a claim.
  const bilal = (await member(db, P.bilal))!;
  expect(bilal).toMatchObject({ amountDuePence: 800 * N, paidClaimedAmountPence: SHARE * N });
  expect(bilal.paidAt).toBeNull();
  await expect(row(page, ACT, P.bilal).getByTestId("member-balance")).toHaveText(`owes ${pounds(more)} more`);
  // Carl has not paid: he is simply asked for the new amount.
  expect(await member(db, P.carl)).toMatchObject({ amountDuePence: 800 * (N - 1), creditsApplied: 1 });
  await expect(row(page, ACT, P.carl).getByTestId("member-balance")).toHaveCount(0);

  // The organisers are told once who that leaves owing.
  const told = (await dms(db, P.rob)).filter((d) => d.text.startsWith(`📋 ${MONTH_NAME}: the share is now £8 a game.`));
  expect(told).toHaveLength(1);
  expect(told[0].text).toContain(`${P.alex.name} ${pounds(more)}`);
  expect(told[0].text).toContain(`${P.bilal.name} ${pounds(more)}`);
  expect(told[0].text).toContain("Nobody's payment was changed.");

  // Alex sees it on his own page.
  await signInAs(page, P.alex.id, "/month");
  const mine = page.locator(`[data-testid="month-signup"][data-month="${MONTH}"]`);
  await expect(mine.getByTestId("month-balance")).toHaveText(`What you are asked for went up after you paid: ${pounds(more)} more to pay.`, { timeout: 30_000 });

  // The share goes DOWN to £7: now the paid regulars have money to come back.
  await signInAs(page, P.adam.id, "/admin/months");
  const again = card(page, ACT).getByTestId("share-change-form");
  await again.getByTestId("share-change-share").fill("7");
  await again.getByTestId("share-change-ack").check();
  await again.getByTestId("share-change-save").click();
  await expect(card(page, ACT).getByTestId("month-share")).toContainText("Share per game: £7");
  await expect(row(page, ACT, P.alex).getByTestId("member-balance")).toHaveText(`${pounds(more)} to give back`);
  // An admin who is not the collector cannot record a refund.
  await expect(row(page, ACT, P.alex).getByTestId("refund-form")).toHaveCount(0);

  // The collector gives it back and records it. Alex's credits are untouched.
  const creditsBefore = liveOf(await credits(db, P.alex)).length;
  await signInAs(page, P.rob.id, "/admin/months");
  const alex = row(page, ACT, P.alex);
  await expect(alex.getByTestId("refund-amount")).toHaveValue((more / 100).toFixed(2));
  await alex.getByTestId("refund-save").click();
  await expect(alex.getByTestId("member-refunded")).toHaveText(`Refunded ${pounds(more)}`);
  await expect(alex.getByTestId("member-balance")).toHaveCount(0);
  expect(await member(db, P.alex)).toMatchObject({ refundedPence: more, paidAmountPence: SHARE * N, amountDuePence: 700 * N });
  expect(liveOf(await credits(db, P.alex)).length).toBe(creditsBefore);
});

test("8. a closed month: its summary, reached from Earlier, and a late payment is still confirmed", async ({ page, db }) => {
  await signInAs(page, P.rob.id, "/admin/months");
  await expect(page.getByTestId("months-page")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("months-earlier-link").click();
  await expect(page.getByTestId("months-viewing-past")).toHaveText(`You are looking at ${PREV_LABEL}.`, { timeout: 30_000 });
  const past = page.locator(`[data-testid="month-card"][data-activity="${ACT}"]`);
  await expect(past.getByTestId("month-status")).toHaveText("Closed");
  // A closed month is not priced, changed or added to from here.
  await expect(past.getByTestId("price-form")).toHaveCount(0);
  await expect(past.getByTestId("member-add")).toHaveCount(0);

  const lines = past.getByTestId("month-summary-line");
  await expect(lines.nth(0)).toHaveText(`📒 ${PREV_NAME} summary (${PREV_GAMES} games played)`);
  await expect(lines.nth(1)).toHaveText("Regulars: 2. Paid and confirmed: 1 (£30).");
  await expect(lines.nth(2)).toHaveText(`Not paid: 1 (${P.carl.name} £30).`);
  await expect(past.getByTestId("month-summary")).toContainText("PAYG: no games played.");
  await expect(past.getByTestId("month-summary")).toContainText("Credits used this month: 1 game.");

  // Carl's money arrives after the close: the collector still confirms it.
  const carl = past.locator(`[data-testid="month-member"][data-user="${P.carl.id}"]`);
  await carl.getByTestId("paid-confirm").click();
  await expect(carl.locator("[data-paid]")).toHaveAttribute("data-paid", "confirmed");
  expect((await member(db, P.carl, PAST))!.paidAt).not.toBeNull();
  await expect(lines.nth(1)).toHaveText("Regulars: 2. Paid and confirmed: 2 (£60).");

  await page.getByTestId("months-current-link").click();
  await expect(page.getByTestId("months-viewing-past")).toHaveCount(0);
});

test("9. a player joins a month under way from their page", async ({ page, db }) => {
  await signInAs(page, P.tom.id, "/month");
  const mine = page.locator(`[data-testid="month-signup"][data-month="${MONTH}"]`);
  await expect(mine.getByTestId("month-join-rest")).toContainText(`The month is under way. You can still join for the rest of it: ${N - 1} games.`, { timeout: 30_000 });
  await mine.getByTestId("month-join-rest-btn").click();
  await expect(mine.getByTestId("month-state")).toHaveAttribute("data-outcome", "regular");
  // The games left (the calendar minus the week that is off), at the share as it stands.
  expect(await member(db, P.tom)).toMatchObject({ kind: "regular", gamesCovered: N - 1, creditsApplied: 0, amountDuePence: 700 * (N - 1) });
  await expect(mine.getByTestId("month-due")).toContainText(pounds(700 * (N - 1)));
  await expect(mine.getByTestId("month-join-rest")).toHaveCount(0);
  // The page said it, so he gets no DM; the organisers are told once.
  expect(await dms(db, P.tom)).toEqual([]);
  expect((await dms(db, P.rob)).filter((d) => d.text.startsWith(`📋 ${P.tom.name} joined ${MONTH_NAME} part-way: ${N - 1} games, ${pounds(700 * (N - 1))} to pay.`))).toHaveLength(1);
});

test("10. WEEKLY: the fixture club has no credits, no months and no sweep", async ({ db }) => {
  expect(await db.count(`SELECT COUNT(*) FROM "SquadCredit" WHERE "orgId" = $1`, [ORG_ID])).toBe(0);
  expect(await db.count(`SELECT COUNT(*) FROM "SquadMonth" WHERE "orgId" = $1`, [ORG_ID])).toBe(0);
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key LIKE $1`, [`org-${ORG_ID}:mcl:%`])).toBe(0);
});
