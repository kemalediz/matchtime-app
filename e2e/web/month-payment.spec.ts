/**
 * MONTHLY SQUAD, SLICE 4: THE PRICE, THE PAYMENTS AND THE REMINDERS, END
 * TO END AGAINST POSTGRES AND THE PAGES.
 *
 * MDs/monthly-squad-plan-2026-10-05.md, sections 4.2 and 4.3, decisions
 * D1, D3 and D5. No model is called anywhere in this file: the arithmetic,
 * the "paid" words and the collector's reply are all fixed code.
 *
 * One monthly club ("Vets MNF", 4 regular places) whose list for NEXT
 * month has been open a day. Polls run on a pinned clock (x-test-now);
 * the pages, the group and the DMs on the real one.
 *
 *   1. sign-up ends: the organisers are asked for the price, once;
 *   2. the organiser sets it on /admin/months: each regular's amount is
 *      share x games minus credits (a credit for a game not yet played is
 *      not spent), and the priced list is posted once;
 *   3. "says paid" from the list, a DM and the player's page: a claim,
 *      never a confirmation;
 *   4. the collector's daily digest, and the reply: a stray "ok" confirms
 *      nothing, a wrong number confirms nothing, "PAID 1" confirms one,
 *      "PAID NONE" is recorded and those claims are not asked about again;
 *   5. only the collector confirms, on the page too;
 *   6. the share is locked once somebody has paid;
 *   7. reminders: the count in the group and a DM each a day before, a
 *      second on the day, then the summary to the organisers and one DM a
 *      day for three days. Never the collector, never a pay link;
 *   8. a WEEKLY club is untouched by all of it.
 */
import { formatInTimeZone } from "date-fns-tz";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, signInAs, resetDb } from "../fixtures";
import { engineOn } from "../helpers/stub";
import { E2E } from "../helpers/env";
import { ORG_ID, PHONE, U } from "../helpers/constants";
import { testDb, type TestDb } from "../helpers/test-db";
import { defaultPayBy } from "@/lib/month-payment-rules";
import { buildClaimsDigest, buildCollectorReplyAnswer, buildPaidClaimAckDm, buildPayBySummary, buildPayReminderDm, pounds } from "@/lib/month-payment-copy";
import { listOpensAt, monthKickoffs, nextMonthStart } from "@/lib/month-signup-rules";
import { londonMonthStart } from "@/lib/squad-month-rules";

test.describe.configure({ mode: "serial" });

const ORG = "e2e-mp-org";
const GROUP = "e2e-monthpay@g.us";
const ACT = "e2e-mp-act";
const MONTH = "e2e-mp-month";
const LAST = "e2e-mp-last-game";
const INSTRUCTIONS = "Bank details are in the group description.";

const LONDON = "Europe/London";
const NEXT = nextMonthStart(londonMonthStart(new Date()));
const KICKOFFS = monthKickoffs(NEXT, 1, "20:00");
const N = KICKOFFS.length;
const FIRST = KICKOFFS[0];
const MONTH_NAME = formatInTimeZone(FIRST, LONDON, "MMMM");
const OPENS = listOpensAt(FIRST, 7);
/** A day after the list opened: the organisers are asked for the price.
 *  (Sign-up itself runs on until two days before the first game.) */
const ASK = new Date(OPENS.getTime() + 24 * 60 * 60_000);
/** Three days before the first game, 21:00 London. */
const PAY_BY = defaultPayBy(FIRST, new Date());
const PAY_BY_LABEL = formatInTimeZone(PAY_BY, LONDON, "EEE d MMM, HH:mm");
const matchId = (i: number) => `e2e-mp-match-${i}`;
const SHARE = 750;

const P = {
  rob: { id: "e2e-mp-rob", name: "Rob Hale", phone: "+447700940001" },
  alex: { id: "e2e-mp-alex", name: "Alex Carter", phone: "+447700940002" },
  bilal: { id: "e2e-mp-bilal", name: "Bilal Aydin", phone: "+447700940003" },
  carl: { id: "e2e-mp-carl", name: "Carl Young", phone: "+447700940004" },
  dev: { id: "e2e-mp-dev", name: "Dev Patel", phone: "+447700940005" },
  omar: { id: "e2e-mp-omar", name: "Omar Khan", phone: "+447700940006" },
  adam: { id: "e2e-mp-adam", name: "Adam Admin", phone: "+447700940007" },
} as const;
type Person = (typeof P)[keyof typeof P];
const digits = (phone: string) => phone.replace(/^\+/, "");
const DUE = { alex: SHARE * N, bilal: SHARE * (N - 1), carl: 500 * N, dev: SHARE * (N - 1) };

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
let seq = 0;
const msgId = () => `e2e-mp-${Date.now()}-${++seq}`;

