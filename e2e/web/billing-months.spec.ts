/**
 * Club fee billing, slice P4 (games played): the months on the web. Plan:
 * MDs/club-fee-billing-plan-2026-10-01.md, sections 8.1 to 8.3.
 *
 *   1. /billing/[orgId] for the money collector (a PLAYER, whose own card
 *      is on file): the "this month" box counted from the club's real rows
 *      (one game played so far), the past months, the games behind "See
 *      games", and the receipt link ONLY for a month invoiced since their
 *      card went on. The receipt route sends them to Stripe's hosted page.
 *   2. The owner reading the same page: the month box, no receipt links,
 *      and the receipt route refuses them.
 *   3. /admin/settings: the card's month box and last month line.
 *   4. Past due with an unpaid month: the page names the month and its
 *      amount; the banner too (never "this month's club fee").
 *   5. /admin/clubs: this month so far, last month, the totals line.
 *
 * Stripe is the fake adapter (MT_TEST_MODE, BILLING_STRIPE_FAKE). The
 * months are seeded as the hourly cron leaves them; nothing is charged.
 */
import { test, expect, resetDb, signInAs } from "../fixtures";
import { E2E } from "../helpers/env";
import { testDb } from "../helpers/test-db";
// Static imports: Playwright rewrites the "@/" alias only for these.
import { countClubMonth, monthBounds, monthIndexAt } from "@/lib/club-billing-cycle-rules";
import { monthBoxText, monthRangeLabels } from "@/lib/club-billing-view";
import { createFakeBillingStripe } from "@/lib/stripe-billing-fake";
import { formatLondon, londonDateTimeToUtc } from "@/lib/london-time";

test.describe.configure({ mode: "serial" });

const P = "e2e-bill4";
const ORG = `${P}-club`;
const USER = { owner: `${P}-owner`, colin: `${P}-colin` } as const;
const DASH = /[—–]/;
const DAY = 24 * 60 * 60 * 1000;

const fake = () => createFakeBillingStripe({ file: E2E.BILLING_STRIPE_FILE });

// The club's months: the free month ended two months and about 15 days
// ago, so the current month started about 15 days ago and runs about 15
// more; months index-1 and index-2 are closed.
const NOW = new Date();
const anchor = (() => {
  const d = new Date(NOW.getTime() - 15 * DAY);
  d.setUTCMonth(d.getUTCMonth() - 2);
  return d;
})();
const IDX = monthIndexAt(anchor, NOW);
const CUR = monthBounds(anchor, IDX);
const PREV = monthBounds(anchor, IDX - 1);
const OLDER = monthBounds(anchor, IDX - 2);

// One game played 7 days ago at 20:00 London (inside the current month).
const playedDay = formatLondon(new Date(NOW.getTime() - 7 * DAY), "yyyy-MM-dd");
const PLAYED_AT = londonDateTimeToUtc(playedDay, "20:00");
const WEEKDAY = Number(formatLondon(PLAYED_AT, "i")) % 7; // ISO 1..7 to JS 0..6
const ACTIVITY_CREATED = new Date(NOW.getTime() - 120 * DAY);

