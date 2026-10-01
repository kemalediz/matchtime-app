/**
 * CLUB FEE BILLING, slice B3: MatchTime's own Stripe Billing, on the
 * PLATFORM account. Plan: MDs/club-fee-billing-plan-2026-10-01.md,
 * sections 2 and 5.
 *
 * ── Kept apart from match fees ───────────────────────────────────────
 * Match fees (src/lib/stripe.ts) are Connect DIRECT charges on each money
 * collector's connected account, verified by the Connect webhook with
 * STRIPE_WEBHOOK_SECRET. The club fee is a plain Billing subscription on
 * MatchTime's own account: no `stripeAccount`, no application fee, no
 * transfer, its own webhook (/api/stripe/billing-webhook) and its own
 * secret (STRIPE_BILLING_WEBHOOK_SECRET). Every session and subscription
 * carries `purpose: "club-fee"` and never `matchId` or `userId`, so even
 * a misrouted event is ignored by the Connect side's `applyCheckoutEvent`.
 *
 * ── Shape ────────────────────────────────────────────────────────────
 *   - pure builders for the two Checkout sessions (tested field by field);
 *   - `BillingStripe`, the few calls billing makes, in plain fields, so
 *     the rest of the code never depends on Stripe's API version shapes;
 *   - the real adapter over the Stripe client (same STRIPE_SECRET_KEY as
 *     match fees: one platform account);
 *   - `getBillingStripe()`: a test override, else the fake (only with
 *     MT_TEST_MODE=1 AND BILLING_STRIPE_FAKE=1 AND no live key), else the
 *     real adapter when STRIPE_SECRET_KEY is set, else null ("not set up").
 *
 * Nothing here reads or writes the database.
 */
import Stripe from "stripe";
import { createFakeBillingStripe } from "./stripe-billing-fake";

type Env = Record<string, string | undefined>;

/** The one marker on every club fee session, subscription and Customer. */
export const CLUB_FEE_PURPOSE = "club-fee";

/** Lookup key of a Custom plan's price: `club_monthly_<pence>` (5.2). */
export function customPriceLookupKey(pence: number): string {
  return `club_monthly_${pence}`;
}

// ── Plain shapes ────────────────────────────────────────────────────────

export interface CardDetails {
  paymentMethodId: string;
  brand: string | null;
  last4: string | null;
  /** The card's issuing country (ISO alpha-2). */
  country: string | null;
}

export interface BillingSubscription {
  id: string;
  /** Stripe's own word: trialing, active, past_due, unpaid, canceled ... */
  status: string;
  customerId: string | null;
  metadata: Record<string, string>;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  trialEnd: Date | null;
  priceId: string | null;
  itemId: string | null;
  /** The subscription's default card, when it has one. */
  card: CardDetails | null;
}

/** The calls club fee billing makes. Real or fake, same contract. */
export interface BillingStripe {
  readonly kind: "stripe" | "fake";
  createCustomer(args: { orgId: string; name: string }): Promise<{ id: string }>;
  /** Expire the club fee Checkout sessions still open on this Customer. */
  expireOpenCheckoutSessions(customerId: string): Promise<number>;
  createCheckoutSession(params: Stripe.Checkout.SessionCreateParams): Promise<{ id: string; url: string }>;
  createPortalSession(args: { customerId: string; returnUrl: string; configuration: string | null }): Promise<{ url: string }>;
  retrieveSubscription(id: string): Promise<BillingSubscription>;
  /** The card a completed setup-mode session saved. */
  retrieveSetupIntentCard(setupIntentId: string): Promise<CardDetails | null>;
  setDefaultPaymentMethod(args: {
    customerId: string;
    subscriptionId: string;
    paymentMethodId: string;
    email?: string | null;
    name?: string | null;
  }): Promise<void>;
  /** Retry the subscription's open invoices on its default card. Returns how many were paid. */
  payOpenInvoices(subscriptionId: string): Promise<number>;
  detachPaymentMethod(paymentMethodId: string): Promise<void>;
  updateSubscriptionPrice(args: { subscriptionId: string; itemId: string; priceId: string }): Promise<void>;
  cancelSubscription(subscriptionId: string): Promise<void>;
  findOrCreateCustomPrice(args: { productId: string; pence: number }): Promise<string>;
  /** The Customer's LIVE club fee subscriptions, read from Stripe itself
   *  (not our mirror), so no new session is made while one exists. */
  listLiveSubscriptions(customerId: string): Promise<BillingSubscription[]>;
  /** Before a NEW payer's session on the club's shared Customer: back to
   *  the club's name, no email, no address, no phone, no VAT numbers, so
   *  Checkout neither shows nor reuses the previous payer's details. */
  resetCustomerDetails(args: { customerId: string; name: string }): Promise<void>;
  /** The payer's own details onto the Customer (for invoices and receipts). */
  updateCustomer(args: {
    customerId: string;
    email?: string | null;
    name?: string | null;
    address?: Stripe.AddressParam | null;
  }): Promise<void>;
  /** Refund every paid invoice of a subscription (a cancelled duplicate or
   *  unwanted one). Returns the pence refunded. One refund per invoice. */
  refundPaidInvoices(subscriptionId: string): Promise<number>;
}

