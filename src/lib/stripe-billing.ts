/**
 * CLUB FEE BILLING: MatchTime's own Stripe calls for the club fee, on the
 * PLATFORM account (slice B3, rewritten for games played in slice P2).
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 2 and 5.
 *
 * ── Kept apart from match fees ───────────────────────────────────────
 * Match fees (src/lib/stripe.ts) are Connect DIRECT charges on each money
 * collector's connected account, verified by the Connect webhook with
 * STRIPE_WEBHOOK_SECRET. The club fee is MatchTime's own money: no
 * `stripeAccount`, no application fee, no transfer, its own webhook
 * (/api/stripe/billing-webhook) and its own secret
 * (STRIPE_BILLING_WEBHOOK_SECRET). Every session, Customer, invoice and
 * invoice item carries `purpose: "club-fee"` and never `matchId` or
 * `userId`, so even a misrouted event is ignored by the Connect side's
 * `applyCheckoutEvent`.
 *
 * ── What it does (P2, plan 5.1 option b) ─────────────────────────────
 * No subscription, no Portal, no price objects. The card is saved with
 * Checkout in SETUP mode (nothing charged). After each billing month the
 * month close (club-billing-months.ts) charges ONE invoice for the games
 * played: a draft invoice, one item for the exact pence (tax INCLUSIVE
 * under the club product, with the 20% VAT Tax Rate), finalised, then
 * paid on the card on file. Each create carries an idempotency key per
 * club month, and a month's invoice can be found again by its metadata.
 *
 * ── Shape ────────────────────────────────────────────────────────────
 *   - pure builders (tested field by field);
 *   - `BillingStripe`, the calls billing makes, in plain fields, so the
 *     rest of the code never depends on Stripe's API version shapes;
 *   - the real adapter over the Stripe client (same STRIPE_SECRET_KEY as
 *     match fees: one platform account);
 *   - `getBillingStripe()`: a test override, else the fake (only with
 *     MT_TEST_MODE=1 AND BILLING_STRIPE_FAKE=1 AND no live key), else the
 *     real adapter when STRIPE_SECRET_KEY is set, else null ("not set up").
 *
 * Nothing here reads or writes the database.
 */
import Stripe from "stripe";
import { STRIPE_MIN_CHARGE_PENCE } from "./club-billing-cycle-rules";
import { createFakeBillingStripe } from "./stripe-billing-fake";

type Env = Record<string, string | undefined>;

/** The one marker on every club fee session, Customer and invoice. */
export const CLUB_FEE_PURPOSE = "club-fee";

// ── Plain shapes ────────────────────────────────────────────────────────

export interface CardDetails {
  paymentMethodId: string;
  brand: string | null;
  last4: string | null;
  /** The card's issuing country (ISO alpha-2). */
  country: string | null;
}

/** One invoice, as billing reads it. */
export interface BillingInvoice {
  id: string;
  /** Stripe's word: draft, open, paid, uncollectible, void. */
  status: string | null;
  hostedInvoiceUrl: string | null;
  /** The invoice total in pence (VAT inclusive, so the amount charged). */
  totalPence?: number | null;
  /** What Stripe will actually try to take (after any customer credit). */
  amountDuePence?: number | null;
  customerId?: string | null;
  metadata?: Record<string, string>;
}

/** What a month's invoice is made from. */
export interface MonthInvoiceArgs {
  orgId: string;
  monthId: string;
  customerId: string;
  /** "MatchTime club fee, {club}, {from} to {to}: {played} of {scheduled} games played". */
  description: string;
}

export interface MonthInvoiceItemArgs extends MonthInvoiceArgs {
  invoiceId: string;
  amountPence: number;
  productId: string;
  taxRateId: string;
}

export type VoidOutcome = "voided" | "deleted" | "already-void" | "paid" | "not-found";

/** A Tax Rate as the close checks it (M4). */
export interface BillingTaxRate {
  id: string;
  inclusive: boolean;
  percentage: number;
  active: boolean;
}

