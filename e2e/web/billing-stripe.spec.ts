/**
 * Club fee billing, slices B3 and P2 (games played): the card buttons and
 * the billing webhook, end to end. Plan:
 * MDs/club-fee-billing-plan-2026-10-01.md, sections 4.2, 4.5, 5.3, 5.4,
 * 10.2.
 *
 * STRIPE IS THE FAKE ADAPTER (src/lib/stripe-billing-fake.ts): the dev
 * server runs with MT_TEST_MODE=1 and BILLING_STRIPE_FAKE=1, so a Checkout
 * "URL" is the billing page itself with `?fake_checkout=<id>`, and every
 * call is recorded in one JSON file this spec reads. When a test needs
 * Stripe to "hold" a saved card or a month's invoice, it writes it there,
 * then posts a fixture event SIGNED LOCALLY with the test-only billing
 * secret to /api/stripe/billing-webhook. Nothing reaches Stripe.
 *
 * The month close itself (count, fee, invoice) is driven by the hourly
 * cron in slice P3; its unit tests are club-billing-months.test.ts. Here a
 * month's invoice is seeded as the close leaves it.
 *
 *   1. A PLAYER money collector adds a card: setup mode, the webhook,
 *      subscribed, NOTHING charged, the "card added" DM once.
 *   2. Stop paying inside the free month: the card is removed, back in the
 *      free month; a card added again.
 *   3. A new collector: Use my card instead (setup mode), the old card
 *      removed and its holder told once; the old (player) holder's page
 *      is gone.
 *   4. The old card holder's Remove my card.
 *   5. A month's invoice fails: past due, "Update card and pay" (setup
 *      mode) pays it on the new card, invoice.paid: subscribed, the month
 *      paid. A bad signature and events that are not ours change nothing.
 *   6. Stop paying after the free month: billing ends with the current
 *      month; Keep paying undoes it.
 *   7. The owner sets Free with an unpaid invoice: voided, the open months
 *      waived; a card saved afterwards is removed at once.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Stripe from "stripe";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb, signInAs } from "../fixtures";
import { E2E, E2E_BASE_URL } from "../helpers/env";
import { testDb } from "../helpers/test-db";
// Static import: Playwright rewrites the "@/" alias only for static imports.
import { createFakeBillingStripe, type FakeStripeState } from "@/lib/stripe-billing-fake";

test.describe.configure({ mode: "serial" });

const P = "e2e-bill3";
const ORG = `${P}-club`;
const USER = {
  owner: `${P}-owner`,
  colin: `${P}-colin`,
  pat: `${P}-pat`,
} as const;
const PHONE = { colin: "447700901103", pat: "447700901104" } as const;
const TRIAL_ENDS = new Date("2030-01-31T12:00:00Z");
const DASH = /[—–]/;

const fake = () => createFakeBillingStripe({ file: E2E.BILLING_STRIPE_FILE });
const signer = new Stripe("sk_test_signing_only_never_used");
let seq = 0;

function stripeState(): FakeStripeState {
  return JSON.parse(readFileSync(E2E.BILLING_STRIPE_FILE, "utf8")) as FakeStripeState;
}

/** Post one fixture event, signed with the given secret (default: the billing one). */
async function postEvent(
  request: APIRequestContext,
  type: string,
  object: Record<string, unknown>,
  opts: { id?: string; secret?: string } = {},
) {
  const payload = JSON.stringify({
    id: opts.id ?? `evt_e2e_${Date.now()}_${++seq}`,
    object: "event",
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? E2E.BILLING_WEBHOOK_SECRET });
  return request.post(`${E2E_BASE_URL}/api/stripe/billing-webhook`, {
    headers: { "stripe-signature": sig, "content-type": "application/json" },
    data: payload,
  });
}

async function billingRow() {
  return testDb().one<Record<string, unknown>>(`SELECT * FROM "ClubBilling" WHERE "orgId"=$1`, [ORG]);
}
async function status() {
  return (await testDb().one<{ billingStatus: string }>(`SELECT "billingStatus" FROM "Organisation" WHERE id=$1`, [ORG]))?.billingStatus;
}
/**
 * Slice B4: billing DMs go out 10:00 to 20:00 London only. At night the
 * webhook and the admin actions leave them PENDING, and the hourly billing
 * cron's daytime run re-checks and sends them. So when this suite runs at
 * night, the cron is run once at the next 10:30 London (test clock) before
 * the DMs are read; in the daytime nothing is held and nothing is run.
 */