// ── Configuration ───────────────────────────────────────────────────────

export interface BillingStripeConfig {
  /** STRIPE_CLUB_PRICE_ID: the GBP 9.99 monthly, tax inclusive price. */
  priceId: string | null;
  /** STRIPE_CLUB_PRODUCT_ID: the product Custom prices are made under. */
  productId: string | null;
  /** STRIPE_CLUB_TAX_RATE_ID: 20% UK VAT, inclusive. */
  taxRateId: string | null;
  /** STRIPE_CLUB_PORTAL_CONFIG_ID (optional): the Portal configuration
   *  with invoice history off. Unset: the account's default. */
  portalConfigId: string | null;
  /** STRIPE_BILLING_WEBHOOK_SECRET: the platform-scoped endpoint's secret. */
  webhookSecret: string | null;
  /** What a Standard Checkout cannot do without. */
  missingForCheckout: string[];
}

const val = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

export function billingStripeConfig(env: Env = process.env): BillingStripeConfig {
  const c = {
    priceId: val(env.STRIPE_CLUB_PRICE_ID),
    productId: val(env.STRIPE_CLUB_PRODUCT_ID),
    taxRateId: val(env.STRIPE_CLUB_TAX_RATE_ID),
    portalConfigId: val(env.STRIPE_CLUB_PORTAL_CONFIG_ID),
    webhookSecret: val(env.STRIPE_BILLING_WEBHOOK_SECRET),
  };
  const missingForCheckout: string[] = [];
  if (!c.priceId) missingForCheckout.push("STRIPE_CLUB_PRICE_ID");
  if (!c.taxRateId) missingForCheckout.push("STRIPE_CLUB_TAX_RATE_ID");
  return { ...c, missingForCheckout };
}

// ── The two Checkout sessions (pure) ────────────────────────────────────

const billingPath = (orgId: string) => `/billing/${encodeURIComponent(orgId)}`;

/**
 * Add a card (5.2): a subscription on the club's Customer. `trialEnd` is
 * set only while the club is in its free month (`checkoutTrialEnd`); in
 * grace or after a pause the first payment is taken at once. VAT: the
 * inclusive 20% Tax Rate on the subscription, a billing address required
 * (the UK check reads it), and the payer may add a VAT number.
 */
export function buildSubscriptionCheckoutParams(args: {
  orgId: string;
  payerUserId: string;
  customerId: string;
  priceId: string;
  taxRateId: string;
  trialEnd: Date | null;
  baseUrl: string;
}): Stripe.Checkout.SessionCreateParams {
  const base = args.baseUrl.replace(/\/$/, "");
  const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
    metadata: { orgId: args.orgId, payerUserId: args.payerUserId, purpose: CLUB_FEE_PURPOSE },
    default_tax_rates: [args.taxRateId],
  };
  if (args.trialEnd) subscriptionData.trial_end = Math.floor(args.trialEnd.getTime() / 1000);
  return {
    mode: "subscription",
    customer: args.customerId,
    client_reference_id: args.orgId,
    line_items: [{ price: args.priceId, quantity: 1 }],
    payment_method_types: ["card"],
    metadata: { orgId: args.orgId, payerUserId: args.payerUserId, purpose: CLUB_FEE_PURPOSE, action: "add-card" },
    subscription_data: subscriptionData,
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    // Required with tax_id_collection on an existing Customer; also keeps
    // the billing address on the Customer for the invoices.
    customer_update: { address: "auto", name: "auto" },
    success_url: `${base}${billingPath(args.orgId)}?done=1`,
    cancel_url: `${base}${billingPath(args.orgId)}`,
  };
}

/**
 * Use my card instead (4.5 point 4): setup mode on the club's Customer.
 * Not the Portal, which would show the new collector the old collector's
 * card and invoices. The webhook makes the saved card the default.
 */
export function buildSetupCheckoutParams(args: {
  orgId: string;
  payerUserId: string;
  customerId: string;
  baseUrl: string;
}): Stripe.Checkout.SessionCreateParams {
  const base = args.baseUrl.replace(/\/$/, "");
  return {
    mode: "setup",
    customer: args.customerId,
    client_reference_id: args.orgId,
    currency: "gbp",
    payment_method_types: ["card"],
    metadata: { orgId: args.orgId, payerUserId: args.payerUserId, purpose: CLUB_FEE_PURPOSE, action: "replace-card" },
    setup_intent_data: { metadata: { orgId: args.orgId, payerUserId: args.payerUserId, purpose: CLUB_FEE_PURPOSE } },
    billing_address_collection: "required",
    success_url: `${base}${billingPath(args.orgId)}?replaced=1`,
    cancel_url: `${base}${billingPath(args.orgId)}`,
  };
}