/** The calls club fee billing makes. Real or fake, same contract. */
export interface BillingStripe {
  readonly kind: "stripe" | "fake";
  createCustomer(args: { orgId: string; name: string }): Promise<{ id: string }>;
  /** Expire the club fee Checkout sessions still open on this Customer. */
  expireOpenCheckoutSessions(customerId: string): Promise<number>;
  createCheckoutSession(params: Stripe.Checkout.SessionCreateParams): Promise<{ id: string; url: string }>;
  /** The card a completed setup-mode session saved. */
  retrieveSetupIntentCard(setupIntentId: string): Promise<CardDetails | null>;
  /** The card becomes the Customer's default for invoices; the payer's
   *  email and name go on too, so receipts reach them (4.5 point 4). */
  setDefaultPaymentMethod(args: { customerId: string; paymentMethodId: string; email?: string | null; name?: string | null }): Promise<void>;
  detachPaymentMethod(paymentMethodId: string): Promise<void>;
  /** Before a NEW payer's card goes on the club's shared Customer: back to
   *  the club's name, no email, no address, no phone, no VAT numbers. */
  resetCustomerDetails(args: { customerId: string; name: string }): Promise<void>;
  /** The payer's own details onto the Customer (for invoices and receipts). */
  updateCustomer(args: {
    customerId: string;
    email?: string | null;
    name?: string | null;
    address?: Stripe.AddressParam | null;
  }): Promise<void>;
  /** One invoice, or null when Stripe has no such invoice. */
  retrieveInvoice(invoiceId: string): Promise<BillingInvoice | null>;
  /** The VAT Tax Rate, or null when Stripe has no such rate (M4). */
  retrieveTaxRate(taxRateId: string): Promise<BillingTaxRate | null>;
  /** The club fee invoices carrying this month's id (search by metadata). */
  findMonthInvoices(monthId: string): Promise<BillingInvoice[]>;
  /** A DRAFT invoice for the month (idempotency key per month). */
  createMonthInvoice(args: MonthInvoiceArgs): Promise<BillingInvoice>;
  /** The month's one item on that draft (idempotency key per month). */
  addMonthInvoiceItem(args: MonthInvoiceItemArgs): Promise<void>;
  /** Finalise a draft (auto-advance on, so Stripe's automatic collection
   *  takes over); an invoice already finalised is returned as it is. */
  finalizeInvoice(invoiceId: string): Promise<BillingInvoice>;
  /** Try to take the payment now. A decline is NOT an error: `declined`
   *  is true and the invoice stays open (Stripe sends payment_failed). */
  payInvoice(invoiceId: string, opts?: { paymentMethodId?: string | null }): Promise<{ invoice: BillingInvoice; declined: boolean }>;
  /** Forgive an unpaid invoice: a draft is deleted, an open or
   *  uncollectible one voided; a paid one is left alone ("paid"). */
  voidInvoice(invoiceId: string): Promise<VoidOutcome>;
}

// ── Configuration ───────────────────────────────────────────────────────

export interface BillingStripeConfig {
  /** STRIPE_CLUB_PRODUCT_ID: "MatchTime club", every month's item is made
   *  under it (5.2). Required. */
  productId: string | null;
  /** STRIPE_CLUB_TAX_RATE_ID: 20% UK VAT, INCLUSIVE. Required. */
  taxRateId: string | null;
  /** STRIPE_BILLING_WEBHOOK_SECRET: the platform-scoped endpoint's secret. */
  webhookSecret: string | null;
  /** What saving a card or charging a month cannot do without. (The
   *  retired STRIPE_CLUB_PRICE_ID and STRIPE_CLUB_PORTAL_CONFIG_ID are not
   *  read any more.) */
  missing: string[];
}

const val = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

export function billingStripeConfig(env: Env = process.env): BillingStripeConfig {
  const productId = val(env.STRIPE_CLUB_PRODUCT_ID);
  const taxRateId = val(env.STRIPE_CLUB_TAX_RATE_ID);
  const missing: string[] = [];
  if (!productId) missing.push("STRIPE_CLUB_PRODUCT_ID");
  if (!taxRateId) missing.push("STRIPE_CLUB_TAX_RATE_ID");
  return { productId, taxRateId, webhookSecret: val(env.STRIPE_BILLING_WEBHOOK_SECRET), missing };
}

// ── Pure builders ───────────────────────────────────────────────────────

const billingPath = (orgId: string) => `/billing/${encodeURIComponent(orgId)}`;

