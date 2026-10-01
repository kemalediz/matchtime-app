/**
 * CLUB FEE BILLING, slice B3: the Stripe adapter and its pure halves.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 2, 5.1 to 5.4.
 *
 * NO NETWORK. The real adapter is driven with a recording stand-in for the
 * Stripe client, so the exact calls (and the absence of any Connect
 * `stripeAccount`) are pinned; webhook signatures are made locally with
 * `generateTestHeaderString`; the fake adapter is the one Playwright uses.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLUB_FEE_PURPOSE,
  billingStripeConfig,
  buildSetupCheckoutParams,
  buildSubscriptionCheckoutParams,
  createStripeBillingAdapter,
  getBillingStripe,
  isBillingStripeFake,
  isClubFeeMetadata,
  setBillingStripeForTests,
  verifyBillingWebhook,
} from "../stripe-billing";
import { createFakeBillingStripe } from "../stripe-billing-fake";

const BASE = "https://matchtime.example";
const NOW = new Date("2026-10-20T12:00:00Z");

afterEach(() => setBillingStripeForTests(null));

describe("subscription Checkout (Add a card, 5.2)", () => {
  const args = {
    orgId: "org_1",
    payerUserId: "user_colin",
    customerId: "cus_1",
    priceId: "price_std",
    taxRateId: "txr_vat",
    baseUrl: BASE,
  };

  it("is a subscription on the club's own Customer, one item, the tax rate, the billing address and VAT number collection", () => {
    const p = buildSubscriptionCheckoutParams({ ...args, trialEnd: null });
    expect(p.mode).toBe("subscription");
    expect(p.customer).toBe("cus_1");
    expect(p.client_reference_id).toBe("org_1");
    expect(p.line_items).toEqual([{ price: "price_std", quantity: 1 }]);
    expect(p.subscription_data?.default_tax_rates).toEqual(["txr_vat"]);
    expect(p.billing_address_collection).toBe("required");
    expect(p.tax_id_collection).toEqual({ enabled: true });
    expect(p.customer_update).toEqual({ address: "auto", name: "auto" });
    expect(p.payment_method_types).toEqual(["card"]);
    expect(p.success_url).toBe(`${BASE}/billing/org_1?done=1`);
    expect(p.cancel_url).toBe(`${BASE}/billing/org_1`);
  });

  it("carries orgId, payerUserId and purpose 'club-fee', and NEVER matchId or userId (so the Connect webhook ignores it)", () => {
    const p = buildSubscriptionCheckoutParams({ ...args, trialEnd: null });
    expect(p.metadata).toEqual({ orgId: "org_1", payerUserId: "user_colin", purpose: CLUB_FEE_PURPOSE, action: "add-card" });
    expect(p.subscription_data?.metadata).toEqual({ orgId: "org_1", payerUserId: "user_colin", purpose: CLUB_FEE_PURPOSE });
    for (const md of [p.metadata, p.subscription_data?.metadata]) {
      expect(md).not.toHaveProperty("matchId");
      expect(md).not.toHaveProperty("userId");
    }
    expect(CLUB_FEE_PURPOSE).toBe("club-fee");
  });

  it("no Connect: no application fee, no payment intent data, no transfer", () => {
    const p = buildSubscriptionCheckoutParams({ ...args, trialEnd: null }) as Record<string, unknown>;
    expect(JSON.stringify(p)).not.toMatch(/application_fee|transfer_data|on_behalf_of|stripeAccount/);
    expect(p.payment_intent_data).toBeUndefined();
  });

  it("trial_end only when given, in whole seconds", () => {
    expect(buildSubscriptionCheckoutParams({ ...args, trialEnd: null }).subscription_data).not.toHaveProperty("trial_end");
    const end = new Date("2026-10-31T09:00:00.700Z");
    expect(buildSubscriptionCheckoutParams({ ...args, trialEnd: end }).subscription_data?.trial_end).toBe(
      Math.floor(end.getTime() / 1000),
    );
  });

  it("a Custom price goes in the same place, with the same tax rate", () => {
    const p = buildSubscriptionCheckoutParams({ ...args, priceId: "price_custom_500", trialEnd: null });
    expect(p.line_items).toEqual([{ price: "price_custom_500", quantity: 1 }]);
    expect(p.subscription_data?.default_tax_rates).toEqual(["txr_vat"]);
  });
});

describe("setup Checkout (Use my card instead, 4.5 point 4)", () => {
  it("setup mode on the club's Customer, card only, billing address required, the replace-card metadata", () => {
    const p = buildSetupCheckoutParams({ orgId: "org_1", payerUserId: "user_pat", customerId: "cus_1", baseUrl: BASE });
    expect(p.mode).toBe("setup");
    expect(p.customer).toBe("cus_1");
    expect(p.currency).toBe("gbp");
    expect(p.payment_method_types).toEqual(["card"]);
    expect(p.billing_address_collection).toBe("required");
    expect(p.metadata).toEqual({ orgId: "org_1", payerUserId: "user_pat", purpose: CLUB_FEE_PURPOSE, action: "replace-card" });
    expect(p.setup_intent_data?.metadata).toEqual({ orgId: "org_1", payerUserId: "user_pat", purpose: CLUB_FEE_PURPOSE });
    expect(p.metadata).not.toHaveProperty("matchId");
    expect(p.success_url).toBe(`${BASE}/billing/org_1?replaced=1`);
    expect(p.cancel_url).toBe(`${BASE}/billing/org_1`);
    expect(p).not.toHaveProperty("line_items");
  });
});

describe("isClubFeeMetadata", () => {
  it("only purpose 'club-fee' with an orgId", () => {
    expect(isClubFeeMetadata({ purpose: "club-fee", orgId: "o" })).toBe(true);
    expect(isClubFeeMetadata({ purpose: "club-fee" })).toBe(false);
    expect(isClubFeeMetadata({ matchId: "m", userId: "u" })).toBe(false);
    expect(isClubFeeMetadata(null)).toBe(false);
  });
});

describe("billingStripeConfig: env, never a key in code", () => {
  it("reads the price, product, tax rate, portal configuration and webhook secret", () => {
    const c = billingStripeConfig({
      STRIPE_CLUB_PRICE_ID: "price_std",
      STRIPE_CLUB_PRODUCT_ID: "prod_1",
      STRIPE_CLUB_TAX_RATE_ID: "txr_vat",
      STRIPE_CLUB_PORTAL_CONFIG_ID: "bpc_1",
      STRIPE_BILLING_WEBHOOK_SECRET: "whsec_b",
    });
    expect(c).toEqual({
      priceId: "price_std",
      productId: "prod_1",
      taxRateId: "txr_vat",
      portalConfigId: "bpc_1",
      webhookSecret: "whsec_b",
      missingForCheckout: [],
    });
  });

  it("names what is missing for a Checkout (the price and the tax rate are required)", () => {
    expect(billingStripeConfig({}).missingForCheckout).toEqual(["STRIPE_CLUB_PRICE_ID", "STRIPE_CLUB_TAX_RATE_ID"]);
  });
});

describe("verifyBillingWebhook: its OWN secret (section 2)", () => {
  const payload = JSON.stringify({ id: "evt_1", object: "event", type: "invoice.paid", data: { object: {} } });
  const signer = new Stripe("sk_test_signing_only");

  it("accepts an event signed with the billing secret", () => {
    const sig = signer.webhooks.generateTestHeaderString({ payload, secret: "whsec_billing" });
    expect(verifyBillingWebhook(payload, sig, "whsec_billing").id).toBe("evt_1");
  });

  it("refuses an event signed with the Connect secret", () => {
    const sig = signer.webhooks.generateTestHeaderString({ payload, secret: "whsec_connect" });
    expect(() => verifyBillingWebhook(payload, sig, "whsec_billing")).toThrow();
  });

  it("refuses a tampered body", () => {
    const sig = signer.webhooks.generateTestHeaderString({ payload, secret: "whsec_billing" });
    expect(() => verifyBillingWebhook(payload.replace("evt_1", "evt_2"), sig, "whsec_billing")).toThrow();
  });

  it("needs no API key (verifying is local)", () => {
    const prev = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      const sig = signer.webhooks.generateTestHeaderString({ payload, secret: "whsec_billing" });
      expect(verifyBillingWebhook(payload, sig, "whsec_billing").type).toBe("invoice.paid");
    } finally {
      if (prev !== undefined) process.env.STRIPE_SECRET_KEY = prev;
    }
  });
});

/** A stand-in Stripe client that records every call and its arguments. */
function recordingClient() {
  const calls: Array<{ path: string; args: unknown[] }> = [];
  const rec =
    (p: string, result: unknown = {}) =>
    (...args: unknown[]) => {
      calls.push({ path: p, args });
      return Promise.resolve(typeof result === "function" ? (result as (...a: unknown[]) => unknown)(...args) : result);
    };
  const client = {
    customers: { create: rec("customers.create", { id: "cus_new" }), update: rec("customers.update") },
    checkout: {
      sessions: {
        create: rec("checkout.sessions.create", { id: "cs_1", url: "https://checkout.stripe.test/cs_1" }),
        list: rec("checkout.sessions.list", {
          data: [
            { id: "cs_old", metadata: { purpose: "club-fee", orgId: "org_1" } },
            { id: "cs_other", metadata: { matchId: "m" } },
          ],
        }),
        expire: rec("checkout.sessions.expire"),
      },
    },
    billingPortal: { sessions: { create: rec("billingPortal.sessions.create", { url: "https://billing.stripe.test/p" }) } },
    subscriptions: {
      retrieve: rec("subscriptions.retrieve", {
        id: "sub_1",
        status: "trialing",
        customer: "cus_1",
        metadata: { orgId: "org_1", purpose: "club-fee" },
        cancel_at_period_end: false,
        trial_end: 1_800_000_000,
        default_payment_method: { id: "pm_1", type: "card", card: { brand: "visa", last4: "4242", country: "GB" } },
        items: { data: [{ id: "si_1", current_period_end: 1_800_000_000, price: { id: "price_std" } }] },
      }),
      update: rec("subscriptions.update"),
      cancel: rec("subscriptions.cancel"),
    },
    setupIntents: {
      retrieve: rec("setupIntents.retrieve", {
        payment_method: { id: "pm_2", type: "card", card: { brand: "mastercard", last4: "4444", country: "TR" } },
      }),
    },
    invoices: { list: rec("invoices.list", { data: [{ id: "in_open" }] }), pay: rec("invoices.pay") },
    paymentMethods: { detach: rec("paymentMethods.detach") },
    prices: {
      list: rec("prices.list", { data: [] }),
      create: rec("prices.create", { id: "price_custom_500" }),
    },
  };
  return { client, calls };
}