/** A club fee object: purpose "club-fee" and an orgId. */
export function isClubFeeMetadata(md: Record<string, string> | null | undefined): md is Record<string, string> & { orgId: string } {
  return !!md && md.purpose === CLUB_FEE_PURPOSE && typeof md.orgId === "string" && md.orgId.length > 0;
}

// ── The webhook signature (local, no API key) ───────────────────────────

/**
 * Verify and parse a billing webhook with ITS OWN secret. An event signed
 * for the Connect endpoint fails here, and the other way round. Throws on
 * a bad signature.
 */
export function verifyBillingWebhook(payload: string, signature: string, secret: string): Stripe.Event {
  return Stripe.webhooks.constructEvent(payload, signature, secret);
}

// ── The real adapter ────────────────────────────────────────────────────

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  v == null ? null : typeof v === "string" ? v : v.id;

const dateOf = (secs: number | null | undefined): Date | null => (typeof secs === "number" ? new Date(secs * 1000) : null);

function cardOf(pm: string | Stripe.PaymentMethod | null | undefined): CardDetails | null {
  if (!pm || typeof pm === "string") return pm ? { paymentMethodId: pm, brand: null, last4: null, country: null } : null;
  return {
    paymentMethodId: pm.id,
    brand: pm.card?.brand ?? null,
    last4: pm.card?.last4 ?? null,
    country: pm.card?.country ?? null,
  };
}

function subscriptionOf(s: Stripe.Subscription): BillingSubscription {
  const item = s.items?.data?.[0];
  return {
    id: s.id,
    status: s.status,
    customerId: idOf(s.customer as string | { id: string }),
    metadata: { ...(s.metadata ?? {}) },
    cancelAtPeriodEnd: !!s.cancel_at_period_end,
    currentPeriodEnd: dateOf(item?.current_period_end),
    trialEnd: dateOf(s.trial_end),
    priceId: item?.price?.id ?? null,
    itemId: item?.id ?? null,
    card: cardOf(s.default_payment_method as string | Stripe.PaymentMethod | null),
  };
}

const LIVE = new Set(["trialing", "active", "past_due", "unpaid", "incomplete", "paused"]);