async function flushNightDms() {
  const londonHour = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: "Europe/London" }).format(d));
  let at = new Date();
  if (londonHour(at) >= 10 && londonHour(at) < 20) return;
  while (londonHour(at) !== 10) at = new Date(at.getTime() + 30 * 60 * 1000);
  const res = await fetch(`${E2E_BASE_URL}/api/cron/billing`, {
    headers: { authorization: `Bearer ${E2E.CRON_SECRET}`, "x-test-now": at.toISOString() },
  });
  expect(res.status).toBe(200);
}
async function billingDms() {
  await flushNightDms();
  return testDb().all<{ phone: string; text: string; refId: string }>(
    `SELECT phone, text, "refId" FROM "PlatformJob" WHERE purpose='billing' AND "refId" LIKE $1 ORDER BY "createdAt"`,
    [`${ORG}:%`],
  );
}

/** Complete a setup-mode session as Stripe would: the SetupIntent holds the card. */
async function completeSetup(
  request: APIRequestContext,
  sessionId: string,
  card: { pm: string; brand: string; last4: string },
  who: { email: string; name: string },
  id?: string,
) {
  const params = stripeState().sessions[sessionId].params;
  fake().putSetupIntent(`seti_${sessionId}`, { paymentMethodId: card.pm, brand: card.brand, last4: card.last4, country: "GB" });
  return postEvent(
    request,
    "checkout.session.completed",
    {
      id: sessionId,
      object: "checkout.session",
      mode: "setup",
      customer: params.customer,
      setup_intent: `seti_${sessionId}`,
      created: Math.floor(Date.now() / 1000) - 60,
      metadata: params.metadata,
      customer_details: { email: who.email, name: who.name, address: { country: "GB", line1: "1 Pitch Lane" } },
    },
    id ? { id } : {},
  );
}

/** Money Stripe was asked to move: invoices made, finalised or paid. */
const moneyCalls = () => stripeState().calls.filter((c) => /MonthInvoice|finalizeInvoice|payInvoice/.test(c.method));

test.beforeAll(async () => {
  resetDb();
  // A clean fake Stripe world for this file.
  mkdirSync(path.dirname(E2E.BILLING_STRIPE_FILE), { recursive: true });
  writeFileSync(E2E.BILLING_STRIPE_FILE, "{}");

  const db = testDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"approvedAt","approvalDecidedAt","billingStatus","createdAt","updatedAt")
     VALUES ($1,'Card Sevens',$1,$2,'approved','en',now() - interval '5 days',now() - interval '5 days','trial',now(),now())`,
    [ORG, `${ORG}-invite`],
  );
  await db.run(
    `INSERT INTO "ClubBilling" ("orgId","trialStartedAt","trialEndsAt","updatedAt") VALUES ($1,'2030-01-01T12:00:00Z',$2,now())`,
    [ORG, TRIAL_ENDS.toISOString()],
  );
  for (const [id, name, phone] of [
    [USER.owner, "Oona Owner", "+447700901101"],
    [USER.colin, "Colin Sevens", `+${PHONE.colin}`],
    [USER.pat, "Pat Sevens", `+${PHONE.pat}`],
  ]) {
    await db.run(
      `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,$2,$3,$4,true,true,now())`,
      [id, name, `${id}@e2e-test.invalid`, phone],
    );
  }
  for (const [userId, role] of [
    [USER.owner, "OWNER"],
    [USER.colin, "PLAYER"],
    [USER.pat, "PLAYER"],
  ]) {
    await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,$4)`, [`${userId}-m`, userId, ORG, role]);
  }
  await db.run(`UPDATE "Organisation" SET "paymentHolderId"=$2 WHERE id=$1`, [ORG, USER.colin]);
});

test.afterAll(() => {
  resetDb();
});

