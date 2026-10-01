/**
 * Club fee billing, slice B3: the card buttons and the billing webhook,
 * end to end. Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.5,
 * 5.2, 5.3 and 10.2.
 *
 * STRIPE IS THE FAKE ADAPTER (src/lib/stripe-billing-fake.ts): the dev
 * server runs with MT_TEST_MODE=1 and BILLING_STRIPE_FAKE=1, so a Checkout
 * "URL" is the billing page itself with `?fake_checkout=<id>`, and every
 * call is recorded in one JSON file this spec reads. When a test needs
 * Stripe to "hold" a subscription or a saved card, it writes it there,
 * then posts a fixture event SIGNED LOCALLY with the test-only billing
 * secret to /api/stripe/billing-webhook. Nothing reaches Stripe.
 *
 *   1. A PLAYER money collector adds a card: Checkout params, the webhook,
 *      subscribed, the "card added" DM once (a re-delivery is a duplicate).
 *   2. Change card or cancel opens the (fake) Customer Portal.
 *   3. A new collector: Use my card instead (setup mode), the old card
 *      removed and its holder told once; the old (player) holder's page is
 *      gone.
 *   4. The old card holder's Remove my card.
 *   5. invoice.payment_failed and invoice.paid; a bad signature; an event
 *      that is not a club fee.
 *   6. The platform owner's plan changes on the live subscription (Custom
 *      price swap, Free cancels), then Standard with the free month used
 *      up: grace, a fresh week, and the collector asked for a card; a new
 *      Add a card then has no trial.
 *   7. (PR #181 review fix 1) a Checkout that completes after the club was
 *      set Free: cancelled at once and refunded, recorded on /admin/health.
 *   8. (review fix 2) a paused club whose subscription is past due: "Update
 *      card and pay" (setup mode), and the open invoice is retried.
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
async function billingDms() {
  return testDb().all<{ phone: string; text: string; refId: string }>(
    `SELECT phone, text, "refId" FROM "PlatformJob" WHERE purpose='billing' AND "refId" LIKE $1 ORDER BY "createdAt"`,
    [`${ORG}:%`],
  );
}

const subscription = (over: Record<string, unknown> = {}) => ({
  id: "sub_e2e_1",
  status: "trialing",
  customerId: "",
  metadata: { orgId: ORG, purpose: "club-fee", payerUserId: USER.colin },
  cancelAtPeriodEnd: false,
  currentPeriodEnd: TRIAL_ENDS,
  trialEnd: TRIAL_ENDS,
  priceId: "price_e2e_standard",
  itemId: "si_e2e_1",
  card: { paymentMethodId: "pm_e2e_colin", brand: "visa", last4: "4242", country: "GB" },
  ...over,
});

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

test("1. a PLAYER money collector adds a card: Checkout, the webhook, subscribed, one 'card added' DM", async ({ page, request }) => {
  await signInAs(page, USER.colin, `/billing/${ORG}`);
  await expect(page.getByTestId("billing-page")).toHaveAttribute("data-role", "contact", { timeout: 30_000 });
  await page.getByTestId("billing-btn-add-card").click();
  await page.waitForURL(/fake_checkout=cs_fake_/, { timeout: 30_000 });
  const sessionId = new URL(page.url()).searchParams.get("fake_checkout")!;

  // What MatchTime asked Stripe for.
  const customerId = (await billingRow())!.stripeCustomerId as string;
  expect(customerId).toMatch(/^cus_fake_/);
  const params = stripeState().sessions[sessionId].params;
  expect(params).toMatchObject({
    mode: "subscription",
    customer: customerId,
    client_reference_id: ORG,
    line_items: [{ price: "price_e2e_standard", quantity: 1 }],
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    metadata: { orgId: ORG, payerUserId: USER.colin, purpose: "club-fee", action: "add-card" },
  });
  expect(params.subscription_data).toMatchObject({
    default_tax_rates: ["txr_e2e_vat"],
    trial_end: Math.floor(TRIAL_ENDS.getTime() / 1000),
    metadata: { orgId: ORG, purpose: "club-fee", payerUserId: USER.colin },
  });
  expect(JSON.stringify(params)).not.toMatch(/matchId|application_fee|stripeAccount/);

  // Stripe now holds the subscription; it tells us so.
  fake().putSubscription({ ...subscription({ customerId }) } as never);
  const completed = {
    id: sessionId,
    object: "checkout.session",
    mode: "subscription",
    customer: customerId,
    subscription: "sub_e2e_1",
    created: Math.floor(Date.now() / 1000) - 60,
    metadata: params.metadata,
    customer_details: { email: "colin@e2e-test.invalid", name: "Colin Sevens", address: { country: "GB" } },
  };
  const evtId = `evt_e2e_checkout_${Date.now()}`;
  const res = await postEvent(request, "checkout.session.completed", completed, { id: evtId });
  expect(res.status()).toBe(200);
  expect(await status()).toBe("subscribed");
  expect(await billingRow()).toMatchObject({
    stripeSubscriptionId: "sub_e2e_1",
    stripeSubscriptionStatus: "trialing",
    stripePaymentMethodId: "pm_e2e_colin",
    cardBrand: "visa",
    cardLast4: "4242",
    cardHolderUserId: USER.colin,
    billingCountry: "GB",
    cardCountry: "GB",
    vatCountryCheck: false,
  });
  expect((await testDb().one(`SELECT "processedAt" IS NOT NULL AS done FROM "BillingEvent" WHERE id=$1`, [evtId]))).toEqual({ done: true });

  const dms = await billingDms();
  expect(dms).toHaveLength(1);
  expect(dms[0].phone).toBe(PHONE.colin);
  expect(dms[0].text).toContain("Thanks Colin Sevens, your card is saved.");
  expect(dms[0].text).toContain("The first £9.99 is taken on Thu 31 Jan");
  expect(dms[0].text).not.toMatch(DASH);

  // Stripe re-delivers: answered as a duplicate, nothing twice.
  const again = await postEvent(request, "checkout.session.completed", completed, { id: evtId });
  expect(await again.json()).toEqual({ received: true, duplicate: true });
  expect(await billingDms()).toHaveLength(1);

  // Back from Stripe: the notice, then the paid state with the card.
  await page.goto(`/billing/${ORG}?done=1`);
  await expect(page.getByTestId("billing-notice")).toHaveText(
    "Thanks, your card is being saved. This page shows it within a minute.",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("billing-state")).toContainText("£9.99 a month. Next payment Thu 31 Jan.");
  await expect(page.getByTestId("billing-state")).toContainText("Card visa ending 4242.");
  await expect(page.getByTestId("billing-btn-change-card")).toBeVisible();
});

test("2. Change card or cancel opens the Customer Portal, returning to the billing page", async ({ page }) => {
  await signInAs(page, USER.colin, `/billing/${ORG}`);
  await page.getByTestId("billing-btn-change-card").click();
  await page.waitForURL(/fake_portal=1/, { timeout: 30_000 });
  const portal = stripeState().calls.filter((c) => c.method === "createPortalSession").at(-1)!.args as Record<string, unknown>;
  expect(portal).toMatchObject({ returnUrl: `${E2E_BASE_URL}/billing/${ORG}` });
});

test("3. a new collector puts their own card on: setup mode, the old card removed, its holder told once", async ({ page, context, request }) => {
  await testDb().run(`UPDATE "Organisation" SET "paymentHolderId"=$2 WHERE id=$1`, [ORG, USER.pat]);
  await signInAs(page, USER.pat, `/billing/${ORG}`);
  await expect(page.getByTestId("billing-state")).toHaveText(
    "£9.99 a month, paid with Colin Sevens's card until you put yours on. Next payment Thu 31 Jan.",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("billing-page")).not.toContainText("4242");
  await page.getByTestId("billing-btn-use-mine").click();
  await page.waitForURL(/fake_checkout=cs_fake_/, { timeout: 30_000 });
  const sessionId = new URL(page.url()).searchParams.get("fake_checkout")!;
  const params = stripeState().sessions[sessionId].params;
  const customerId = (await billingRow())!.stripeCustomerId;
  expect(params).toMatchObject({
    mode: "setup",
    customer: customerId,
    billing_address_collection: "required",
    metadata: { orgId: ORG, payerUserId: USER.pat, purpose: "club-fee", action: "replace-card" },
  });

  fake().putSetupIntent("seti_e2e_pat", { paymentMethodId: "pm_e2e_pat", brand: "mastercard", last4: "4444", country: "GB" });
  const res = await postEvent(request, "checkout.session.completed", {
    id: sessionId,
    object: "checkout.session",
    mode: "setup",
    customer: customerId,
    setup_intent: "seti_e2e_pat",
    metadata: params.metadata,
    customer_details: { email: "pat@e2e-test.invalid", name: "Pat Sevens", address: { country: "GB" } },
  });
  expect(res.status()).toBe(200);
  expect(await billingRow()).toMatchObject({ cardHolderUserId: USER.pat, stripePaymentMethodId: "pm_e2e_pat", cardLast4: "4444" });
  expect(stripeState().detached).toContain("pm_e2e_colin");
  const replaced = (await billingDms()).filter((d) => d.refId.includes(":card-replaced:"));
  expect(replaced).toHaveLength(1);
  expect(replaced[0]).toMatchObject({
    phone: PHONE.colin,
    text: "Hi Colin Sevens, Pat Sevens now pays the MatchTime fee for Card Sevens. Your card has been removed and won't be charged for it again.",
  });

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
  await expect(page.getByTestId("billing-notice")).toHaveText(
    "Your card has been removed and won't be charged for this club again.",
    { timeout: 30_000 },
  );
  expect(stripeState().detached).toContain("pm_e2e_pat");
  expect(await billingRow()).toMatchObject({ stripePaymentMethodId: null, cardHolderUserId: null, cardLast4: null });
  expect(await status()).toBe("subscribed");
});

test("5. payment failed, then paid; a bad signature and a non club fee event change nothing", async ({ request }) => {
  const customerId = (await billingRow())!.stripeCustomerId as string;
  const invoice = (id: string) => ({
    id,
    object: "invoice",
    customer: customerId,
    billing_reason: "subscription_cycle",
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_e2e_1" } },
  });
  // Pat removed their card in test 4: Stripe's subscription has none on it.
  fake().putSubscription({ ...subscription({ customerId, status: "past_due", trialEnd: null, card: null }) } as never);
  expect((await postEvent(request, "invoice.payment_failed", invoice("in_e2e_1"))).status()).toBe(200);
  expect(await status()).toBe("past_due");
  expect((await billingRow())!.graceEndsAt).not.toBeNull();

  fake().putSubscription({ ...subscription({ customerId, status: "active", trialEnd: null, card: null }) } as never);
  expect((await postEvent(request, "invoice.paid", invoice("in_e2e_1"))).status()).toBe(200);
  expect(await status()).toBe("subscribed");
  expect(await billingRow()).toMatchObject({ graceEndsAt: null, paymentFailedAt: null });

  // Signed with any other secret (e.g. the Connect endpoint's): refused.
  const bad = await postEvent(request, "invoice.payment_failed", invoice("in_e2e_2"), { secret: "whsec_not_the_billing_one" });
  expect(bad.status()).toBe(400);
  // A match fee session reaching this route: recorded, ignored.
  const notOurs = await postEvent(request, "checkout.session.completed", {
    id: "cs_match",
    object: "checkout.session",
    mode: "payment",
    metadata: { matchId: "m1", userId: "u1", quantity: "1" },
  });
  expect(await notOurs.json()).toMatchObject({ received: true, action: "ignored", reason: "not-club-fee" });
  expect(await status()).toBe("subscribed");
});

test("6. the owner's plan on a live subscription; Free then Standard after the free month: grace and a card asked for", async ({ page, request, db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [USER.owner]);
  try {
    await signInAs(page, USER.owner, "/admin/clubs");
    const row = page.getByTestId("live-club").filter({ hasText: "Card Sevens" });

    // Custom GBP 5: the live subscription's price is swapped, no proration.
    await row.getByLabel("Plan", { exact: true }).selectOption("custom");
    await row.getByLabel("Custom price in pounds").fill("5");
    await row.getByRole("button", { name: "Save plan" }).click();
    await expect(page.getByText("Plan saved: Custom £5 a month. The card is charged the new price from the next payment.")).toBeVisible({ timeout: 30_000 });
    const swap = stripeState().calls.filter((c) => c.method === "updateSubscriptionPrice").at(-1)!.args;
    expect(swap).toEqual({ subscriptionId: "sub_e2e_1", itemId: "si_e2e_1", priceId: "price_fake_500" });

    // Free: cancelled at once; the deletion that follows moves nothing.
    page.once("dialog", (d) => d.accept());
    await row.getByLabel("Plan", { exact: true }).selectOption("free");
    await row.getByRole("button", { name: "Save plan" }).click();
    await expect(page.getByText("Plan saved: Free. The club is not billed. Its card subscription was cancelled.")).toBeVisible({ timeout: 30_000 });
    expect(stripeState().calls.filter((c) => c.method === "cancelSubscription").map((c) => c.args)).toEqual([{ subscriptionId: "sub_e2e_1" }]);
    expect(await status()).toBe("exempt");
    const customerId = (await billingRow())!.stripeCustomerId as string;
    fake().putSubscription({ ...subscription({ customerId, status: "canceled", trialEnd: null }) } as never);
    await postEvent(request, "customer.subscription.deleted", { id: "sub_e2e_1", object: "subscription", metadata: { orgId: ORG, purpose: "club-fee" } });
    expect(await status()).toBe("exempt");
    expect((await billingRow())!.stripeSubscriptionStatus).toBe("canceled");

    // The free month is over by now. Standard again: grace, a fresh week, one DM to the collector.
    await db.run(`UPDATE "ClubBilling" SET "trialEndsAt" = now() - interval '20 days' WHERE "orgId"=$1`, [ORG]);
    const dmsBefore = (await billingDms()).length;
    await row.getByLabel("Plan", { exact: true }).selectOption("standard");
    await row.getByRole("button", { name: "Save plan" }).click();
    await expect(
      page.getByText("Plan saved: Standard £9.99 a month. The free month was already used, so the club has 7 days to add a card."),
    ).toBeVisible({ timeout: 30_000 });
    expect(await status()).toBe("grace");
    const grace = await db.one<{ days: number }>(
      `SELECT round(extract(epoch FROM ("graceEndsAt" - now())) / 86400)::int AS days FROM "ClubBilling" WHERE "orgId"=$1`,
      [ORG],
    );
    expect(grace?.days).toBe(7);
    const dms = await billingDms();
    expect(dms).toHaveLength(dmsBefore + 1);
    expect(dms.at(-1)!.phone).toBe(PHONE.colin);
    expect(dms.at(-1)!.text).toContain("Card Sevens is on the MatchTime plan again at £9.99 a month.");
    expect(dms.at(-1)!.text).not.toMatch(DASH);
  } finally {
    await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [USER.owner]);
  }

  // In grace, a new Add a card takes the first payment at once: no trial.
  await page.context().clearCookies();
  await signInAs(page, USER.colin, `/billing/${ORG}`);
  await page.getByTestId("billing-btn-add-card").click();
  await page.waitForURL(/fake_checkout=cs_fake_/, { timeout: 30_000 });
  const sessionId = new URL(page.url()).searchParams.get("fake_checkout")!;
  const params = stripeState().sessions[sessionId].params;
  expect(params.subscription_data).not.toHaveProperty("trial_end");
  expect(params.line_items).toEqual([{ price: "price_e2e_standard", quantity: 1 }]);
  // The same club Customer, never a second one.
  expect(params.customer).toBe((await billingRow())!.stripeCustomerId);
  expect(stripeState().calls.filter((c) => c.method === "createCustomer")).toHaveLength(1);
});

test("7. a Checkout completing after the club was set Free is cancelled at once and refunded (review fix 1)", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "billingStatus"='exempt', "billingPlan"='free', "billingPricePence"=NULL WHERE id=$1`, [ORG]);
  // What setClubPlan records with Free: WHEN the club stopped being billed.
  // Only a payment made after this is refunded (round-2 review N1).
  await db.run(
    `INSERT INTO "BillingEvent" (id,type,"orgId","receivedAt","processedAt") VALUES ('mt_exempt_e2e_late','mt.club-exempt',$1,$2,$2)`,
    [ORG, new Date(Date.now() - 60_000).toISOString()],
  );
  const customerId = (await billingRow())!.stripeCustomerId as string;
  fake().putSubscription({ ...subscription({ id: "sub_e2e_late", customerId, status: "active", trialEnd: null }) } as never);
  fake().putPaidInvoice("sub_e2e_late", 999);
  const res = await postEvent(request, "checkout.session.completed", {
    id: "cs_e2e_late",
    object: "checkout.session",
    mode: "subscription",
    customer: customerId,
    subscription: "sub_e2e_late",
    metadata: { orgId: ORG, payerUserId: USER.colin, purpose: "club-fee", action: "add-card" },
    customer_details: { address: { country: "GB" } },
  });
  expect(await res.json()).toMatchObject({ received: true, action: "unwanted-cancelled" });
  expect(stripeState().calls.filter((c) => c.method === "cancelSubscription").map((c) => c.args)).toContainEqual({ subscriptionId: "sub_e2e_late" });
  expect(stripeState().refunds).toContainEqual(expect.objectContaining({ subscriptionId: "sub_e2e_late", pence: 999 }));
  // CANCELLED before it was refunded (slice B4, changing round-2 review
  // N2's order): a refund that keeps failing can never leave it charging.
  const order = stripeState().calls.map((c) => `${c.method}:${(c.args as { subscriptionId?: string }).subscriptionId ?? ""}`);
  expect(order.indexOf("cancelSubscription:sub_e2e_late")).toBeGreaterThan(-1);
  expect(order.indexOf("cancelSubscription:sub_e2e_late")).toBeLessThan(order.indexOf("refundPaidInvoices:sub_e2e_late"));
  expect(await status()).toBe("exempt");
  expect((await billingRow())!.stripeSubscriptionId).not.toBe("sub_e2e_late");
  expect(await db.count(`SELECT COUNT(*) FROM "OpsAlert" WHERE "orgId"=$1 AND kind='club-billing'`, [ORG])).toBe(1);
});

test("8. a paused club with a past due subscription: Update card and pay, then the invoice is retried (review fix 2)", async ({ page, request, db }) => {
  await db.run(`UPDATE "Organisation" SET "billingPlan"='standard', "billingStatus"='paused' WHERE id=$1`, [ORG]);
  await db.run(
    `UPDATE "ClubBilling" SET "stripeSubscriptionId"='sub_e2e_due', "stripeSubscriptionStatus"='past_due', "cardHolderUserId"=$2,
       "stripePaymentMethodId"='pm_e2e_declined', "pausedReason"='payment-failed', "pausedAt"=now() WHERE "orgId"=$1`,
    [ORG, USER.colin],
  );
  const customerId = (await billingRow())!.stripeCustomerId as string;
  fake().putSubscription({ ...subscription({ id: "sub_e2e_due", customerId, status: "past_due", trialEnd: null }) } as never);

  await page.context().clearCookies();
  await signInAs(page, USER.colin, `/billing/${ORG}`);
  const pay = page.getByTestId("billing-btn-update-card");
  await expect(pay).toHaveText("Update card and pay", { timeout: 30_000 });
  await expect(page.getByTestId("billing-btn-add-card")).toHaveCount(0);
  await pay.click();
  await page.waitForURL(/fake_checkout=cs_fake_/, { timeout: 30_000 });
  const sessionId = new URL(page.url()).searchParams.get("fake_checkout")!;
  const params = stripeState().sessions[sessionId].params;
  expect(params).toMatchObject({ mode: "setup", customer: customerId, metadata: { action: "replace-card", payerUserId: USER.colin } });

  fake().putSetupIntent("seti_e2e_pay", { paymentMethodId: "pm_e2e_good", brand: "visa", last4: "1111", country: "GB" });
  const res = await postEvent(request, "checkout.session.completed", {
    id: sessionId,
    object: "checkout.session",
    mode: "setup",
    customer: customerId,
    setup_intent: "seti_e2e_pay",
    metadata: params.metadata,
    customer_details: { email: "colin@e2e-test.invalid", name: "Colin Sevens", address: { country: "GB" } },
  });
  expect(res.status()).toBe(200);
  expect(stripeState().calls.filter((c) => c.method === "payOpenInvoices").map((c) => c.args)).toContainEqual({ subscriptionId: "sub_e2e_due" });
  expect(await billingRow()).toMatchObject({ stripePaymentMethodId: "pm_e2e_good", cardHolderUserId: USER.colin });
  expect(stripeState().detached).toContain("pm_e2e_declined");
});