let prevInvoice = "";
let olderInvoice = "";

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"approvedAt","approvalDecidedAt","billingStatus","createdAt","updatedAt")
     VALUES ($1,'Month Sevens',$1,$2,'approved','en',$3,$3,'subscribed',now(),now())`,
    [ORG, `${ORG}-invite`, new Date(anchor.getTime() - 30 * DAY)],
  );
  for (const [id, name, phone] of [
    [USER.owner, "Olive Owner", "+447700904001"],
    [USER.colin, "Colin Months", "+447700904002"],
  ] as const) {
    await db.run(
      `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,$2,$3,$4,true,true,now())`,
      [id, name, `${id}@e2e-test.invalid`, phone],
    );
  }
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER')`, [`${USER.owner}-m`, USER.owner, ORG]);
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'PLAYER')`, [`${USER.colin}-m`, USER.colin, ORG]);
  await db.run(`UPDATE "Organisation" SET "paymentHolderId"=$2 WHERE id=$1`, [ORG, USER.colin]);

  const customer = await fake().createCustomer({ orgId: ORG, name: "Month Sevens" });
  await db.run(
    `INSERT INTO "ClubBilling" ("orgId","trialStartedAt","trialEndsAt","stripeCustomerId","stripePaymentMethodId","cardBrand","cardLast4","cardHolderUserId","currentPeriodEnd","billingCountry","cardCountry","updatedAt")
     VALUES ($1,$2,$3,$4,'pm_e2e_months','visa','4242',$5,$6,'GB','GB',now())`,
    [ORG, new Date(anchor.getTime() - 30 * DAY), anchor, customer.id, USER.colin, CUR.endsAt],
  );

  await db.run(
    `INSERT INTO "Sport" (id,"orgId",name,preset,"playersPerTeam",positions,"teamLabels","updatedAt")
     VALUES ($1,$2,'Football 5-a-side','football-5aside',5,'{GK,DEF,MID,FWD}','{Red,Yellow}',now())`,
    [`${P}-sport`, ORG],
  );
  await db.run(
    `INSERT INTO "Activity" (id,"orgId","sportId",name,"dayOfWeek",time,venue,"createdAt","updatedAt")
     VALUES ($1,$2,$3,'Weekly 5s',$4,'20:00','Months Arena',$5,now())`,
    [`${P}-activity`, ORG, `${P}-sport`, WEEKDAY, ACTIVITY_CREATED],
  );
  await db.run(
    `INSERT INTO "Match" (id,"activityId",date,"maxPlayers",status,"attendanceDeadline","updatedAt") VALUES ($1,$2,$3,10,'COMPLETED',$3,now())`,
    [`${P}-match`, `${P}-activity`, PLAYED_AT],
  );
  await db.run(`INSERT INTO "Attendance" (id,"matchId","userId",status,"updatedAt") VALUES ($1,$2,$3,'CONFIRMED',now())`, [`${P}-att`, `${P}-match`, USER.colin]);

  // Colin's card went on between the older month's close and the last one's.
  const cardOn = new Date(PREV.endsAt.getTime() - 3 * DAY);
  await db.run(`INSERT INTO "BillingEvent" (id,type,"orgId","receivedAt","processedAt") VALUES ($1,'mt.card-session',$2,$3,$3)`, [
    `mt_card_session_${P}`,
    ORG,
    cardOn,
  ]);

  const invoice = async (monthId: string, pence: number) => {
    const args = { orgId: ORG, monthId, customerId: customer.id, description: `MatchTime club fee: e2e ${monthId}` };
    const inv = await fake().createMonthInvoice(args);
    await fake().addMonthInvoiceItem({ ...args, invoiceId: inv.id, amountPence: pence, productId: "prod_e2e_club", taxRateId: "txr_e2e_vat" });
    await fake().finalizeInvoice(inv.id);
    return inv.id;
  };
  olderInvoice = await invoice(`${P}-m-older`, 749);
  prevInvoice = await invoice(`${P}-m-prev`, 799);
  const games = JSON.stringify([
    { kickoff: new Date(PREV.startsAt.getTime() + 2 * DAY).toISOString(), source: "weekly", matchIds: [], played: true, outcome: "played" },
    { kickoff: new Date(PREV.startsAt.getTime() + 9 * DAY).toISOString(), source: "weekly", matchIds: [], played: false, outcome: "cancelled" },
  ]);
  const month = `INSERT INTO "ClubBillingMonth" (id,"orgId",index,"startsAt","endsAt","priceAtStartPence",status,scheduled,played,"pricePence","amountPence","stripeInvoiceId",games,"closedAt","paidAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,999,$6,$7,$8,999,$9,$10,$11::jsonb,$12,$13,now())`;
  // Invoiced BEFORE Colin's card went on: listed, no receipt.
  await db.run(month, [`${P}-m-older`, ORG, IDX - 2, OLDER.startsAt, OLDER.endsAt, "paid", 4, 3, 749, olderInvoice, "[]", new Date(OLDER.endsAt.getTime() + 10 * 3600 * 1000), new Date(OLDER.endsAt.getTime() + 10 * 3600 * 1000)]);
  // Invoiced on Colin's card: listed with its receipt.
  await db.run(month, [`${P}-m-prev`, ORG, IDX - 1, PREV.startsAt, PREV.endsAt, "paid", 5, 4, 799, prevInvoice, games, new Date(PREV.endsAt.getTime() + 10 * 3600 * 1000), new Date(PREV.endsAt.getTime() + 10 * 3600 * 1000)]);
  await db.run(
    `INSERT INTO "ClubBillingMonth" (id,"orgId",index,"startsAt","endsAt","priceAtStartPence",status,"updatedAt") VALUES ($1,$2,$3,$4,$5,999,'open',now())`,
    [`${P}-m-cur`, ORG, IDX, CUR.startsAt, CUR.endsAt],
  );
});