test("1. a PLAYER money collector adds a card: setup mode, the webhook, subscribed, NOTHING charged, one 'card added' DM", async ({ page, request }) => {
  await signInAs(page, USER.colin, `/billing/${ORG}`);
  await expect(page.getByTestId("billing-page")).toHaveAttribute("data-role", "contact", { timeout: 30_000 });
  await page.getByTestId("billing-btn-add-card").click();
  await page.waitForURL(/fake_checkout=cs_fake_/, { timeout: 30_000 });
  const sessionId = new URL(page.url()).searchParams.get("fake_checkout")!;

  // What MatchTime asked Stripe for: SETUP mode on the club's Customer.
  const customerId = (await billingRow())!.stripeCustomerId as string;
  expect(customerId).toMatch(/^cus_fake_/);
  const params = stripeState().sessions[sessionId].params;
  expect(params).toMatchObject({
    mode: "setup",
    customer: customerId,
    client_reference_id: ORG,
    currency: "gbp",
    billing_address_collection: "required",
    metadata: { orgId: ORG, payerUserId: USER.colin, purpose: "club-fee", action: "add-card" },
    setup_intent_data: { metadata: { orgId: ORG, payerUserId: USER.colin, purpose: "club-fee", action: "add-card" } },
  });
  expect(params).not.toHaveProperty("line_items");
  expect(params).not.toHaveProperty("subscription_data");
  expect(JSON.stringify(params)).not.toMatch(/matchId|application_fee|stripeAccount/);

  const evtId = `evt_e2e_card_${Date.now()}`;
  const res = await completeSetup(request, sessionId, { pm: "pm_e2e_colin", brand: "visa", last4: "4242" }, { email: "colin@e2e-test.invalid", name: "Colin Sevens" }, evtId);
  expect(res.status()).toBe(200);
  expect(await status()).toBe("subscribed");
  expect(await billingRow()).toMatchObject({
    stripePaymentMethodId: "pm_e2e_colin",
    cardBrand: "visa",
    cardLast4: "4242",
    cardHolderUserId: USER.colin,
    billingCountry: "GB",
    cardCountry: "GB",
    vatCountryCheck: false,
  });
  expect(stripeState().customers[customerId].defaultPaymentMethod).toBe("pm_e2e_colin");
  // Saving a card charges NOTHING: no invoice, no payment.
  expect(moneyCalls()).toEqual([]);
  expect(await testDb().one(`SELECT "processedAt" IS NOT NULL AS done FROM "BillingEvent" WHERE id=$1`, [evtId])).toEqual({ done: true });

  const dms = await billingDms();
  expect(dms).toHaveLength(1);
  expect(dms[0].phone).toBe(PHONE.colin);
  expect(dms[0].text).toContain("Thanks Colin Sevens, your card is saved.");
  expect(dms[0].text).not.toMatch(/taken today/);
  expect(dms[0].text).not.toMatch(DASH);

  // Stripe re-delivers: answered as a duplicate, nothing twice.
  const again = await completeSetup(request, sessionId, { pm: "pm_e2e_colin", brand: "visa", last4: "4242" }, { email: "colin@e2e-test.invalid", name: "Colin Sevens" }, evtId);
  expect(await again.json()).toEqual({ received: true, duplicate: true });
  expect(await billingDms()).toHaveLength(1);

  // Back from Stripe: the notice, the card, Change card and Stop paying.
  await page.goto(`/billing/${ORG}?done=1`);
  await expect(page.getByTestId("billing-notice")).toHaveText("Thanks, your card is being saved. This page shows it within a minute.", { timeout: 30_000 });
  await expect(page.getByTestId("billing-state")).toContainText("Card visa ending 4242.");
  await expect(page.getByTestId("billing-btn-change-card")).toHaveText("Change card");
  await expect(page.getByTestId("billing-btn-stop-paying")).toHaveText("Stop paying");
});

test("2. Stop paying inside the free month: the card is removed, back in the free month; a card added again", async ({ page, request }) => {
  await signInAs(page, USER.colin, `/billing/${ORG}`);
  await page.getByTestId("billing-btn-stop-paying").click();
  await expect(page.getByTestId("billing-notice")).toHaveText(
    "Done. Your card has been removed and nothing has been charged. The free month carries on until it ends.",
    { timeout: 30_000 },
  );
  expect(stripeState().detached).toContain("pm_e2e_colin");
  expect(await status()).toBe("trial");
  expect(await billingRow()).toMatchObject({ stripePaymentMethodId: null, cardHolderUserId: null, trialEndsAt: TRIAL_ENDS });
  expect(moneyCalls()).toEqual([]);

  await page.getByTestId("billing-btn-add-card").click();
  await page.waitForURL(/fake_checkout=cs_fake_/, { timeout: 30_000 });
  const sessionId = new URL(page.url()).searchParams.get("fake_checkout")!;
  expect((await completeSetup(request, sessionId, { pm: "pm_e2e_colin2", brand: "visa", last4: "4242" }, { email: "colin@e2e-test.invalid", name: "Colin Sevens" })).status()).toBe(200);
  expect(await status()).toBe("subscribed");
  expect((await billingRow())!.stripePaymentMethodId).toBe("pm_e2e_colin2");
  // The same club Customer, never a second one.
  expect(stripeState().calls.filter((c) => c.method === "createCustomer")).toHaveLength(1);
});