interface Instruction {
  kind: string;
  key: string;
  text?: string;
  phone?: string;
  targetUser?: string;
}

async function poll(request: APIRequestContext, now: Date, groupId = GROUP): Promise<Instruction[]> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(groupId)}`, {
    headers: { ...KEY, "x-test-now": now.toISOString() },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).instructions as Instruction[];
}
const money = (instructions: Instruction[], org = ORG) => instructions.filter((i) => i.key.startsWith(`org-${org}:mpy:`));

/** A group message, the way the Pi forwards it. */
async function say(request: APIRequestContext, who: Person, body: string): Promise<{ handledBy: string; intent: string | null; react: string | null }> {
  const waMessageId = msgId();
  const res = await request.post("/api/whatsapp/analyze", {
    headers: KEY,
    data: { groupId: GROUP, messages: [{ waMessageId, body, authorPhone: digits(who.phone), authorName: who.name, timestamp: new Date().toISOString() }] },
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = (await res.json()) as { results?: Array<{ waMessageId: string; handledBy: string; intent: string | null; react: string | null }> };
  return (json.results ?? []).find((r) => r.waMessageId === waMessageId) ?? { handledBy: "none", intent: null, react: null };
}

/** A DM to MatchTime, the way the Pi forwards it. */
async function dm(request: APIRequestContext, who: { name: string; phone: string }, body: string): Promise<{ handled?: string | null }> {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: KEY,
    data: { phone: digits(who.phone), body, waMessageId: msgId(), authorName: who.name },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { handled?: string | null };
}

const member = (db: TestDb, who: Person) =>
  db.one<{
    amountDuePence: number | null;
    creditsApplied: number;
    gamesCovered: number;
    paidClaimedAt: Date | null;
    paidClaimSource: string | null;
    paidAt: Date | null;
    paidAmountPence: number | null;
    paidConfirmedByUserId: string | null;
    paymentMethod: string | null;
  }>(
    `SELECT "amountDuePence", "creditsApplied", "gamesCovered", "paidClaimedAt", "paidClaimSource", "paidAt", "paidAmountPence",
            "paidConfirmedByUserId", "paymentMethod" FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
    [MONTH, who.id],
  );

const dms = (db: TestDb, who: { phone: string }, org = ORG) =>
  db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 ORDER BY "createdAt"`, [org, digits(who.phone)]);
const lastDm = async (db: TestDb, who: { phone: string }) => (await dms(db, who)).at(-1)?.text ?? null;

const paidCount = (db: TestDb) => db.count(`SELECT COUNT(*) FROM "SquadMonthMember" WHERE "monthId" = $1 AND "paidAt" IS NOT NULL`, [MONTH]);

async function person(db: TestDb, p: { id: string; name: string; phone: string }, role = "PLAYER") {
  await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [p.id, `${p.id}@e2e.test`, p.name, p.phone]);
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4::"MemberRole")`, [`mem-${p.id}`, p.id, ORG, role]);
}

