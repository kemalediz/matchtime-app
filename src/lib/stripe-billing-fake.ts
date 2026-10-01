/**
 * CLUB FEE BILLING, slice B3: a FAKE Stripe for tests. Never calls Stripe.
 *
 * Used by the unit tests directly and by the e2e suite through
 * `getBillingStripe()`, which hands it out only with MT_TEST_MODE=1 AND
 * BILLING_STRIPE_FAKE=1 (src/lib/stripe-billing.ts).
 *
 * With `file` set (MT_TEST_BILLING_STRIPE_FILE), its state lives in one
 * JSON file, so the dev server (which creates sessions) and a Playwright
 * spec (which reads the recorded calls and writes the subscription Stripe
 * would hold before posting a signed webhook) share one world across
 * processes. Without a file it is in memory.
 *
 * A Checkout "URL" is the billing page itself with `?fake_checkout=<id>`,
 * so a browser test lands somewhere real.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Stripe from "stripe";
import type { BillingStripe, BillingSubscription, CardDetails } from "./stripe-billing";
import { isLiveSubscriptionStatus } from "./club-billing-rules";

interface StoredSubscription extends Omit<BillingSubscription, "currentPeriodEnd" | "trialEnd"> {
  currentPeriodEnd: string | null;
  trialEnd: string | null;
}

export interface FakeStripeState {
  seq: number;
  calls: Array<{ method: string; args: unknown }>;
  customers: Record<string, { orgId: string; name: string }>;
  sessions: Record<string, { params: Stripe.Checkout.SessionCreateParams; status: "open" | "expired" }>;
  subscriptions: Record<string, StoredSubscription>;
  setupIntents: Record<string, CardDetails>;
  detached: string[];
  prices: Record<string, string>;
  refunds: Array<{ subscriptionId: string; invoiceId: string; pence: number }>;
  /** Paid invoices a test says a subscription has. */
  paidInvoices: Record<string, Array<{ id: string; pence: number; paidAt: string }>>;
}

const empty = (): FakeStripeState => ({
  seq: 0,
  calls: [],
  customers: {},
  sessions: {},
  subscriptions: {},
  setupIntents: {},
  detached: [],
  prices: {},
  refunds: [],
  paidInvoices: {},
});

const toStored = (s: BillingSubscription): StoredSubscription => ({
  ...s,
  currentPeriodEnd: s.currentPeriodEnd ? s.currentPeriodEnd.toISOString() : null,
  trialEnd: s.trialEnd ? s.trialEnd.toISOString() : null,
});

const fromStored = (s: StoredSubscription): BillingSubscription => ({
  ...s,
  currentPeriodEnd: s.currentPeriodEnd ? new Date(s.currentPeriodEnd) : null,
  trialEnd: s.trialEnd ? new Date(s.trialEnd) : null,
});

export type FakeBillingStripe = BillingStripe & {
  state(): FakeStripeState;
  putSubscription(sub: BillingSubscription): void;
  putSetupIntent(id: string, card: CardDetails): void;
  putPaidInvoice(subscriptionId: string, pence: number, paidAt?: Date, invoiceId?: string): void;
};