test("3. a new collector puts their own card on: setup mode, the old card removed, its holder told once", async ({ page, context, request }) => {
  await testDb().run(`UPDATE "Organisation" SET "paymentHolderId"=$2 WHERE id=$1`, [ORG, USER.pat]);
  await signInAs(page, USER.pat, `/billing/${ORG}`);
  await expect(page.getByTestId("billing-state")).toContainText("paid with Colin Sevens's card until you put yours on", { timeout: 30_000 });
  await expect(page.getByTestId("billing-page")).not.toContainText("4242");
  await page.getByTestId("billing-btn-use-mine").click();
  await page.waitForURL(/fake_checkout=cs_fake_/, { timeout: 30_000 });
  const sessionId = new URL(page.url()).searchParams.get("fake_checkout")!;
  const customerId = (await billingRow())!.stripeCustomerId;
  expect(stripeState().sessions[sessionId].params).toMatchObject({
    mode: "setup",
    customer: customerId,
    billing_address_collection: "required",
    metadata: { orgId: ORG, payerUserId: USER.pat, purpose: "club-fee", action: "replace-card" },
  });

  const res = await completeSetup(request, sessionId, { pm: "pm_e2e_pat", brand: "mastercard", last4: "4444" }, { email: "pat@e2e-test.invalid", name: "Pat Sevens" });
  expect(res.status()).toBe(200);
  expect(await billingRow()).toMatchObject({ cardHolderUserId: USER.pat, stripePaymentMethodId: "pm_e2e_pat", cardLast4: "4444" });
  expect(stripeState().detached).toContain("pm_e2e_colin2");
  expect(stripeState().calls.map((c) => c.method)).toContain("resetCustomerDetails");
  const replaced = (await billingDms()).filter((d) => d.refId.includes(":card-replaced:"));
  expect(replaced).toHaveLength(1);
  expect(replaced[0]).toMatchObject({
    phone: PHONE.colin,
    text: "Hi Colin Sevens, Pat Sevens now pays the MatchTime fee for Card Sevens. Your card has been removed and won't be charged for it again.",
  });
  expect(moneyCalls()).toEqual([]);

  await page.goto(`/billing/${ORG}`);
  await expect(page.getByTestId("billing-state")).toContainText("Card mastercard ending 4444.", { timeout: 30_000 });
  await expect(page.getByTestId("billing-btn-change-card")).toBeVisible();

  // Colin, a player with no card on file any more, has nothing to manage.
  await context.clearCookies();
  await signInAs(page, USER.colin, "/");
  expect((await page.goto(`/billing/${ORG}`))?.status()).toBe(404);
});

test("4. the old card holder removes their card", async ({ page }) => {
  // Colin collects again; Pat's card still pays, so Pat is the old card holder.
  await testDb().run(`UPDATE "Organisation" SET "paymentHolderId"=$2 WHERE id=$1`, [ORG, USER.colin]);
  await signInAs(page, USER.pat, `/billing/${ORG}`);
  await expect(page.getByTestId("billing-page")).toHaveAttribute("data-role", "card-holder", { timeout: 30_000 });
  await page.getByTestId("billing-btn-remove-mine").click();
  await expect(page.getByTestId("billing-notice")).toHaveText("Your card has been removed and won't be charged for this club again.", { timeout: 30_000 });
  expect(stripeState().detached).toContain("pm_e2e_pat");
  expect(await billingRow()).toMatchObject({ stripePaymentMethodId: null, cardHolderUserId: null, cardLast4: null });
  expect(await status()).toBe("subscribed");
});

/** A month's invoice as the close leaves it: finalised, open, on the club's Customer. */
async function seedInvoicedMonth(monthId: string, index: number, pence: number, monthStatus = "invoiced") {
  const customerId = (await billingRow())!.stripeCustomerId as string;
  const args = { orgId: ORG, monthId, customerId, description: `MatchTime club fee, Card Sevens: e2e month ${index}` };
  const inv = await fake().createMonthInvoice(args);
  await fake().addMonthInvoiceItem({ ...args, invoiceId: inv.id, amountPence: pence, productId: "prod_e2e_club", taxRateId: "txr_e2e_vat" });
  await fake().finalizeInvoice(inv.id);
  await testDb().run(
    `INSERT INTO "ClubBillingMonth" (id,"orgId",index,"startsAt","endsAt","priceAtStartPence",status,scheduled,played,"pricePence","amountPence","stripeInvoiceId","closedAt","updatedAt")
     VALUES ($1,$2,$3,now() - interval '40 days',now() - interval '10 days',999,$4,5,4,999,$5,$6,now(),now())`,
    [monthId, ORG, index, monthStatus, pence, inv.id],
  );
  return { invoiceId: inv.id, customerId };
}
async function monthRow(id: string) {
  return testDb().one<Record<string, unknown>>(`SELECT * FROM "ClubBillingMonth" WHERE id=$1`, [id]);
}
const invoiceObject = (id: string, monthId: string, customerId: string) => ({
  id,
  object: "invoice",
  customer: customerId,
  metadata: { orgId: ORG, purpose: "club-fee", monthId },
});