/** The real adapter over a Stripe client (the platform account). */
export function createStripeBillingAdapter(client: Stripe): BillingStripe {
  return {
    kind: "stripe",

    async createCustomer({ orgId, name }) {
      // One Customer per club: the idempotency key makes a double tap
      // return the same Customer (the caller also stores it with a
      // compare-and-set).
      const c = await client.customers.create(
        { name, metadata: { orgId, purpose: CLUB_FEE_PURPOSE } },
        { idempotencyKey: `club-customer-${orgId}` },
      );
      return { id: c.id };
    },

    async expireOpenCheckoutSessions(customerId) {
      const open = await client.checkout.sessions.list({ customer: customerId, status: "open", limit: 20 });
      let n = 0;
      for (const s of open.data) {
        if (s.metadata?.purpose !== CLUB_FEE_PURPOSE) continue;
        await client.checkout.sessions.expire(s.id);
        n++;
      }
      return n;
    },

    async createCheckoutSession(params) {
      const s = await client.checkout.sessions.create(params);
      if (!s.url) throw new Error(`[stripe-billing] Checkout session ${s.id} has no url`);
      return { id: s.id, url: s.url };
    },

    async createPortalSession({ customerId, returnUrl, configuration }) {
      const p = await client.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
        ...(configuration ? { configuration } : {}),
      });
      return { url: p.url };
    },

    async retrieveSubscription(id) {
      return subscriptionOf(await client.subscriptions.retrieve(id, { expand: ["default_payment_method"] }));
    },

    async listLiveSubscriptions(customerId) {
      const list = await client.subscriptions.list({ customer: customerId, status: "all", limit: 20, expand: ["data.default_payment_method"] });
      return list.data.filter((s) => LIVE.has(s.status) && s.metadata?.purpose === CLUB_FEE_PURPOSE).map(subscriptionOf);
    },

    async resetCustomerDetails({ customerId, name }) {
      // "" unsets a field in Stripe's API.
      await client.customers.update(customerId, { name, email: "", address: "", phone: "" });
      const taxIds = await client.customers.listTaxIds(customerId, { limit: 20 });
      for (const t of taxIds.data) await client.customers.deleteTaxId(customerId, t.id);
    },

    async updateCustomer({ customerId, email, name, address }) {
      await client.customers.update(customerId, {
        ...(email ? { email } : {}),
        ...(name ? { name } : {}),
        ...(address ? { address } : {}),
      });
    },

    async refundPaidInvoices(subscriptionId) {
      const paid = await client.invoices.list({ subscription: subscriptionId, status: "paid", limit: 10 });
      let pence = 0;
      for (const inv of paid.data) {
        if (!inv.id || !inv.amount_paid) continue;
        const payments = await client.invoicePayments.list({ invoice: inv.id });
        for (const p of payments.data) {
          const pi = idOf(p.payment?.payment_intent as string | { id: string } | undefined);
          if (p.status !== "paid" || !pi) continue;
          await client.refunds.create(
            { payment_intent: pi, metadata: { purpose: CLUB_FEE_PURPOSE, reason: "duplicate-or-unwanted" } },
            { idempotencyKey: `club-fee-refund-${inv.id}` },
          );
          pence += inv.amount_paid;
        }
      }
      return pence;
    },

    async retrieveSetupIntentCard(setupIntentId) {
      const si = await client.setupIntents.retrieve(setupIntentId, { expand: ["payment_method"] });
      return cardOf(si.payment_method as string | Stripe.PaymentMethod | null);
    },

    async setDefaultPaymentMethod({ customerId, subscriptionId, paymentMethodId, email, name }) {
      // The Customer's default and its email follow the new card, so
      // receipts go to the new payer (4.5 point 4).
      await client.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
        ...(email ? { email } : {}),
        ...(name ? { name } : {}),
      });
      await client.subscriptions.update(subscriptionId, { default_payment_method: paymentMethodId });
    },

    async payOpenInvoices(subscriptionId) {
      const open = await client.invoices.list({ subscription: subscriptionId, status: "open", limit: 10 });
      let paid = 0;
      for (const inv of open.data) {
        if (!inv.id) continue;
        try {
          await client.invoices.pay(inv.id);
          paid++;
        } catch (err) {
          // A decline is Stripe's to report (invoice.payment_failed).
          console.warn(`[stripe-billing] retrying ${inv.id} on the new card failed:`, (err as Error).message);
        }
      }
      return paid;
    },

    async detachPaymentMethod(paymentMethodId) {
      await client.paymentMethods.detach(paymentMethodId);
    },

    async updateSubscriptionPrice({ subscriptionId, itemId, priceId }) {
      await client.subscriptions.update(subscriptionId, {
        items: [{ id: itemId, price: priceId }],
        proration_behavior: "none",
      });
    },

    async cancelSubscription(subscriptionId) {
      await client.subscriptions.cancel(subscriptionId, { prorate: false });
    },

    async findOrCreateCustomPrice({ productId, pence }) {
      const lookupKey = customPriceLookupKey(pence);
      // Any price holding the key, active or not: a lookup key is unique,
      // so creating a second one would fail. An inactive one is switched back on.
      const found = await client.prices.list({ lookup_keys: [lookupKey], limit: 1 });
      const existing = found.data[0];
      if (existing) {
        if (!existing.active) await client.prices.update(existing.id, { active: true });
        return existing.id;
      }
      const created = await client.prices.create({
        product: productId,
        currency: "gbp",
        unit_amount: pence,
        recurring: { interval: "month" },
        tax_behavior: "inclusive",
        lookup_key: lookupKey,
        metadata: { purpose: CLUB_FEE_PURPOSE },
      });
      return created.id;
    },
  };
}

// ── Which adapter ───────────────────────────────────────────────────────

let override: BillingStripe | null = null;
let real: BillingStripe | null = null;

/** Unit tests only: put a fake in place (null to clear). */
export function setBillingStripeForTests(adapter: BillingStripe | null): void {
  override = adapter;
}

/**
 * The fake is for the e2e suite: it needs MT_TEST_MODE=1 (which nothing
 * sets but e2e/helpers/env.ts) AND BILLING_STRIPE_FAKE=1, and is refused
 * outright if a live key is in the environment.
 */
export function isBillingStripeFake(env: Env = process.env): boolean {
  if (env.MT_TEST_MODE !== "1" || env.BILLING_STRIPE_FAKE !== "1") return false;
  const key = env.STRIPE_SECRET_KEY ?? "";
  return !key.startsWith("sk_live") && !key.startsWith("rk_live");
}

/** The adapter to use, or null when Stripe is not set up. */
export function getBillingStripe(env: Env = process.env): BillingStripe | null {
  if (override) return override;
  if (isBillingStripeFake(env)) return createFakeBillingStripe({ file: env.MT_TEST_BILLING_STRIPE_FILE || null });
  if (!env.STRIPE_SECRET_KEY) return null;
  if (!real) real = createStripeBillingAdapter(new Stripe(env.STRIPE_SECRET_KEY, { typescript: true }));
  return real;
}