async function credit(db: TestDb, id: string, who: Person, earnedMatchId: string | null, o: { voided?: boolean } = {}) {
  await db.run(
    `INSERT INTO "SquadCredit" (id, "orgId", "userId", games, reason, "earnedMatchId", "voidedAt") VALUES ($1, $2, $3, 1, 'missed', $4, $5)`,
    [id, ORG, who.id, earnedMatchId, o.voided ? new Date().toISOString() : null],
  );
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "squadMode", "paygPricePence",
                                 "adminChannelMode", language, "paymentInstructions", "updatedAt")
     VALUES ($1, 'Vets MNF', $1, $2, $3, true, 'monthly', 800, 'each-admin', 'en', $4, now())`,
    [ORG, `${ORG}-invite`, GROUP, INSTRUCTIONS],
  );
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt")
     VALUES ('e2e-mp-sport', $1, 'Basketball', 2, ARRAY['G','F'], ARRAY['Red','Yellow'], now())`,
    [ORG],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "deadlineHours", "updatedAt")
     VALUES ($1, $2, 'e2e-mp-sport', 'Monday 7-a-side', 1, '20:00', 'Goals', 5, now())`,
    [ACT, ORG],
  );
  await person(db, P.rob, "OWNER");
  await person(db, P.adam, "ADMIN");
  for (const p of [P.alex, P.bilal, P.carl, P.dev, P.omar]) await person(db, p);
  // Rob collects the money.
  await db.run(`UPDATE "Organisation" SET "paymentHolderId" = $2 WHERE id = $1`, [ORG, P.rob.id]);

  // A game already played (a credit for it can be spent), and next month's games.
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "postMatchEndFlow", "isHistorical", "updatedAt")
     VALUES ($1, $2, now() - interval '9 days', 4, 'COMPLETED', now() - interval '9 days', false, true, now())`,
    [LAST, ACT],
  );
  for (const [i, k] of KICKOFFS.entries()) {
    await db.run(
      `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 4, 'UPCOMING', $4, now())`,
      [matchId(i), ACT, k.toISOString(), new Date(k.getTime() - 5 * 60 * 60 * 1000).toISOString()],
    );
  }
  await db.run(
    `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", status, "gamesScheduled", "listOpenedAt", "updatedAt")
     VALUES ($1, $2, $3, $4::date, 'open', $5, $6, now())`,
    [MONTH, ORG, ACT, NEXT, N, OPENS.toISOString()],
  );
  const rows: Array<[Person, string, number | null, string]> = [
    [P.alex, "regular", 1, "standard"],
    [P.bilal, "regular", 2, "standard"],
    [P.carl, "regular", 3, "concession"],
    [P.dev, "regular", 4, "standard"],
    [P.omar, "payg", null, "standard"],
  ];
  for (const [p, kind, slot, tier] of rows) {
    await db.run(
      `INSERT INTO "SquadMonthMember" (id, "monthId", "userId", kind, tier, slot, "gamesCovered", source, "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'carry-over', now())`,
      [`${MONTH}-${p.id}`, MONTH, p.id, kind, tier, slot, kind === "payg" ? 0 : N],
    );
  }
  // Bilal: one credit for a game that was played, one for a game still to
  // come (he may play it after all), and one an admin voided.
  await credit(db, "e2e-mp-credit-played", P.bilal, LAST);
  await credit(db, "e2e-mp-credit-future", P.bilal, matchId(1));
  await credit(db, "e2e-mp-credit-void", P.bilal, null, { voided: true });
  // Dev has one credit for a game that was played.
  await credit(db, "e2e-mp-credit-dev", P.dev, LAST);
  // Omar is PAYG: his credit is not the month's to spend.
  await credit(db, "e2e-mp-credit-payg", P.omar, null);
  engineOn({});
});
test.afterAll(() => resetDb());

test("1. a day after the list opens the organisers are asked for the price, once, and nothing is priced by itself", async ({ request, db }) => {
  await poll(request, new Date(ASK.getTime() + 5 * 60_000));
  const month = await db.one<{ status: string; pricedAt: Date | null; sharePerGamePence: number | null }>(
    `SELECT status, "pricedAt", "sharePerGamePence" FROM "SquadMonth" WHERE id = $1`,
    [MONTH],
  );
  // Sign-up is still open: it runs until two days before the first game.
  expect(month).toEqual({ status: "open", pricedAt: null, sharePerGamePence: null });

  const asks = (await dms(db, P.rob)).filter((d) => d.text.includes("Set the price"));
  expect(asks).toHaveLength(1);
  expect(asks[0].text.startsWith(`📋 ${MONTH_NAME} list: 4 regulars, 1 PAYG so far. Set the price: http`)).toBe(true);
  // The other admin is told too (the club's admin channel), and nobody else.
  expect((await dms(db, P.adam)).filter((d) => d.text.includes("Set the price"))).toHaveLength(1);
  expect(await dms(db, P.alex)).toEqual([]);

  await poll(request, new Date(ASK.getTime() + 7 * 60_000));
  expect((await dms(db, P.rob)).filter((d) => d.text.includes("Set the price"))).toHaveLength(1);
  // No amount, no payment post, before a price exists.
  expect((await member(db, P.alex))!.amountDuePence).toBeNull();
});