/**
 * Add a card, Use my card instead, Change card, Update card and pay (5.3):
 * Checkout in SETUP mode on the club's one Customer. Nothing is charged;
 * the webhook makes the saved card the Customer's default. A billing
 * address is required (the UK check reads it). No VAT number is asked for:
 * whether Checkout allows `tax_id_collection` in setup mode is to be
 * confirmed in test mode, and a business payer can have Kemal add theirs to
 * the Customer meanwhile.
 */
export function buildCardSetupCheckoutParams(args: {
  orgId: string;
  payerUserId: string;
  customerId: string;
  baseUrl: string;
  action: "add-card" | "replace-card";
}): Stripe.Checkout.SessionCreateParams {
  const base = args.baseUrl.replace(/\/$/, "");
  const metadata = { orgId: args.orgId, payerUserId: args.payerUserId, purpose: CLUB_FEE_PURPOSE, action: args.action };
  return {
    mode: "setup",
    customer: args.customerId,
    client_reference_id: args.orgId,
    currency: "gbp",
    payment_method_types: ["card"],
    metadata,
    setup_intent_data: { metadata: { ...metadata } },
    billing_address_collection: "required",
    success_url: `${base}${billingPath(args.orgId)}?${args.action === "add-card" ? "done" : "replaced"}=1`,
    cancel_url: `${base}${billingPath(args.orgId)}`,
  };
}

const monthMetadata = (a: { orgId: string; monthId: string }) => ({ orgId: a.orgId, purpose: CLUB_FEE_PURPOSE, monthId: a.monthId });

/**
 * The month's invoice (5.3 step 1). A DRAFT that Stripe never finalises on
 * its own (`auto_advance: false`): the close adds the item, checks the
 * total and only then finalises it. Charged automatically on the
 * Customer's default card; pending items are never swept onto it.
 */
export function buildMonthInvoiceParams(a: MonthInvoiceArgs): { params: Stripe.InvoiceCreateParams; idempotencyKey: string } {
  return {
    params: {
      customer: a.customerId,
      collection_method: "charge_automatically",
      auto_advance: false,
      pending_invoice_items_behavior: "exclude",
      currency: "gbp",
      description: a.description,
      metadata: monthMetadata(a),
    },
    idempotencyKey: `club-fee-invoice-${a.monthId}`,
  };
}

/**
 * The month's one item (5.3 step 2): the exact pence under the club
 * product, with the 20% VAT Tax Rate (inclusive by its own setting), on
 * that draft. Refuses
 * anything but whole pence of at least Stripe's 30p minimum.
 */
export function buildMonthInvoiceItemParams(a: MonthInvoiceItemArgs): { params: Stripe.InvoiceItemCreateParams; idempotencyKey: string } {
  if (!Number.isInteger(a.amountPence) || a.amountPence < STRIPE_MIN_CHARGE_PENCE) {
    throw new Error(`[stripe-billing] month ${a.monthId}: ${a.amountPence} is not a chargeable amount in pence`);
  }
  return {
    params: {
      customer: a.customerId,
      invoice: a.invoiceId,
      // No `tax_behavior` here (P2 review, M4): that field belongs to Stripe
      // Tax. With a manual tax rate, the RATE's own `inclusive` flag decides
      // whether VAT is inside the amount, and the month close checks that
      // flag (and 20%) before any invoice is made, then checks the total.
      price_data: { currency: "gbp", product: a.productId, unit_amount: a.amountPence },
      quantity: 1,
      tax_rates: [a.taxRateId],
      description: a.description,
      metadata: monthMetadata(a),
    },
    idempotencyKey: `club-fee-item-${a.monthId}`,
  };
}

/** Stripe search query for a month's invoices. Month ids are cuids; any
 *  other shape is refused rather than quoted into a query. */
export function monthInvoiceSearchQuery(monthId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(monthId)) throw new Error(`[stripe-billing] not a month id: ${monthId}`);
  return `metadata['monthId']:'${monthId}'`;
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

function cardOf(pm: string | Stripe.PaymentMethod | null | undefined): CardDetails | null {
  if (!pm || typeof pm === "string") return pm ? { paymentMethodId: pm, brand: null, last4: null, country: null } : null;
  return {
    paymentMethodId: pm.id,
    brand: pm.card?.brand ?? null,
    last4: pm.card?.last4 ?? null,
    country: pm.card?.country ?? null,
  };
}