test("5. a month's invoice fails: past due, Update card and pay, then paid: subscribed; foreign events change nothing", async ({ page, request }) => {
  // The free month is over: the club is in its billing months.
  await testDb().run(`UPDATE "ClubBilling" SET "trialEndsAt" = now() - interval '45 days' WHERE "orgId"=$1`, [ORG]);
  const { invoiceId, customerId } = await seedInvoicedMonth("cbm_e2e_1", 1, 799);

  // Pat removed their card in test 4: Stripe's attempt fails.
  expect((await postEvent(request, "invoice.payment_failed", invoiceObject(invoiceId, "cbm_e2e_1", customerId))).status()).toBe(200);
  expect(await status()).toBe("past_due");
  expect((await billingRow())!.graceEndsAt).not.toBeNull();
  expect((await monthRow("cbm_e2e_1"))!.status).toBe("failed");

  await page.context().clearCookies();
  await signInAs(page, USER.colin, `/billing/${ORG}`);
  const pay = page.getByTestId("billing-btn-update-card");
  await expect(pay).toHaveText("Update card and pay", { timeout: 30_000 });
  await expect(page.getByTestId("billing-btn-stop-paying")).toHaveCount(0);
  await pay.click();
  await page.waitForURL(/fake_checkout=cs_fake_/, { timeout: 30_000 });
  const sessionId = new URL(page.url()).searchParams.get("fake_checkout")!;
  expect(stripeState().sessions[sessionId].params).toMatchObject({ mode: "setup", customer: customerId, metadata: { action: "replace-card", payerUserId: USER.colin } });

  const res = await completeSetup(request, sessionId, { pm: "pm_e2e_good", brand: "visa", last4: "1111" }, { email: "colin@e2e-test.invalid", name: "Colin Sevens" });
  expect(res.status()).toBe(200);
  // The unpaid month's invoice is paid on the NEW card at once.
  expect(stripeState().calls.filter((c) => c.method === "payInvoice").map((c) => c.args)).toEqual([{ invoiceId, paymentMethodId: "pm_e2e_good" }]);
  expect((await fake().retrieveInvoice(invoiceId))!.status).toBe("paid");
  // Still past due until Stripe says the invoice is paid.
  expect(await status()).toBe("past_due");

  const paidEvt = `evt_e2e_paid_${Date.now()}`;
  expect((await postEvent(request, "invoice.paid", invoiceObject(invoiceId, "cbm_e2e_1", customerId), { id: paidEvt })).status()).toBe(200);
  expect(await status()).toBe("subscribed");
  expect(await billingRow()).toMatchObject({ graceEndsAt: null, paymentFailedAt: null, stripePaymentMethodId: "pm_e2e_good" });
  expect(await monthRow("cbm_e2e_1")).toMatchObject({ status: "paid", stripeInvoiceId: invoiceId, amountPence: 799 });
  // Re-delivered: a duplicate.
  expect(await (await postEvent(request, "invoice.paid", invoiceObject(invoiceId, "cbm_e2e_1", customerId), { id: paidEvt })).json()).toEqual({
    received: true,
    duplicate: true,
  });
  // A stale 'payment_failed' for the same invoice now: applied as paid (fresh read), never past due again.
  await postEvent(request, "invoice.payment_failed", invoiceObject(invoiceId, "cbm_e2e_1", customerId));
  expect(await status()).toBe("subscribed");
  expect((await monthRow("cbm_e2e_1"))!.status).toBe("paid");

  // Signed with any other secret (e.g. the Connect endpoint's): refused.
  const bad = await postEvent(request, "invoice.payment_failed", invoiceObject(invoiceId, "cbm_e2e_1", customerId), { secret: "whsec_not_the_billing_one" });
  expect(bad.status()).toBe(400);
  // A match fee session reaching this route: recorded, ignored.
  const notOurs = await postEvent(request, "checkout.session.completed", {
    id: "cs_match",
    object: "checkout.session",
    mode: "payment",
    metadata: { matchId: "m1", userId: "u1", quantity: "1" },
  });
  expect(await notOurs.json()).toMatchObject({ received: true, action: "ignored", reason: "not-club-fee" });
  // A subscription event (none exist any more): answered and ignored.
  const sub = await postEvent(request, "customer.subscription.updated", { id: "sub_old", object: "subscription", metadata: { orgId: ORG, purpose: "club-fee" } });
  expect(await sub.json()).toMatchObject({ received: true, action: "ignored", reason: "subscription-retired" });
  expect(await status()).toBe("subscribed");
});