export function createFakeBillingStripe(opts: { file?: string | null } = {}): FakeBillingStripe {
  const file = opts.file ?? null;
  let mem = empty();

  const load = (): FakeStripeState => {
    if (!file) return mem;
    // turbopackIgnore: the path is a test-only env value; without the hint
    // the build traces the whole project into every route that imports this.
    if (!existsSync(/*turbopackIgnore: true*/ file)) return empty();
    try {
      return { ...empty(), ...(JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as FakeStripeState) };
    } catch {
      return empty();
    }
  };
  const save = (s: FakeStripeState) => {
    if (!file) {
      mem = s;
      return;
    }
    mkdirSync(path.dirname(/*turbopackIgnore: true*/ file), { recursive: true });
    writeFileSync(/*turbopackIgnore: true*/ file, JSON.stringify(s, null, 2));
  };
  /** Read, change, write, and record the call. */
  function tx<T>(method: string, args: unknown, fn: (s: FakeStripeState) => T): T {
    const s = load();
    s.calls.push({ method, args });
    const out = fn(s);
    save(s);
    return out;
  }
  const next = (s: FakeStripeState, prefix: string) => `${prefix}_fake_${++s.seq}`;

  return {
    kind: "fake",

    state: () => load(),

    putSubscription(sub) {
      const s = load();
      s.subscriptions[sub.id] = toStored(sub);
      save(s);
    },

    putPaidInvoice(subscriptionId, pence, paidAt = new Date(), invoiceId) {
      const s = load();
      const list = (s.paidInvoices[subscriptionId] ??= []);
      list.push({ id: invoiceId ?? `in_fake_${subscriptionId}_${list.length + 1}`, pence, paidAt: paidAt.toISOString() });
      save(s);
    },

    putSetupIntent(id, card) {
      const s = load();
      s.setupIntents[id] = card;
      save(s);
    },

    async createCustomer(args) {
      return tx("createCustomer", args, (s) => {
        const existing = Object.entries(s.customers).find(([, c]) => c.orgId === args.orgId);
        if (existing) return { id: existing[0] };
        const id = next(s, "cus");
        s.customers[id] = { orgId: args.orgId, name: args.name };
        return { id };
      });
    },

    async expireOpenCheckoutSessions(customerId) {
      return tx("expireOpenCheckoutSessions", { customerId }, (s) => {
        let n = 0;
        for (const sess of Object.values(s.sessions)) {
          if (sess.status === "open" && sess.params.customer === customerId) {
            sess.status = "expired";
            n++;
          }
        }
        return n;
      });
    },

    async createCheckoutSession(params) {
      return tx("createCheckoutSession", params, (s) => {
        const id = next(s, "cs");
        s.sessions[id] = { params, status: "open" };
        const back = params.cancel_url ?? "/";
        return { id, url: `${back}${back.includes("?") ? "&" : "?"}fake_checkout=${id}` };
      });
    },

    async createPortalSession(args) {
      return tx("createPortalSession", args, () => ({ url: `${args.returnUrl}?fake_portal=1` }));
    },

    async retrieveSubscription(id) {
      const sub = tx("retrieveSubscription", { id }, (s) => s.subscriptions[id] ?? null);
      if (!sub) throw new Error(`No such subscription: '${id}'`);
      return fromStored(sub);
    },

    async retrieveSetupIntentCard(setupIntentId) {
      return tx("retrieveSetupIntentCard", { setupIntentId }, (s) => s.setupIntents[setupIntentId] ?? null);
    },

    async setDefaultPaymentMethod(args) {
      tx("setDefaultPaymentMethod", args, (s) => {
        const sub = s.subscriptions[args.subscriptionId];
        const card = Object.values(s.setupIntents).find((c) => c.paymentMethodId === args.paymentMethodId);
        if (sub) sub.card = card ?? { paymentMethodId: args.paymentMethodId, brand: null, last4: null, country: null };
      });
    },

    async payOpenInvoices(subscriptionId) {
      return tx("payOpenInvoices", { subscriptionId }, () => 0);
    },

    async detachPaymentMethod(paymentMethodId) {
      tx("detachPaymentMethod", { paymentMethodId }, (s) => {
        s.detached.push(paymentMethodId);
        for (const sub of Object.values(s.subscriptions)) {
          if (sub.card?.paymentMethodId === paymentMethodId) sub.card = null;
        }
      });
    },

    async updateSubscriptionPrice(args) {
      tx("updateSubscriptionPrice", args, (s) => {
        const sub = s.subscriptions[args.subscriptionId];
        if (sub) sub.priceId = args.priceId;
      });
    },

    async cancelSubscription(subscriptionId, opts = {}) {
      tx("cancelSubscription", opts.reason ? { subscriptionId, reason: opts.reason } : { subscriptionId }, (s) => {
        const sub = s.subscriptions[subscriptionId];
        if (sub) {
          sub.status = "canceled";
          if (opts.reason === "suspend") sub.metadata = { ...sub.metadata, cancelledBy: "suspend" };
        }
      });
    },

    async setCancelAtPeriodEnd(subscriptionId, cancel) {
      tx("setCancelAtPeriodEnd", { subscriptionId, cancel }, (s) => {
        const sub = s.subscriptions[subscriptionId];
        if (sub) sub.cancelAtPeriodEnd = cancel;
      });
    },

    async listLiveSubscriptions(customerId) {
      return tx("listLiveSubscriptions", { customerId }, (s) =>
        Object.values(s.subscriptions)
          .filter((x) => x.customerId === customerId && isLiveSubscriptionStatus(x.status) && x.metadata.purpose === "club-fee")
          .map(fromStored),
      );
    },

    async resetCustomerDetails(args) {
      tx("resetCustomerDetails", args, () => undefined);
    },

    async updateCustomer(args) {
      tx("updateCustomer", args, () => undefined);
    },

    async refundPaidInvoices(subscriptionId, opts = {}) {
      return tx("refundPaidInvoices", { subscriptionId, paidAfter: opts.paidAfter ? opts.paidAfter.toISOString() : null }, (s) => {
        let pence = 0;
        const invoiceIds: string[] = [];
        for (const inv of s.paidInvoices[subscriptionId] ?? []) {
          if (opts.paidAfter && new Date(inv.paidAt) < opts.paidAfter) continue;
          if (!s.refunds.some((r) => r.invoiceId === inv.id)) s.refunds.push({ subscriptionId, invoiceId: inv.id, pence: inv.pence });
          pence += inv.pence;
          invoiceIds.push(inv.id);
        }
        return { pence, invoiceIds };
      });
    },

    async findOrCreateCustomPrice(args) {
      return tx("findOrCreateCustomPrice", args, (s) => {
        const key = `club_monthly_${args.pence}`;
        if (!s.prices[key]) s.prices[key] = `price_fake_${args.pence}`;
        return s.prices[key];
      });
    },
  };
}