function invoiceOf(inv: Stripe.Invoice): BillingInvoice {
  return {
    id: inv.id ?? "",
    status: inv.status ?? null,
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    totalPence: typeof inv.total === "number" ? inv.total : null,
    amountDuePence: typeof inv.amount_due === "number" ? inv.amount_due : null,
    customerId: idOf(inv.customer as string | { id: string } | null),
    metadata: { ...((inv.metadata ?? {}) as Record<string, string>) },
  };
}

/** A card problem Stripe reports when an off-session payment fails: a
 *  decline, a bank check (3DS) needed, an expired card. */
function isCardProblem(err: unknown): boolean {
  const e = err as { type?: string; code?: string };
  return e?.type === "StripeCardError" || /declin|authenticat|requires_action|expired_card|insufficient_funds|incorrect_|card_/.test(e?.code ?? "");
}

/** The real adapter over a Stripe client (the platform account). */
export function createStripeBillingAdapter(client: Stripe): BillingStripe {
  async function retrieve(invoiceId: string): Promise<BillingInvoice | null> {
    try {
      return invoiceOf(await client.invoices.retrieve(invoiceId));
    } catch (err) {
      if ((err as { code?: string }).code === "resource_missing") return null;
      throw err;
    }
  }

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

    async retrieveSetupIntentCard(setupIntentId) {
      const si = await client.setupIntents.retrieve(setupIntentId, { expand: ["payment_method"] });
      return cardOf(si.payment_method as string | Stripe.PaymentMethod | null);
    },

    async setDefaultPaymentMethod({ customerId, paymentMethodId, email, name }) {
      await client.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
        ...(email ? { email } : {}),
        ...(name ? { name } : {}),
      });
    },

    async detachPaymentMethod(paymentMethodId) {
      await client.paymentMethods.detach(paymentMethodId);
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

    retrieveInvoice: retrieve,

    async retrieveTaxRate(taxRateId) {
      try {
        const r = await client.taxRates.retrieve(taxRateId);
        return { id: r.id, inclusive: !!r.inclusive, percentage: r.percentage, active: !!r.active };
      } catch (err) {
        if ((err as { code?: string }).code === "resource_missing") return null;
        throw err;
      }
    },

    async findMonthInvoices(monthId) {
      const found = await client.invoices.search({ query: monthInvoiceSearchQuery(monthId), limit: 10 });
      return found.data
        .map(invoiceOf)
        .filter((i) => i.metadata?.purpose === CLUB_FEE_PURPOSE && i.metadata?.monthId === monthId);
    },

    async createMonthInvoice(args) {
      const { params, idempotencyKey } = buildMonthInvoiceParams(args);
      return invoiceOf(await client.invoices.create(params, { idempotencyKey }));
    },

    async addMonthInvoiceItem(args) {
      const { params, idempotencyKey } = buildMonthInvoiceItemParams(args);
      await client.invoiceItems.create(params, { idempotencyKey });
    },

    async finalizeInvoice(invoiceId) {
      const current = await retrieve(invoiceId);
      if (!current) throw new Error(`[stripe-billing] no invoice ${invoiceId} to finalise`);
      if (current.status !== "draft") return current;
      return invoiceOf(await client.invoices.finalizeInvoice(invoiceId, { auto_advance: true }));
    },

    async payInvoice(invoiceId, opts = {}) {
      try {
        const inv = invoiceOf(await client.invoices.pay(invoiceId, opts.paymentMethodId ? { payment_method: opts.paymentMethodId } : {}));
        return { invoice: inv, declined: inv.status !== "paid" };
      } catch (err) {
        // Paid meanwhile (Stripe's own attempt, a retry): done.
        const now = await retrieve(invoiceId);
        if (now?.status === "paid") return { invoice: now, declined: false };
        if (now && isCardProblem(err)) {
          console.warn(`[stripe-billing] ${invoiceId}: payment not taken (${(err as Error).message}); Stripe reports it`);
          return { invoice: now, declined: true };
        }
        throw err;
      }
    },

    async voidInvoice(invoiceId) {
      const inv = await retrieve(invoiceId);
      if (!inv) return "not-found";
      if (inv.status === "paid") return "paid";
      if (inv.status === "void") return "already-void";
      if (inv.status === "draft") {
        await client.invoices.del(invoiceId);
        return "deleted";
      }
      await client.invoices.voidInvoice(invoiceId);
      return "voided";
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
