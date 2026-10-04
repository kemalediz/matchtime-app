/**
 * CLUB FEE BILLING: the Stripe adapter and its pure halves (slice B3,
 * rewritten for games played in slice P2).
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 2, 5.1 to 5.4.
 *
 * NO NETWORK. The real adapter is driven with a recording stand-in for the
 * Stripe client, so the exact calls (and the absence of any Connect
 * `stripeAccount`) are pinned; webhook signatures are made locally with
 * `generateTestHeaderString`; the fake adapter is the one Playwright and
 * the month close tests use.
 *
 * P2: no subscription, no Portal, no price objects. A card is saved with
 * Checkout in SETUP mode, and each month with something to charge is ONE
 * invoice our month close creates: an invoice item for the exact pence,
 * tax INCLUSIVE with the 20% VAT rate, charged automatically, with an
 * idempotency key per club month.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Stripe from "stripe";
import { afterEach, describe, expect, it } from "vitest";
import * as adapterModule from "../stripe-billing";
import {
  CLUB_FEE_PURPOSE,
  billingStripeConfig,
  buildCardSetupCheckoutParams,
  buildMonthInvoiceItemParams,
  buildMonthInvoiceParams,
  createStripeBillingAdapter,
  getBillingStripe,
  isBillingStripeFake,
  isClubFeeMetadata,
  monthInvoiceSearchQuery,
  setBillingStripeForTests,
  verifyBillingWebhook,
} from "../stripe-billing";
import { createFakeBillingStripe } from "../stripe-billing-fake";

const BASE = "https://matchtime.example";

afterEach(() => setBillingStripeForTests(null));

const MONTH = {
  orgId: "org_1",
  monthId: "cbm_1",
  customerId: "cus_1",
  description: "MatchTime club fee, Card Sevens, 1 Nov 2026 to 30 Nov 2026: 4 of 5 games played",
};

describe("setup Checkout: Add a card and Use my card instead (5.3, 4.5 point 4)", () => {
  const params = (action: "add-card" | "replace-card") =>
    buildCardSetupCheckoutParams({ orgId: "org_1", payerUserId: "user_colin", customerId: "cus_1", baseUrl: `${BASE}/`, action });

  it("is SETUP mode on the club's own Customer: card only, GBP, billing address required, nothing charged", () => {
    const p = params("add-card");
    expect(p).toMatchObject({
      mode: "setup",
      customer: "cus_1",
      client_reference_id: "org_1",
      currency: "gbp",
      payment_method_types: ["card"],
      billing_address_collection: "required",
    });
    expect(p).not.toHaveProperty("line_items");
    expect(p).not.toHaveProperty("subscription_data");
  });

  it("carries orgId, payerUserId, purpose 'club-fee' and the action, on the session AND the SetupIntent", () => {
    for (const action of ["add-card", "replace-card"] as const) {
      const p = params(action);
      expect(p.metadata).toEqual({ orgId: "org_1", payerUserId: "user_colin", purpose: CLUB_FEE_PURPOSE, action });
      expect(p.setup_intent_data?.metadata).toEqual({ orgId: "org_1", payerUserId: "user_colin", purpose: CLUB_FEE_PURPOSE, action });
    }
  });

  it("never matchId, userId, a Connect account, an application fee or a payment", () => {
    const json = JSON.stringify(params("add-card"));
    expect(json).not.toMatch(/matchId|"userId"|application_fee|transfer_data|payment_intent_data|on_behalf_of/);
  });

  it("does NOT ask Checkout for a VAT number in setup mode (not confirmed that setup mode allows it; see the test mode list)", () => {
    expect(params("add-card")).not.toHaveProperty("tax_id_collection");
  });

  it("comes back to the billing page: ?done=1 for a new card, ?replaced=1 for a replacement", () => {
    expect(params("add-card").success_url).toBe(`${BASE}/billing/org_1?done=1`);
    expect(params("replace-card").success_url).toBe(`${BASE}/billing/org_1?replaced=1`);
    expect(params("add-card").cancel_url).toBe(`${BASE}/billing/org_1`);
  });
});

describe("one invoice per month (5.3, charge a month)", () => {
  it("the invoice: charged automatically, NOT auto-advanced while it is a draft, pending items excluded, the club fee metadata", () => {
    const { params, idempotencyKey } = buildMonthInvoiceParams(MONTH);
    expect(params).toEqual({
      customer: "cus_1",
      collection_method: "charge_automatically",
      // A draft must never be finalised by Stripe on its own (an empty
      // invoice an hour later): we finalise it ourselves once the item is on.
      auto_advance: false,
      pending_invoice_items_behavior: "exclude",
      currency: "gbp",
      description: MONTH.description,
      metadata: { orgId: "org_1", purpose: "club-fee", monthId: "cbm_1" },
    });
    expect(idempotencyKey).toBe("club-fee-invoice-cbm_1");
  });

  it("the item: the exact pence under the club product, the VAT Tax Rate (whose OWN inclusive setting decides), on that invoice", () => {
    const { params, idempotencyKey } = buildMonthInvoiceItemParams({
      customerId: "cus_1",
      invoiceId: "in_1",
      monthId: "cbm_1",
      orgId: "org_1",
      amountPence: 799,
      productId: "prod_club",
      taxRateId: "txr_vat",
      description: MONTH.description,
    });
    expect(params).toEqual({
      customer: "cus_1",
      invoice: "in_1",
      // No price_data.tax_behavior (M4): that field is for Stripe Tax; with a
      // manual tax rate the RATE's inclusive flag decides, and the close
      // checks that flag before any invoice is made.
      price_data: { currency: "gbp", product: "prod_club", unit_amount: 799 },
      quantity: 1,
      tax_rates: ["txr_vat"],
      description: MONTH.description,
      metadata: { orgId: "org_1", purpose: "club-fee", monthId: "cbm_1" },
    });
    expect(idempotencyKey).toBe("club-fee-item-cbm_1");
  });

  it("refuses an amount that is not whole pence of at least 30p (Stripe's minimum)", () => {
    const base = { customerId: "c", invoiceId: "i", monthId: "m", orgId: "o", productId: "p", taxRateId: "t", description: "d" };
    expect(() => buildMonthInvoiceItemParams({ ...base, amountPence: 29 })).toThrow();
    expect(() => buildMonthInvoiceItemParams({ ...base, amountPence: 7.5 })).toThrow();
    expect(() => buildMonthInvoiceItemParams({ ...base, amountPence: 30 })).not.toThrow();
  });

  it("finds a month's invoice by its metadata (a crash after Stripe made it, retried after the 24 hour key window)", () => {
    expect(monthInvoiceSearchQuery("cbm_1")).toBe("metadata['monthId']:'cbm_1'");
    expect(() => monthInvoiceSearchQuery("x' OR '1")).toThrow();
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
  it("reads the product, tax rate and webhook secret; the price and Portal ids are retired", () => {
    const c = billingStripeConfig({
      STRIPE_CLUB_PRODUCT_ID: " prod_1 ",
      STRIPE_CLUB_TAX_RATE_ID: "txr_1",
      STRIPE_BILLING_WEBHOOK_SECRET: "whsec_b",
      STRIPE_CLUB_PRICE_ID: "price_old",
      STRIPE_CLUB_PORTAL_CONFIG_ID: "bpc_old",
    });
    expect(c).toEqual({ productId: "prod_1", taxRateId: "txr_1", webhookSecret: "whsec_b", missing: [] });
  });

  it("names what is missing to charge a month (the product and the tax rate are both required)", () => {
    expect(billingStripeConfig({}).missing).toEqual(["STRIPE_CLUB_PRODUCT_ID", "STRIPE_CLUB_TAX_RATE_ID"]);
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
});

/** A stand-in Stripe client that records every call and its arguments. */
function recordingClient(over: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; args: unknown[] }> = [];
  const rec =
    (p: string, result: unknown = {}) =>
    (...args: unknown[]) => {
      calls.push({ path: p, args });
      return typeof result === "function" ? (result as (...a: unknown[]) => unknown)(...args) : Promise.resolve(result);
    };
  const invoice = (o: Record<string, unknown> = {}) => ({
    id: "in_1",
    status: "draft",
    total: 0,
    customer: "cus_1",
    hosted_invoice_url: "https://invoice.stripe.test/in_1",
    metadata: { orgId: "org_1", purpose: "club-fee", monthId: "cbm_1" },
    ...o,
  });
  const client = {
    customers: {
      create: rec("customers.create", { id: "cus_new" }),
      update: rec("customers.update"),
      listTaxIds: rec("customers.listTaxIds", { data: [{ id: "txi_old" }] }),
      deleteTaxId: rec("customers.deleteTaxId"),
    },
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
    setupIntents: {
      retrieve: rec("setupIntents.retrieve", {
        payment_method: { id: "pm_2", type: "card", card: { brand: "mastercard", last4: "4444", country: "TR" } },
      }),
    },
    invoices: {
      create: rec("invoices.create", invoice()),
      retrieve: rec("invoices.retrieve", invoice({ status: "open", total: 799 })),
      finalizeInvoice: rec("invoices.finalizeInvoice", invoice({ status: "open", total: 799 })),
      pay: rec("invoices.pay", invoice({ status: "paid", total: 799 })),
      voidInvoice: rec("invoices.voidInvoice", invoice({ status: "void", total: 799 })),
      del: rec("invoices.del", { id: "in_1", deleted: true }),
      search: rec("invoices.search", { data: [invoice({ status: "open", total: 799 })] }),
    },
    invoiceItems: { create: rec("invoiceItems.create", { id: "ii_1" }) },
    paymentMethods: { detach: rec("paymentMethods.detach") },
    ...over,
  };
  return { client, calls, invoice };
}