test("6. Stop paying after the free month: billing ends with the current month; Keep paying undoes it", async ({ page }) => {
  await signInAs(page, USER.colin, `/billing/${ORG}`);
  await page.getByTestId("billing-btn-stop-paying").click();
  await expect(page.getByTestId("billing-notice")).toHaveText(
    "Done. Billing ends when this month ends: this month is charged for its games as usual, then nothing more. MatchTime keeps running until then.",
    { timeout: 30_000 },
  );
  const row = (await billingRow())!;
  expect(row.cancelAtPeriodEnd).toBe(true);
  // The current month is open, and its end is the stop date.
  expect((row.currentPeriodEnd as Date).getTime()).toBeGreaterThan(Date.now());
  expect(await status()).toBe("subscribed");
  expect((await billingRow())!.stripePaymentMethodId).toBe("pm_e2e_good");
  await expect(page.getByTestId("billing-btn-keep-paying")).toHaveText("Keep paying");

  await page.getByTestId("billing-btn-keep-paying").click();
  await expect(page.getByTestId("billing-notice")).toHaveText("Done. MatchTime keeps running, and each month is charged only for the games played.", { timeout: 30_000 });
  expect((await billingRow())!.cancelAtPeriodEnd).toBe(false);
  await expect(page.getByTestId("billing-btn-stop-paying")).toBeVisible();
});

test("7. the owner sets Free with an unpaid invoice: voided, open months waived; a card saved afterwards is removed", async ({ page, request, db }) => {
  const { invoiceId, customerId } = await seedInvoicedMonth("cbm_e2e_unpaid", 90, 499, "failed");
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [USER.owner]);
  try {
    await signInAs(page, USER.owner, "/admin/clubs");
    const row = page.getByTestId("live-club").filter({ hasText: "Card Sevens" });
    page.once("dialog", (d) => d.accept());
    await row.getByLabel("Plan", { exact: true }).selectOption("free");
    await row.getByRole("button", { name: "Save plan" }).click();
    await expect(page.getByText(/Plan saved: Free\. The club is not billed\..* 1 unpaid invoice\(s\) cancelled\./)).toBeVisible({ timeout: 30_000 });
  } finally {
    await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [USER.owner]);
  }
  expect(await status()).toBe("exempt");
  expect((await fake().retrieveInvoice(invoiceId))!.status).toBe("void");
  expect(await monthRow("cbm_e2e_unpaid")).toMatchObject({ status: "void", reason: "free-plan" });
  expect(await db.count(`SELECT COUNT(*) FROM "ClubBillingMonth" WHERE "orgId"=$1 AND status='open'`, [ORG])).toBe(0);
  // Nothing was ever charged by the Free change.
  expect(stripeState().calls.filter((c) => c.method === "payInvoice" && (c.args as { invoiceId: string }).invoiceId === invoiceId)).toHaveLength(0);

  // A card session that completes after the club was set Free: the card is removed at once.
  fake().putSetupIntent("seti_e2e_late", { paymentMethodId: "pm_e2e_late", brand: "visa", last4: "9999", country: "GB" });
  const late = await postEvent(request, "checkout.session.completed", {
    id: "cs_e2e_late",
    object: "checkout.session",
    mode: "setup",
    customer: customerId,
    setup_intent: "seti_e2e_late",
    metadata: { orgId: ORG, payerUserId: USER.colin, purpose: "club-fee", action: "add-card" },
    customer_details: { address: { country: "GB" } },
  });
  expect(await late.json()).toMatchObject({ received: true, action: "ignored", reason: "not-billable" });
  expect(stripeState().detached).toContain("pm_e2e_late");
  expect(await status()).toBe("exempt");
});