test("2. the organiser sets the price: share x games minus credits, and the priced list is posted once", async ({ page, request, db }) => {
  await signInAs(page, P.adam.id, "/admin/months");
  const card = page.getByTestId("next-month-card");
  const form = card.getByTestId("price-form");
  await expect(form).toBeVisible({ timeout: 30_000 });
  await expect(form.getByTestId("price-payby")).toHaveValue(formatInTimeZone(PAY_BY, LONDON, "yyyy-MM-dd'T'HH:mm"));
  await expect(card.getByTestId("info-mth_price")).toBeVisible();

  // The suggestion: venue cost over the 4 regulars, up to the next 50p.
  await form.getByTestId("price-venue").fill("29");
  await expect(form.getByTestId("price-suggestion")).toHaveText("Suggested: £7.50 a game (the venue cost over your regulars, rounded up to 50p).");

  // A bad share is refused with a reason, and nothing is saved.
  await form.getByTestId("price-share").fill("seven");
  await form.getByTestId("price-save").click();
  await expect(form.getByTestId("price-error")).toHaveText("Enter the share per game as a price like 7.50, up to £100.");
  expect((await member(db, P.alex))!.amountDuePence).toBeNull();

  await form.getByTestId("price-share").fill("7.50");
  await form.getByTestId("price-concession").fill("5");
  await form.getByTestId("price-save").click();
  await expect(card.getByTestId("month-share")).toContainText("Share per game: £7.50");
  await expect(card.getByTestId("month-payby")).toHaveText(`Pay by ${PAY_BY_LABEL}.`);

  // The table in plan 4.2, on real rows.
  expect(await member(db, P.alex)).toMatchObject({ amountDuePence: DUE.alex, creditsApplied: 0, gamesCovered: N });
  expect(await member(db, P.bilal)).toMatchObject({ amountDuePence: DUE.bilal, creditsApplied: 1 });
  expect(await member(db, P.carl)).toMatchObject({ amountDuePence: DUE.carl, creditsApplied: 0 });
  expect(await member(db, P.omar)).toMatchObject({ amountDuePence: null, creditsApplied: 0 });
  // Only the credit for the game that was played is spent.
  const credits = await db.all<{ id: string; applied: string | null }>(`SELECT id, "appliedMonthId" AS applied FROM "SquadCredit" WHERE "orgId" = $1 ORDER BY id`, [ORG]);
  expect(credits).toEqual([
    { id: "e2e-mp-credit-dev", applied: MONTH },
    { id: "e2e-mp-credit-future", applied: null },
    { id: "e2e-mp-credit-payg", applied: null },
    { id: "e2e-mp-credit-played", applied: MONTH },
    { id: "e2e-mp-credit-void", applied: null },
  ]);
  const row = (who: Person) => card.locator(`[data-testid="month-member"][data-user="${who.id}"]`);
  await expect(row(P.bilal)).toContainText(pounds(DUE.bilal));

  // Saving the same price again changes nothing (no credit is taken twice).
  await form.getByTestId("price-save").click();
  await expect(form.getByTestId("price-save")).toBeEnabled();
  expect(await member(db, P.bilal)).toMatchObject({ amountDuePence: DUE.bilal, creditsApplied: 1 });

  // The priced list, once.
  const first = money(await poll(request, new Date(ASK.getTime() + 20 * 60_000)));
  expect(first).toHaveLength(1);
  expect(first[0].kind).toBe("group-message");
  expect(first[0].key.startsWith(`org-${ORG}:mpy:priced:${MONTH}:`)).toBe(true);
  expect(first[0].text).toBe(
    [
      `📋 List for ${MONTH_NAME}: £7.50 a game, pay Rob by ${PAY_BY_LABEL}`,
      `(${N} games = ${pounds(SHARE * N)}. Credits are already taken off.)`,
      "",
      `1. Alex Carter (${pounds(DUE.alex)})`,
      `2. Bilal Aydin (${pounds(DUE.bilal)})`,
      `3. Carl Young (${pounds(DUE.carl)})`,
      `4. Dev Patel (${pounds(DUE.dev)})`,
      "",
      `Payment: ${INSTRUCTIONS}`,
      'Paid? Add (paid) after your name and paste the list, or DM me "paid".',
    ].join("\n"),
  );
  expect(money(await poll(request, new Date(ASK.getTime() + 25 * 60_000)))).toEqual([]);
});