describe("the real adapter (recording client, no network)", () => {
  it("NEVER passes a Connect stripeAccount, an application fee or a transfer on any call", async () => {
    const { client, calls } = recordingClient();
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    await a.createCustomer({ orgId: "org_1", name: "Billing Sevens" });
    await a.expireOpenCheckoutSessions("cus_1");
    await a.createCheckoutSession(buildCardSetupCheckoutParams({ orgId: "org_1", payerUserId: "u", customerId: "cus_1", baseUrl: BASE, action: "add-card" }));
    await a.retrieveSetupIntentCard("seti_1");
    await a.setDefaultPaymentMethod({ customerId: "cus_1", paymentMethodId: "pm_2", email: "pat@example.test", name: "Pat" });
    await a.createMonthInvoice(MONTH);
    await a.addMonthInvoiceItem({ ...MONTH, invoiceId: "in_1", amountPence: 799, productId: "prod_club", taxRateId: "txr_vat" });
    await a.finalizeInvoice("in_1");
    await a.payInvoice("in_1", { paymentMethodId: "pm_2" });
    await a.findMonthInvoices("cbm_1");
    await a.voidInvoice("in_1");
    await a.detachPaymentMethod("pm_1");
    expect(calls.length).toBeGreaterThan(10);
    expect(JSON.stringify(calls)).not.toMatch(/stripeAccount|application_fee|transfer_data|on_behalf_of/);
  });

  it("the retired subscription calls are gone from the adapter", () => {
    const a = createStripeBillingAdapter(recordingClient().client as unknown as Stripe) as unknown as Record<string, unknown>;
    for (const name of [
      "createPortalSession",
      "retrieveSubscription",
      "listLiveSubscriptions",
      "updateSubscriptionPrice",
      "cancelSubscription",
      "setCancelAtPeriodEnd",
      "findOrCreateCustomPrice",
      "refundPaidInvoices",
      "payOpenInvoices",
    ]) {
      expect(a[name], name).toBeUndefined();
    }
    expect("buildSubscriptionCheckoutParams" in adapterModule).toBe(false);
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

  it("expires only the club fee sessions still open, so two tabs can never both save a card", async () => {
    const { client, calls } = recordingClient();
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    expect(await a.expireOpenCheckoutSessions("cus_1")).toBe(1);
    expect(calls.filter((c) => c.path === "checkout.sessions.expire").map((c) => c.args[0])).toEqual(["cs_old"]);
  });

  it("makes the new card the Customer's default for invoices (no subscription to update), with the payer's email", async () => {
    const { client, calls } = recordingClient();
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    await a.setDefaultPaymentMethod({ customerId: "cus_1", paymentMethodId: "pm_2", email: "pat@example.test", name: "Pat" });
    expect(calls).toEqual([
      {
        path: "customers.update",
        args: ["cus_1", { invoice_settings: { default_payment_method: "pm_2" }, email: "pat@example.test", name: "Pat" }],
      },
    ]);
  });

  it("creates the month's invoice and item with their idempotency keys", async () => {
    const { client, calls } = recordingClient();
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    const inv = await a.createMonthInvoice(MONTH);
    expect(inv).toMatchObject({ id: "in_1", status: "draft", totalPence: 0, customerId: "cus_1" });
    await a.addMonthInvoiceItem({ ...MONTH, invoiceId: "in_1", amountPence: 799, productId: "prod_club", taxRateId: "txr_vat" });
    expect(calls[0].path).toBe("invoices.create");
    expect(calls[0].args[1]).toEqual({ idempotencyKey: "club-fee-invoice-cbm_1" });
    expect(calls[1].path).toBe("invoiceItems.create");
    expect(calls[1].args[1]).toEqual({ idempotencyKey: "club-fee-item-cbm_1" });
  });

  it("finalises a draft with auto-advance ON (so Stripe's automatic collection retries), and leaves a finalised one alone", async () => {
    const { client, calls, invoice } = recordingClient();
    client.invoices.retrieve = (() => Promise.resolve(invoice({ status: "draft", total: 799 }))) as never;
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    expect((await a.finalizeInvoice("in_1")).status).toBe("open");
    expect(calls.find((c) => c.path === "invoices.finalizeInvoice")?.args).toEqual(["in_1", { auto_advance: true }]);

    const second = recordingClient();
    const b = createStripeBillingAdapter(second.client as unknown as Stripe);
    expect((await b.finalizeInvoice("in_1")).status).toBe("open");
    expect(second.calls.some((c) => c.path === "invoices.finalizeInvoice")).toBe(false);
  });

  it("pays on the given card; a DECLINE is not an error (Stripe reports it with invoice.payment_failed)", async () => {
    const declined = Object.assign(new Error("Your card was declined."), { type: "StripeCardError", code: "card_declined" });
    const { client, calls, invoice } = recordingClient({});
    client.invoices.pay = ((...args: unknown[]) => {
      calls.push({ path: "invoices.pay", args });
      return Promise.reject(declined);
    }) as never;
    client.invoices.retrieve = (() => Promise.resolve(invoice({ status: "open", total: 799 }))) as never;
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    const r = await a.payInvoice("in_1", { paymentMethodId: "pm_2" });
    expect(r).toMatchObject({ declined: true, invoice: { status: "open" } });
    expect(calls.find((c) => c.path === "invoices.pay")?.args).toEqual(["in_1", { payment_method: "pm_2" }]);
  });

  it("paying an invoice that is already paid is done, not an error", async () => {
    const { client, invoice } = recordingClient();
    client.invoices.pay = (() => Promise.reject(Object.assign(new Error("Invoice is already paid"), { type: "StripeInvalidRequestError" }))) as never;
    client.invoices.retrieve = (() => Promise.resolve(invoice({ status: "paid", total: 799 }))) as never;
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    expect(await a.payInvoice("in_1")).toMatchObject({ declined: false, invoice: { status: "paid" } });
  });

  it("any other error while the invoice is still open is thrown (the close retries later)", async () => {
    const { client, invoice } = recordingClient();
    client.invoices.pay = (() => Promise.reject(Object.assign(new Error("connection reset"), { type: "StripeConnectionError" }))) as never;
    client.invoices.retrieve = (() => Promise.resolve(invoice({ status: "open", total: 799 }))) as never;
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    await expect(a.payInvoice("in_1")).rejects.toThrow(/connection reset/);
  });

  it("M4: reads a Tax Rate's inclusive flag, percentage and state (checked before any invoice is made)", async () => {
    const { client, calls } = recordingClient({
      taxRates: {
        retrieve: (...args: unknown[]) => {
          calls.push({ path: "taxRates.retrieve", args });
          return Promise.resolve({ id: "txr_vat", inclusive: true, percentage: 20, active: true });
        },
      },
    });
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    expect(await a.retrieveTaxRate("txr_vat")).toEqual({ id: "txr_vat", inclusive: true, percentage: 20, active: true });
  });

  it("M4: an invoice carries amount_due as well as total", async () => {
    const { client } = recordingClient();
    client.invoices.retrieve = (() => Promise.resolve({ id: "in_1", status: "open", total: 799, amount_due: 699, customer: "cus_1", metadata: {} })) as never;
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    expect(await a.retrieveInvoice("in_1")).toMatchObject({ totalPence: 799, amountDuePence: 699 });
  });

  it("finds a month's invoices by search, club fee ones for that month only", async () => {
    const { client, calls, invoice } = recordingClient();
    client.invoices.search = ((...args: unknown[]) => {
      calls.push({ path: "invoices.search", args });
      return Promise.resolve({
        data: [invoice({ id: "in_a", status: "open", total: 799 }), invoice({ id: "in_b", metadata: { monthId: "cbm_1" } })],
      });
    }) as never;
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    expect((await a.findMonthInvoices("cbm_1")).map((i) => i.id)).toEqual(["in_a"]);
    expect(calls[0].args[0]).toEqual({ query: "metadata['monthId']:'cbm_1'", limit: 10 });
  });

  it("void: a draft is DELETED (Stripe cannot void a draft), an open one voided, a paid one left alone", async () => {
    for (const [status, outcome, path] of [
      ["draft", "deleted", "invoices.del"],
      ["open", "voided", "invoices.voidInvoice"],
      ["uncollectible", "voided", "invoices.voidInvoice"],
      ["void", "already-void", null],
      ["paid", "paid", null],
    ] as const) {
      const { client, calls, invoice } = recordingClient();
      client.invoices.retrieve = (() => Promise.resolve(invoice({ status, total: 799 }))) as never;
      const a = createStripeBillingAdapter(client as unknown as Stripe);
      expect(await a.voidInvoice("in_1"), status).toBe(outcome);
      const mutating = calls.filter((c) => c.path === "invoices.del" || c.path === "invoices.voidInvoice").map((c) => c.path);
      expect(mutating, status).toEqual(path ? [path] : []);
    }
  });

  it("resets the shared Customer to the club for a new payer (name, no email, no address, no VAT numbers)", async () => {
    const { client, calls } = recordingClient();
    const a = createStripeBillingAdapter(client as unknown as Stripe);
    await a.resetCustomerDetails({ customerId: "cus_1", name: "Card Sevens" });
    expect(calls.map((c) => c.path)).toEqual(["customers.update", "customers.listTaxIds", "customers.deleteTaxId"]);
    expect(calls[0].args).toEqual(["cus_1", { name: "Card Sevens", email: "", address: "", phone: "" }]);
  });
});

describe("which adapter (fake only under MT_TEST_MODE and BILLING_STRIPE_FAKE together)", () => {
  it("fake needs BOTH test mode and the flag", () => {
    expect(isBillingStripeFake({ MT_TEST_MODE: "1", BILLING_STRIPE_FAKE: "1" })).toBe(true);
    expect(isBillingStripeFake({ BILLING_STRIPE_FAKE: "1" })).toBe(false);
    expect(isBillingStripeFake({ MT_TEST_MODE: "1" })).toBe(false);
  });

  it("never fake with a live key (secret or restricted) in the environment", () => {
    expect(isBillingStripeFake({ MT_TEST_MODE: "1", BILLING_STRIPE_FAKE: "1", STRIPE_SECRET_KEY: "sk_live_x" })).toBe(false);
    expect(isBillingStripeFake({ MT_TEST_MODE: "1", BILLING_STRIPE_FAKE: "1", STRIPE_SECRET_KEY: "rk_live_x" })).toBe(false);
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

describe("the fake adapter (the month close tests' and Playwright's Stripe)", () => {
  const item = { productId: "prod_e2e", taxRateId: "txr_e2e_vat" };

  it("records calls, returns a LOCAL checkout URL, and shares one world across instances through its file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mt-fake-stripe-"));
    const file = path.join(dir, "stripe.json");
    try {
      const fake = createFakeBillingStripe({ file });
      const { id: customerId } = await fake.createCustomer({ orgId: "org_1", name: "Club" });
      expect(customerId).toMatch(/^cus_fake_/);
      const s = await fake.createCheckoutSession(
        buildCardSetupCheckoutParams({ orgId: "org_1", payerUserId: "u", customerId, baseUrl: BASE, action: "add-card" }),
      );
      expect(s.url).toBe(`${BASE}/billing/org_1?fake_checkout=${s.id}`);
      const state = JSON.parse(readFileSync(file, "utf8"));
      expect(state.calls.map((c: { method: string }) => c.method)).toEqual(["createCustomer", "createCheckoutSession"]);
      expect(state.sessions[s.id].params.mode).toBe("setup");
      expect(createFakeBillingStripe({ file }).state().customers[customerId].orgId).toBe("org_1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an idempotency key returns the SAME invoice; the same key with different parameters is refused, like Stripe", async () => {
    const fake = createFakeBillingStripe();
    const a = await fake.createMonthInvoice(MONTH);
    const b = await fake.createMonthInvoice(MONTH);
    expect(b.id).toBe(a.id);
    await expect(fake.createMonthInvoice({ ...MONTH, description: "something else" })).rejects.toThrow(/idempoten/i);
    expect(Object.keys(fake.state().invoices)).toHaveLength(1);
  });

  it("a draft, its item, finalised, paid on the default card", async () => {
    const fake = createFakeBillingStripe();
    await fake.setDefaultPaymentMethod({ customerId: "cus_1", paymentMethodId: "pm_ok" });
    const inv = await fake.createMonthInvoice(MONTH);
    await fake.addMonthInvoiceItem({ ...MONTH, ...item, invoiceId: inv.id, amountPence: 799 });
    expect((await fake.retrieveInvoice(inv.id))?.totalPence).toBe(799);
    expect((await fake.finalizeInvoice(inv.id)).status).toBe("open");
    expect(await fake.payInvoice(inv.id)).toMatchObject({ declined: false, invoice: { status: "paid", totalPence: 799 } });
  });

  it("a card set to decline leaves the invoice open and says so", async () => {
    const fake = createFakeBillingStripe();
    fake.setPayOutcome("pm_bad", "decline");
    const inv = await fake.createMonthInvoice(MONTH);
    await fake.addMonthInvoiceItem({ ...MONTH, ...item, invoiceId: inv.id, amountPence: 499 });
    await fake.finalizeInvoice(inv.id);
    expect(await fake.payInvoice(inv.id, { paymentMethodId: "pm_bad" })).toMatchObject({ declined: true, invoice: { status: "open" } });
  });

  it("a tax rate that is NOT inclusive shows up as a different total (the close refuses to finalise it)", async () => {
    const fake = createFakeBillingStripe();
    const inv = await fake.createMonthInvoice(MONTH);
    await fake.addMonthInvoiceItem({ ...MONTH, productId: "prod", taxRateId: "txr_exclusive_vat", invoiceId: inv.id, amountPence: 799 });
    expect((await fake.retrieveInvoice(inv.id))?.totalPence).toBe(959);
  });

  it("after the idempotency window (forgotten keys), the search still finds the month's invoice", async () => {
    const fake = createFakeBillingStripe();
    const inv = await fake.createMonthInvoice(MONTH);
    fake.forgetIdempotencyKeys();
    expect((await fake.findMonthInvoices("cbm_1")).map((i) => i.id)).toEqual([inv.id]);
  });

  it("void deletes a draft and voids an open invoice", async () => {
    const fake = createFakeBillingStripe();
    const draft = await fake.createMonthInvoice(MONTH);
    expect(await fake.voidInvoice(draft.id)).toBe("deleted");
    const open = await fake.createMonthInvoice({ ...MONTH, monthId: "cbm_2" });
    await fake.addMonthInvoiceItem({ ...MONTH, ...item, monthId: "cbm_2", invoiceId: open.id, amountPence: 999 });
    await fake.finalizeInvoice(open.id);
    expect(await fake.voidInvoice(open.id)).toBe("voided");
    expect((await fake.retrieveInvoice(open.id))?.status).toBe("void");
  });
});