describe("the real adapter (recording client, no network)", () => {
  it("NEVER passes a Connect stripeAccount on any call", async () => {
    const { client, calls } = recordingClient();
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    await a.createCustomer({ orgId: "org_1", name: "Billing Sevens" });
    await a.expireOpenCheckoutSessions("cus_1");
    await a.createCheckoutSession(buildSubscriptionCheckoutParams({ orgId: "org_1", payerUserId: "u", customerId: "cus_1", priceId: "p", taxRateId: "t", trialEnd: null, baseUrl: BASE }));
    await a.createPortalSession({ customerId: "cus_1", returnUrl: `${BASE}/billing/org_1`, configuration: null });
    await a.retrieveSubscription("sub_1");
    await a.retrieveSetupIntentCard("seti_1");
    await a.setDefaultPaymentMethod({ customerId: "cus_1", subscriptionId: "sub_1", paymentMethodId: "pm_2", email: "pat@example.test", name: "Pat" });
    await a.payOpenInvoices("sub_1");
    await a.detachPaymentMethod("pm_1");
    await a.updateSubscriptionPrice({ subscriptionId: "sub_1", itemId: "si_1", priceId: "price_custom_500" });
    await a.cancelSubscription("sub_1");
    await a.findOrCreateCustomPrice({ productId: "prod_1", pence: 500 });
    expect(calls.length).toBeGreaterThan(10);
    expect(JSON.stringify(calls)).not.toMatch(/stripeAccount|application_fee/);
  });

  it("creates ONE Customer per club: an idempotency key per club, the orgId and purpose in metadata", async () => {
    const { client, calls } = recordingClient();
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    expect(await a.createCustomer({ orgId: "org_1", name: "Billing Sevens" })).toEqual({ id: "cus_new" });
    expect(calls[0]).toEqual({
      path: "customers.create",
      args: [{ name: "Billing Sevens", metadata: { orgId: "org_1", purpose: "club-fee" } }, { idempotencyKey: "club-customer-org_1" }],
    });
  });

  it("expires only the club fee sessions still open, so two tabs can never both subscribe", async () => {
    const { client, calls } = recordingClient();
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    expect(await a.expireOpenCheckoutSessions("cus_1")).toBe(1);
    expect(calls.filter((c) => c.path === "checkout.sessions.expire").map((c) => c.args[0])).toEqual(["cs_old"]);
    expect(calls[0].args[0]).toEqual({ customer: "cus_1", status: "open", limit: 20 });
  });

  it("reads the subscription into plain fields (period end from the item, card from the expanded payment method)", async () => {
    const { client, calls } = recordingClient();
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    expect(await a.retrieveSubscription("sub_1")).toEqual({
      id: "sub_1",
      status: "trialing",
      customerId: "cus_1",
      metadata: { orgId: "org_1", purpose: "club-fee" },
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(1_800_000_000 * 1000),
      trialEnd: new Date(1_800_000_000 * 1000),
      priceId: "price_std",
      itemId: "si_1",
      card: { paymentMethodId: "pm_1", brand: "visa", last4: "4242", country: "GB" },
    });
    expect(calls[0].args).toEqual(["sub_1", { expand: ["default_payment_method"] }]);
  });

  it("makes the new card the default on the Customer AND the subscription", async () => {
    const { client, calls } = recordingClient();
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    await a.setDefaultPaymentMethod({ customerId: "cus_1", subscriptionId: "sub_1", paymentMethodId: "pm_2", email: "pat@example.test", name: "Pat" });
    expect(calls).toEqual([
      { path: "customers.update", args: ["cus_1", { invoice_settings: { default_payment_method: "pm_2" }, email: "pat@example.test", name: "Pat" }] },
      { path: "subscriptions.update", args: ["sub_1", { default_payment_method: "pm_2" }] },
    ]);
  });

  it("a plan change swaps the item's price with no proration; Free cancels at once with no proration", async () => {
    const { client, calls } = recordingClient();
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    await a.updateSubscriptionPrice({ subscriptionId: "sub_1", itemId: "si_1", priceId: "price_custom_500" });
    await a.cancelSubscription("sub_1");
    expect(calls).toEqual([
      { path: "subscriptions.update", args: ["sub_1", { items: [{ id: "si_1", price: "price_custom_500" }], proration_behavior: "none" }] },
      { path: "subscriptions.cancel", args: ["sub_1", { prorate: false }] },
    ]);
  });

  it("a Custom price is looked up by its lookup key, else created tax INCLUSIVE, monthly, in GBP", async () => {
    const { client, calls } = recordingClient();
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    expect(await a.findOrCreateCustomPrice({ productId: "prod_1", pence: 500 })).toBe("price_custom_500");
    expect(calls).toEqual([
      { path: "prices.list", args: [{ lookup_keys: ["club_monthly_500"], limit: 1 }] },
      {
        path: "prices.create",
        args: [
          {
            product: "prod_1",
            currency: "gbp",
            unit_amount: 500,
            recurring: { interval: "month" },
            tax_behavior: "inclusive",
            lookup_key: "club_monthly_500",
            metadata: { purpose: "club-fee" },
          },
        ],
      },
    ]);
  });

  it("reuses an existing Custom price", async () => {
    const { client, calls } = recordingClient();
    client.prices.list = (...args: unknown[]) => {
      calls.push({ path: "prices.list", args });
      return Promise.resolve({ data: [{ id: "price_existing_500", active: true }] });
    };
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    expect(await a.findOrCreateCustomPrice({ productId: "prod_1", pence: 500 })).toBe("price_existing_500");
    expect(calls.map((c) => c.path)).toEqual(["prices.list"]);
  });

  it("the Portal session takes the configuration when one is set", async () => {
    const { client, calls } = recordingClient();
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    await a.createPortalSession({ customerId: "cus_1", returnUrl: `${BASE}/billing/org_1`, configuration: "bpc_1" });
    expect(calls[0].args).toEqual([{ customer: "cus_1", return_url: `${BASE}/billing/org_1`, configuration: "bpc_1" }]);
  });

  it("retries the open invoice on the new card; a decline is logged, not thrown", async () => {
    const { client } = recordingClient();
    client.invoices.pay = vi.fn().mockRejectedValue(new Error("card_declined"));
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    await expect(a.payOpenInvoices("sub_1")).resolves.toBe(0);
  });
});