test("3. 'says paid' from the list, a DM and the page: a claim every time, never a confirmation", async ({ page, request, db }) => {
  // The list: Alex pastes MatchTime's own priced list with (paid) on his
  // line. It is the MONTH's list: nobody's week changes by it.
  const squadBefore = await db.all(`SELECT "userId", status::text FROM "Attendance" WHERE "matchId" = $1 ORDER BY "userId"`, [matchId(0)]);
  const pasted = await say(
    request,
    P.alex,
    [
      `📋 List for ${MONTH_NAME}: £7.50 a game, pay Rob by ${PAY_BY_LABEL}`,
      "",
      `1. Alex Carter (${pounds(DUE.alex)}) (paid)`,
      `2. Bilal Aydin (${pounds(DUE.bilal)})`,
      `3. Carl Young (${pounds(DUE.carl)})`,
      "4.",
    ].join("\n"),
  );
  expect(pasted).toMatchObject({ handledBy: "fast-path", intent: "month_signup_list", react: "✅" });
  expect(await member(db, P.alex)).toMatchObject({ paidClaimSource: "list", paidAt: null });
  expect((await member(db, P.alex))!.paidClaimedAt).not.toBeNull();
  // Dev's line was blanked on that copy by somebody else: he is still on the month and on the game.
  expect(await db.all(`SELECT "userId", status::text FROM "Attendance" WHERE "matchId" = $1 ORDER BY "userId"`, [matchId(0)])).toEqual(squadBefore);
  expect(await db.count(`SELECT COUNT(*) FROM "SquadMonthMember" WHERE "monthId" = $1 AND "leftAt" IS NOT NULL`, [MONTH])).toBe(0);

  // A DM: "paid", in the fixed words.
  const claimed = await dm(request, P.bilal, "Paid 👍");
  expect(claimed.handled).toBe("month-paid-claim");
  expect(await member(db, P.bilal)).toMatchObject({ paidClaimSource: "dm", paidAt: null });
  expect(await lastDm(db, P.bilal)).toBe(buildPaidClaimAckDm({ name: P.bilal.name, amountPence: DUE.bilal, monthDate: FIRST, collectorName: P.rob.name, lang: "en" }));
  // Saying it again: still one claim, and no second answer today.
  await dm(request, P.bilal, "paid");
  expect(await dms(db, P.bilal)).toHaveLength(1);
  // A question is not a claim.
  expect((await dm(request, P.dev, "have I paid?")).handled).not.toBe("month-paid-claim");
  expect((await member(db, P.dev))!.paidClaimedAt).toBeNull();

  // The page: what Carl owes, how to pay, and "I've paid".
  await signInAs(page, P.carl.id, "/month");
  const card = page.getByTestId("month-signup");
  await expect(card.getByTestId("month-due")).toHaveText(`${pounds(DUE.carl)} for ${N} games.`, { timeout: 30_000 });
  await expect(card.getByTestId("month-payby")).toHaveText(`Pay Rob by bank transfer by ${PAY_BY_LABEL}.`);
  await expect(card.getByTestId("month-instructions")).toHaveText(INSTRUCTIONS);
  await card.getByTestId("month-paid").click();
  await expect(card.getByTestId("month-paid-state")).toHaveText("You have said you paid. The collector confirms when it arrives.");
  await expect(card.getByTestId("month-paid")).toHaveCount(0);
  expect(await member(db, P.carl)).toMatchObject({ paidClaimSource: "page", paidAt: null });

  // Three claims. Nobody is paid.
  expect(await paidCount(db)).toBe(0);
});