test.afterAll(() => {
  resetDb();
});

/** The month box as the page must word it, from the same pure count. */
function expectedBox(): string {
  const count = countClubMonth({
    startsAt: CUR.startsAt,
    endsAt: CUR.endsAt,
    activities: [{ id: `${P}-activity`, dayOfWeek: WEEKDAY, time: "20:00", venue: "Months Arena", isActive: true, createdAt: ACTIVITY_CREATED }],
    matches: [
      { id: `${P}-match`, activityId: `${P}-activity`, date: PLAYED_AT, status: "COMPLETED", isHistorical: false, redScore: null, yellowScore: null, confirmedCount: 1 },
    ],
    pauseSpans: [],
    tracksAttendance: true,
    now: new Date(),
  });
  expect(count.played).toBe(1);
  return monthBoxText("en", { ...CUR, played: count.played, scheduled: count.scheduled, upcoming: count.upcoming, pricePence: 999 });
}

test("1. the money collector: this month so far, past months, See games, and their own card's receipt only", async ({ page }) => {
  await signInAs(page, USER.colin, `/billing/${ORG}`);
  await expect(page.getByTestId("billing-page")).toHaveAttribute("data-role", "contact", { timeout: 30_000 });
  await expect(page.getByTestId("billing-month-box")).toHaveText(expectedBox());
  await expect(page.getByTestId("billing-month-box")).toContainText("1 of ");
  await expect(page.getByTestId("billing-state")).toContainText("Only the games played are charged, up to £9.99 a month. Next charge");
  await expect(page.getByTestId("billing-state")).toContainText("Card visa ending 4242.");

  const prev = monthRangeLabels("en", PREV);
  const older = monthRangeLabels("en", OLDER);
  const months = page.getByTestId("billing-past-month");
  await expect(months).toHaveCount(2);
  await expect(months.nth(0)).toContainText(`${prev.from} to ${prev.to}: 4 of 5 games, £7.99 paid`);
  await expect(months.nth(1)).toContainText(`${older.from} to ${older.to}: 3 of 4 games, £7.49 paid`);
  // The receipt only for the month invoiced on Colin's own card.
  await expect(months.nth(0).getByTestId("billing-receipt")).toHaveAttribute("href", `/billing/${ORG}/receipt/${P}-m-prev`);
  await expect(months.nth(1).getByTestId("billing-receipt")).toHaveCount(0);

  await months.nth(0).getByTestId("billing-see-games").click();
  await expect(months.nth(0)).toContainText(": played");
  await expect(months.nth(0)).toContainText(": cancelled");
  expect(await page.getByTestId("billing-page").innerText()).not.toMatch(DASH);

  // The receipt route: Stripe's hosted page for the allowed month only.
  const ok = await page.request.get(`/billing/${ORG}/receipt/${P}-m-prev`, { maxRedirects: 0 });
  expect(ok.status()).toBe(307);
  expect(ok.headers().location).toBe(`https://invoice.stripe.test/${prevInvoice}`);
  const refused = await page.request.get(`/billing/${ORG}/receipt/${P}-m-older`, { maxRedirects: 0 });
  expect(refused.status()).toBe(307);
  expect(refused.headers().location).toMatch(new RegExp(`/billing/${ORG}$`));
});