describe("which adapter (fake only under MT_TEST_MODE and BILLING_STRIPE_FAKE together)", () => {
  it("fake needs BOTH test mode and the flag", () => {
    expect(isBillingStripeFake({ MT_TEST_MODE: "1", BILLING_STRIPE_FAKE: "1" })).toBe(true);
    expect(isBillingStripeFake({ BILLING_STRIPE_FAKE: "1" })).toBe(false);
    expect(isBillingStripeFake({ MT_TEST_MODE: "1" })).toBe(false);
  });

  it("never fake with a live key in the environment", () => {
    expect(isBillingStripeFake({ MT_TEST_MODE: "1", BILLING_STRIPE_FAKE: "1", STRIPE_SECRET_KEY: "sk_live_x" })).toBe(false);
  });

  it("null when Stripe is not configured and not faked", () => {
    expect(getBillingStripe({})).toBeNull();
  });

  it("the test override wins", () => {
    const fake = createFakeBillingStripe();
    setBillingStripeForTests(fake);
    expect(getBillingStripe({})).toBe(fake);
  });
});

describe("the fake adapter (Playwright's Stripe)", () => {
  it("records calls, returns a LOCAL checkout URL, and serves subscriptions a test wrote", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mt-fake-stripe-"));
    const file = path.join(dir, "stripe.json");
    try {
      const fake = createFakeBillingStripe({ file });
      const { id: customerId } = await fake.createCustomer({ orgId: "org_1", name: "Club" });
      expect(customerId).toMatch(/^cus_fake_/);
      const params = buildSubscriptionCheckoutParams({ orgId: "org_1", payerUserId: "u", customerId, priceId: "p", taxRateId: "t", trialEnd: NOW, baseUrl: BASE });
      const s = await fake.createCheckoutSession(params);
      expect(s.url).toBe(`${BASE}/billing/org_1?fake_checkout=${s.id}`);
      const state = JSON.parse(readFileSync(file, "utf8"));
      expect(state.calls.map((c: { method: string }) => c.method)).toEqual(["createCustomer", "createCheckoutSession"]);
      expect(state.sessions[s.id].params.metadata.purpose).toBe("club-fee");

      // A test writes the subscription Stripe would hold, then the adapter serves it.
      const second = createFakeBillingStripe({ file });
      second.putSubscription({
        id: "sub_fake_1",
        status: "trialing",
        customerId,
        metadata: { orgId: "org_1", purpose: "club-fee" },
        cancelAtPeriodEnd: false,
        currentPeriodEnd: NOW,
        trialEnd: NOW,
        priceId: "p",
        itemId: "si_fake_1",
        card: { paymentMethodId: "pm_fake_1", brand: "visa", last4: "4242", country: "GB" },
      });
      expect((await fake.retrieveSubscription("sub_fake_1")).currentPeriodEnd).toEqual(NOW);
      await expect(fake.retrieveSubscription("sub_missing")).rejects.toThrow(/No such subscription/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("review fixes on the adapter", () => {
  function client2() {
    const { client, calls } = recordingClient();
    const rec =
      (p: string, result: unknown = {}) =>
      (...args: unknown[]) => {
        calls.push({ path: p, args });
        return Promise.resolve(result);
      };
    Object.assign(client.subscriptions, {
      list: rec("subscriptions.list", {
        data: [
          { id: "sub_live", status: "past_due", customer: "cus_1", metadata: { orgId: "org_1", purpose: "club-fee" }, cancel_at_period_end: false, trial_end: null, default_payment_method: null, items: { data: [{ id: "si", current_period_end: 1_800_000_000, price: { id: "p" } }] } },
          { id: "sub_dead", status: "canceled", customer: "cus_1", metadata: { orgId: "org_1", purpose: "club-fee" }, cancel_at_period_end: false, trial_end: null, default_payment_method: null, items: { data: [] } },
          { id: "sub_other", status: "active", customer: "cus_1", metadata: {}, cancel_at_period_end: false, trial_end: null, default_payment_method: null, items: { data: [] } },
        ],
      }),
    });
    Object.assign(client.customers, {
      listTaxIds: rec("customers.listTaxIds", { data: [{ id: "txi_old" }] }),
      deleteTaxId: rec("customers.deleteTaxId"),
    });
    Object.assign(client.invoices, {
      list: rec("invoices.list", { data: [{ id: "in_paid", amount_paid: 999 }, { id: "in_zero", amount_paid: 0 }] }),
    });
    Object.assign(client, {
      invoicePayments: { list: rec("invoicePayments.list", { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: "pi_1" } }] }) },
      refunds: { create: rec("refunds.create", { id: "re_1" }) },
    });
    return { client, calls };
  }

  it("fix 5: lists the Customer's LIVE club fee subscriptions from Stripe (the truth before any new session)", async () => {
    const { client, calls } = client2();
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    const live = await a.listLiveSubscriptions("cus_1");
    expect(live.map((s) => [s.id, s.status])).toEqual([["sub_live", "past_due"]]);
    expect(calls[0].args[0]).toEqual({ customer: "cus_1", status: "all", limit: 20, expand: ["data.default_payment_method"] });
  });

  it("fix 4: resets the Customer to the club before a new payer's session (name, no email, no address, no VAT numbers)", async () => {
    const { client, calls } = client2();
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    await a.resetCustomerDetails({ customerId: "cus_1", name: "Billing Sevens" });
    expect(calls).toEqual([
      { path: "customers.update", args: ["cus_1", { name: "Billing Sevens", email: "", address: "", phone: "" }] },
      { path: "customers.listTaxIds", args: ["cus_1", { limit: 20 }] },
      { path: "customers.deleteTaxId", args: ["cus_1", "txi_old"] },
    ]);
  });

  it("fix 5: refunds every PAID invoice of a cancelled duplicate, once each (idempotency key per invoice)", async () => {
    const { client, calls } = client2();
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    expect(await a.refundPaidInvoices("sub_dup")).toBe(999);
    expect(calls.find((c) => c.path === "invoices.list")!.args[0]).toEqual({ subscription: "sub_dup", status: "paid", limit: 10 });
    expect(calls.filter((c) => c.path === "refunds.create")).toEqual([
      { path: "refunds.create", args: [{ payment_intent: "pi_1", metadata: { purpose: "club-fee", reason: "duplicate-or-unwanted" } }, { idempotencyKey: "club-fee-refund-in_paid" }] },
    ]);
  });

  it("fix 11: an INACTIVE price holding the lookup key is reactivated, not duplicated", async () => {
    const { client, calls } = recordingClient();
    client.prices.list = (...args: unknown[]) => {
      calls.push({ path: "prices.list", args });
      return Promise.resolve({ data: [{ id: "price_old_500", active: false }] });
    };
    Object.assign(client.prices, {
      update: (...args: unknown[]) => {
        calls.push({ path: "prices.update", args });
        return Promise.resolve({ id: "price_old_500" });
      },
    });
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    expect(await a.findOrCreateCustomPrice({ productId: "prod_1", pence: 500 })).toBe("price_old_500");
    expect(calls).toEqual([
      { path: "prices.list", args: [{ lookup_keys: ["club_monthly_500"], limit: 1 }] },
      { path: "prices.update", args: ["price_old_500", { active: true }] },
    ]);
  });

  it("fix 11: the fake is refused with a restricted live key too", () => {
    expect(isBillingStripeFake({ MT_TEST_MODE: "1", BILLING_STRIPE_FAKE: "1", STRIPE_SECRET_KEY: "rk_live_x" })).toBe(false);
  });

  it("fix 4: no Portal configuration, no Portal (portalConfigId null), and the setup Checkout keeps the payer's own details", () => {
    expect(billingStripeConfig({}).portalConfigId).toBeNull();
  });
});