test("4. the collector's digest and reply: never a stray word, never a wrong number; a decline is recorded", async ({ request, db }) => {
  // Before 10:00 nothing; from 10:00 one digest, to the collector alone.
  const dayAfter = new Date(ASK.getTime() + 24 * 60 * 60_000);
  await poll(request, new Date(dayAfter.getTime() - 30 * 60_000));
  const digestOf = async () => (await dms(db, P.rob)).filter((d) => d.text.includes("they've paid"));
  expect(await digestOf()).toHaveLength(0);
  await poll(request, new Date(dayAfter.getTime() + 5 * 60_000));
  await poll(request, new Date(dayAfter.getTime() + 60 * 60_000));
  expect((await digestOf()).map((d) => d.text)).toEqual([
    buildClaimsDigest({
      claims: [
        { slot: 1, name: P.alex.name, amountPence: DUE.alex },
        { slot: 2, name: P.bilal.name, amountPence: DUE.bilal },
        { slot: 3, name: P.carl.name, amountPence: DUE.carl },
      ],
      monthDate: FIRST,
      lang: "en",
    }),
  ]);
  expect((await dms(db, P.adam)).some((d) => d.text.includes("they've paid"))).toBe(false);

  // A stray word, a bare number, a thumbs up: nothing is confirmed.
  for (const stray of ["ok", "yes", "1 3", "all", "👍", "paid"]) {
    const res = await dm(request, P.rob, stray);
    expect(res.handled ?? "", stray).not.toMatch(/^month-paid-(confirmed|declined)/);
  }
  expect(await paidCount(db)).toBe(0);

  // An admin who is not the collector cannot confirm by reply.
  const notCollector = await dm(request, P.adam, "PAID ALL");
  expect(notCollector.handled ?? "").not.toMatch(/^month-paid/);
  expect(await paidCount(db)).toBe(0);

  // A number that is not a claim confirms NOBODY, not even the right one beside it.
  const wrong = await dm(request, P.rob, "PAID 1 4");
  expect(wrong.handled).toBe("month-paid-unknown");
  expect(await paidCount(db)).toBe(0);
  expect(await lastDm(db, P.rob)).toBe(buildCollectorReplyAnswer({ kind: "unknown-numbers", numbers: [4], monthDate: FIRST, lang: "en" }));

  // "PAID 1": Alex, and only Alex.
  const one = await dm(request, P.rob, "PAID 1");
  expect(one.handled).toBe("month-paid-confirmed");
  expect(await member(db, P.alex)).toMatchObject({ paidAmountPence: DUE.alex, paidConfirmedByUserId: P.rob.id, paymentMethod: "bank" });
  expect((await member(db, P.alex))!.paidAt).not.toBeNull();
  expect(await paidCount(db)).toBe(1);
  expect(await lastDm(db, P.rob)).toBe(buildCollectorReplyAnswer({ kind: "confirmed", names: [P.alex.name], monthDate: FIRST, lang: "en" }));

  // "PAID NONE": recorded. The claims stand; they are not asked about again.
  const none = await dm(request, P.rob, "paid none");
  expect(none.handled).toBe("month-paid-declined");
  expect(await paidCount(db)).toBe(1);
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE kind = 'month-pay-declined' AND key LIKE $1`, [`org-${ORG}:mpy:declined:${MONTH}:%`])).toBe(2);
  expect((await member(db, P.bilal))!.paidClaimedAt).not.toBeNull();
  const twoDays = new Date(ASK.getTime() + 48 * 60 * 60_000 + 5 * 60_000);
  await poll(request, twoDays);
  expect(await digestOf()).toHaveLength(1);

  // Bilal says "paid" again: a NEW claim, with a new time.
  const firstClaim = (await member(db, P.bilal))!.paidClaimedAt!;
  await db.run(`DELETE FROM "SentNotification" WHERE key LIKE $1`, [`org-${ORG}:mpy:claim-ack:%`]);
  expect((await dm(request, P.bilal, "paid")).handled).toBe("month-paid-claim");
  expect(new Date((await member(db, P.bilal))!.paidClaimedAt!).getTime()).toBeGreaterThan(new Date(firstClaim).getTime());
  // THE REVIEW'S CASE. The collector now sends "PAID ALL" (meaning
  // somebody else, or the old digest). Bilal was on that digest, but this
  // claim has not been shown to the collector: NOBODY is confirmed.
  const stale = await dm(request, P.rob, "PAID ALL");
  expect(stale.handled).toBe("month-paid-nothing");
  expect(await paidCount(db)).toBe(1);
  expect((await member(db, P.bilal))!.paidAt).toBeNull();
  // And "PAID 2" (his number) is not an answer to that digest at all.
  expect(((await dm(request, P.rob, "PAID 2")).handled ?? "")).not.toMatch(/^month-paid-(confirmed|declined)/);
  expect(await paidCount(db)).toBe(1);
  // An amount is never a list number, whoever sends it.
  expect(((await dm(request, P.rob, "paid 1.50")).handled ?? "")).not.toMatch(/^month-paid/);
  expect(await paidCount(db)).toBe(1);
  // It goes on a new digest first.
  // (Later the same day: no digest had gone out today, there was nothing waiting.)
  await poll(request, new Date(twoDays.getTime() + 60 * 60_000));
  const digests = await digestOf();
  expect(digests).toHaveLength(2);
  expect(digests[1].text).toBe(buildClaimsDigest({ claims: [{ slot: 2, name: P.bilal.name, amountPence: DUE.bilal }], monthDate: FIRST, lang: "en" }));
  // "PAID ALL" is what that digest showed: Bilal. Not Carl, who was declined.
  expect((await dm(request, P.rob, "PAID ALL")).handled).toBe("month-paid-confirmed");
  expect((await member(db, P.bilal))!.paidAt).not.toBeNull();
  expect((await member(db, P.carl))!.paidAt).toBeNull();
  expect(await paidCount(db)).toBe(2);
});

test("5. only the collector confirms on the page; 6. the share is locked once somebody has paid", async ({ page, db }) => {
  // Adam is an admin, not the collector: no confirm button at all.
  await signInAs(page, P.adam.id, "/admin/months");
  const card = page.getByTestId("next-month-card");
  await expect(card.getByTestId("price-form")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("paid-confirm")).toHaveCount(0);
  await expect(card.getByTestId("paid-undo")).toHaveCount(0);

  // The share is locked; the pay-by date is not.
  const form = card.getByTestId("price-form");
  await expect(form.getByTestId("price-locked")).toBeVisible();
  await expect(form.getByTestId("price-share")).toBeDisabled();

  // Rob is the collector: he confirms Carl, and can take a confirmation back.
  await signInAs(page, P.rob.id, "/admin/months");
  const row = (who: Person) => page.getByTestId("next-month-card").locator(`[data-testid="month-member"][data-user="${who.id}"]`);
  await expect(row(P.carl).locator("[data-paid]")).toContainText("Says paid", { timeout: 30_000 });
  await row(P.carl).getByTestId("paid-confirm").click();
  await expect(row(P.carl).locator("[data-paid]")).toContainText("Paid, confirmed");
  expect(await member(db, P.carl)).toMatchObject({ paidConfirmedByUserId: P.rob.id, paymentMethod: "bank", paidAmountPence: DUE.carl });
  await row(P.carl).getByTestId("paid-undo").click();
  await expect(row(P.carl).locator("[data-paid]")).toContainText("Says paid");
  const carl = await member(db, P.carl);
  expect(carl).toMatchObject({ paidAt: null, paidConfirmedByUserId: null, paidClaimSource: "page" });
  expect(carl!.paidClaimedAt).not.toBeNull();
});

test("7. reminders: the count and a DM a day before, a second on the day, the summary, then three late chases and silence", async ({ page, request, db }) => {
  const HOUR = 60 * 60_000;
  // Carl's claim was answered "not arrived": he is chased again. Dev never said anything.
  const dayBefore = money(await poll(request, new Date(PAY_BY.getTime() - 24 * HOUR + 30 * 60_000)));
  expect(dayBefore.map((i) => i.key).sort()).toEqual(
    [`org-${ORG}:mpy:dm:${MONTH}:${P.carl.id}:r1`, `org-${ORG}:mpy:dm:${MONTH}:${P.dev.id}:r1`, `org-${ORG}:mpy:group:${MONTH}:count`].sort(),
  );
  expect(dayBefore.find((i) => i.kind === "group-message")!.text).toBe(`💷 2 still to pay for ${MONTH_NAME}, by ${PAY_BY_LABEL}.`);
  const devDm = dayBefore.find((i) => i.targetUser === P.dev.id)!;
  expect(devDm).toMatchObject({ kind: "dm", phone: digits(P.dev.phone) });
  expect(devDm.text).toBe(
    buildPayReminderDm({
      kind: "r1",
      name: P.dev.name,
      monthDate: FIRST,
      amountDuePence: DUE.dev,
      games: N,
      credits: 1,
      payByAt: PAY_BY,
      collectorName: P.rob.name,
      instructions: INSTRUCTIONS,
      lang: "en",
    }),
  );
  // Bank transfer only: never a link to pay.
  for (const i of dayBefore) expect(i.text).not.toMatch(/https?:/);
  // Once: the next poll has nothing.
  expect(money(await poll(request, new Date(PAY_BY.getTime() - 24 * HOUR + 40 * 60_000)))).toEqual([]);

  // The deadline's own morning: the second DM, to the same two.
  const onTheDay = money(await poll(request, new Date(PAY_BY.getTime() - 11 * HOUR)));
  expect(onTheDay.map((i) => i.key).sort()).toEqual([`org-${ORG}:mpy:dm:${MONTH}:${P.carl.id}:r2`, `org-${ORG}:mpy:dm:${MONTH}:${P.dev.id}:r2`].sort());

  // Dev pays in the afternoon and says so: no more reminders for him.
  expect((await dm(request, P.dev, "I've paid")).handled).toBe("month-paid-claim");

  // After the pay-by date: the summary to the organisers, once.
  const dayAfter = new Date(PAY_BY.getTime() + 13 * HOUR);
  const late1 = money(await poll(request, dayAfter));
  const summary = (await dms(db, P.rob)).filter((d) => d.text.includes("the pay-by date has passed"));
  expect(summary).toHaveLength(1);
  expect(
    summary[0].text.startsWith(
      buildPayBySummary({
        monthDate: FIRST,
        confirmed: { count: 2, totalPence: DUE.alex + DUE.bilal },
        claimed: [P.carl.name, P.dev.name],
        unpaid: [],
        venue: { duePence: DUE.alex + DUE.bilal + DUE.carl + DUE.dev, venuePence: 2900 * N },
        lang: "en",
      }),
    ),
  ).toBe(true);
  // One late chase a day for three days, to Carl alone, then silence.
  const lateKey = (when: Date) => `org-${ORG}:mpy:dm:${MONTH}:${P.carl.id}:late:${formatInTimeZone(when, LONDON, "yyyy-MM-dd")}`;
  expect(late1.map((i) => i.key)).toEqual([lateKey(dayAfter)]);
  expect(money(await poll(request, new Date(dayAfter.getTime() + HOUR)))).toEqual([]);
  for (const days of [1, 2]) {
    const when = new Date(dayAfter.getTime() + days * 24 * HOUR);
    expect(money(await poll(request, when)).map((i) => i.key)).toEqual([lateKey(when)]);
  }
  expect(money(await poll(request, new Date(dayAfter.getTime() + 3 * 24 * HOUR)))).toEqual([]);
  expect((await dms(db, P.rob)).filter((d) => d.text.includes("the pay-by date has passed"))).toHaveLength(1);

  // Through all of it the collector was never sent a reminder, and nobody was marked paid by a poll.
  expect(await paidCount(db)).toBe(2);

  // The organiser moves Dev to PAYG. He had said "paid", and one credit
  // had been taken for him: it goes back to the ledger, and he owes nothing.
  await signInAs(page, P.adam.id, "/admin/months");
  const devRow = page.locator(`[data-testid="month-member"][data-user="${P.dev.id}"]`);
  await expect(devRow).toBeVisible({ timeout: 30_000 });
  await devRow.getByTestId("member-make-payg").click();
  await expect(devRow.locator("[data-kind]")).toHaveText("PAYG");
  expect(await member(db, P.dev)).toMatchObject({ amountDuePence: null, creditsApplied: 0, paidAt: null });
  expect(await db.one(`SELECT "appliedMonthId" AS applied FROM "SquadCredit" WHERE id = 'e2e-mp-credit-dev'`)).toEqual({ applied: null });
  // Bilal's payment is confirmed: his credit stays spent.
  expect(await db.one(`SELECT "appliedMonthId" AS applied FROM "SquadCredit" WHERE id = 'e2e-mp-credit-played'`)).toEqual({ applied: MONTH });

  // The pay-by date is moved after the summary went out: one more summary is due after the new date.
  const sent = () => db.one<{ sent: boolean }>(`SELECT ("summarySentAt" IS NOT NULL) AS sent FROM "SquadMonth" WHERE id = $1`, [MONTH]);
  expect(await sent()).toEqual({ sent: true });
  const form = page.getByTestId("price-form").first();
  const later = new Date(PAY_BY.getTime() + 24 * HOUR);
  await form.getByTestId("price-payby").fill(formatInTimeZone(later, LONDON, "yyyy-MM-dd'T'HH:mm"));
  await form.getByTestId("price-save").click();
  await expect.poll(async () => (await sent())!.sent).toBe(false);
  await poll(request, new Date(later.getTime() + 13 * HOUR));
  await poll(request, new Date(later.getTime() + 14 * HOUR));
  expect(await sent()).toEqual({ sent: true });
  expect((await dms(db, P.rob)).filter((d) => d.text.includes("the pay-by date has passed"))).toHaveLength(2);
});

test("8. a WEEKLY club is untouched: its 'paid' DM, a PAID ALL and its poll are what they were", async ({ request, db }) => {
  const weeklyGroup = (await db.one<{ g: string }>(`SELECT "whatsappGroupId" AS g FROM "Organisation" WHERE id = $1`, [ORG_ID]))!.g;
  const player = await dm(request, { name: "Pat Player", phone: PHONE.player }, "paid");
  expect(player.handled ?? "").not.toMatch(/^month-paid/);
  const admin = await dm(request, { name: "Alex Admin", phone: PHONE.admin }, "PAID ALL");
  expect(admin.handled ?? "").not.toMatch(/^month-paid/);
  const out = await poll(request, new Date(Date.now() + 60 * 60_000), weeklyGroup);
  expect(out.some((i) => i.key.includes(":mpy:"))).toBe(false);
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key LIKE $1`, [`org-${ORG_ID}:mpy:%`])).toBe(0);
  expect(await db.count(`SELECT COUNT(*) FROM "SquadMonth" WHERE "orgId" = $1`, [ORG_ID])).toBe(0);
  void U;
});