test("2. the owner reads the same page: the month box, no receipts, and the route refuses them", async ({ page }) => {
  await signInAs(page, USER.owner, `/billing/${ORG}`);
  await expect(page.getByTestId("billing-page")).toHaveAttribute("data-role", "viewer", { timeout: 30_000 });
  await expect(page.getByTestId("billing-month-box")).toHaveText(expectedBox());
  await expect(page.getByTestId("billing-past-month")).toHaveCount(2);
  await expect(page.getByTestId("billing-receipt")).toHaveCount(0);
  const res = await page.request.get(`/billing/${ORG}/receipt/${P}-m-prev`, { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers().location).toMatch(new RegExp(`/billing/${ORG}$`));
});

test("3. /admin/settings: this month so far and the last month", async ({ page }) => {
  await signInAs(page, USER.owner, "/admin/settings");
  const card = page.getByTestId("settings-billing-card");
  await expect(card.getByTestId("settings-billing-month")).toHaveText(expectedBox(), { timeout: 30_000 });
  const prev = monthRangeLabels("en", PREV);
  await expect(card.getByTestId("settings-billing-last-month")).toHaveText(`${prev.from} to ${prev.to}: 4 of 5 games, £7.99 paid`);
  expect(await card.innerText()).not.toMatch(/Next payment/);
});

test("4. past due: the page and the banner name the unpaid month and its amount", async ({ page }) => {
  const db = testDb();
  await db.run(`UPDATE "ClubBillingMonth" SET status='failed', "paidAt"=NULL WHERE id=$1`, [`${P}-m-prev`]);
  await db.run(`UPDATE "Organisation" SET "billingStatus"='past_due' WHERE id=$1`, [ORG]);
  await db.run(`UPDATE "ClubBilling" SET "graceEndsAt"=$2,"paymentFailedAt"=now() WHERE "orgId"=$1`, [ORG, new Date(NOW.getTime() + 5 * DAY)]);
  try {
    const prev = monthRangeLabels("en", PREV);
    await signInAs(page, USER.colin, `/billing/${ORG}`);
    await expect(page.getByTestId("billing-state")).toContainText(
      `The £7.99 for ${prev.from} to ${prev.to} didn't go through. It will be tried again over the next few days. MatchTime stops on`,
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("billing-past-month").nth(0)).toContainText("£7.99 not paid yet");
    await expect(page.getByTestId("billing-btn-update-card")).toBeVisible();

    await page.context().clearCookies();
    await signInAs(page, USER.owner, "/admin");
    const banner = page.getByTestId("billing-banner");
    await expect(banner).toContainText(`The club fee for ${prev.from} to ${prev.to} (£7.99) didn't go through.`, { timeout: 30_000 });
    await expect(banner).not.toContainText("This month's club fee");
  } finally {
    await db.run(`UPDATE "ClubBillingMonth" SET status='paid', "paidAt"="closedAt" WHERE id=$1`, [`${P}-m-prev`]);
    await db.run(`UPDATE "Organisation" SET "billingStatus"='subscribed' WHERE id=$1`, [ORG]);
    await db.run(`UPDATE "ClubBilling" SET "graceEndsAt"=NULL,"paymentFailedAt"=NULL WHERE "orgId"=$1`, [ORG]);
  }
});

test("5. /admin/clubs: this month so far, last month, and the totals line", async ({ page }) => {
  const db = testDb();
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [USER.owner]);
  try {
    await signInAs(page, USER.owner, "/admin/clubs");
    const row = page.getByTestId("live-club").filter({ hasText: "Month Sevens" });
    await expect(row.getByTestId("club-billing-summary")).toContainText("Standard, up to £9.99. Paying. Next charge", { timeout: 30_000 });
    // The London day the month ends and "from 10:00" (the close runs then),
    // never the month's 00:00 boundary.
    await expect(row.getByTestId("club-billing-summary")).toContainText(/Next charge \w{3} \d{1,2} \w{3}, from 10:00\./);
    await expect(row.getByTestId("club-billing-summary")).not.toContainText("00:00");
    await expect(row.getByTestId("club-billing-this-month")).toHaveText(/^1 of \d+ so far, £\d+\.\d\d$/);
    await expect(row.getByTestId("club-billing-last-month")).toHaveText("£7.99 paid");
    const totals = page.getByTestId("billing-totals");
    await expect(totals).toContainText("Club fees: 1 with a card. Charged last month: £7.99. This month so far: £");
    await expect(totals).toContainText("Failed or unpaid: 0.");
    await expect(totals).toContainText("Check VAT country: 0.");
    expect(await page.getByTestId("clubs-page").innerText()).not.toMatch(DASH);
  } finally {
    await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [USER.owner]);
  }
});
