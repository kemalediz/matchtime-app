/**
 * CLUB FEE BILLING: a FAKE Stripe for tests (slice B3, rewritten for games
 * played in slice P2). Never calls Stripe.
 *
 * Used by the unit tests directly and by the e2e suite through
 * `getBillingStripe()`, which hands it out only with MT_TEST_MODE=1 AND
 * BILLING_STRIPE_FAKE=1 (src/lib/stripe-billing.ts).
 *
 * With `file` set (MT_TEST_BILLING_STRIPE_FILE), its state lives in one
 * JSON file, so the dev server (which creates sessions and invoices) and a
 * Playwright spec (which reads the recorded calls and writes what Stripe
 * would hold before posting a signed webhook) share one world across
 * processes. Without a file it is in memory.
 *
 * It behaves like Stripe where money safety depends on it:
 *   - an idempotency key returns the SAME object, and the same key with
 *     different parameters is REFUSED;
 *   - a draft is never finalised on its own; finalising and paying follow
 *     Stripe's order (draft, open, paid), and paying a draft is refused;
 *   - a decline leaves the invoice open (`setPayOutcome`);
 *   - a Tax Rate id containing "exclusive" adds 20% on top, so a
 *     misconfigured rate shows up as a different total.
 *
 * A Checkout "URL" is the billing page itself with `?fake_checkout=<id>`,
 * so a browser test lands somewhere real.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Stripe from "stripe";
import {
  buildMonthInvoiceItemParams,
  buildMonthInvoiceParams,
  type BillingInvoice,
  type BillingStripe,
  type CardDetails,
  type VoidOutcome,
} from "./stripe-billing";

export type FakePayOutcome = "succeed" | "decline" | "action";

export interface FakeInvoice {
  id: string;
  customerId: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible" | "deleted";
  metadata: Record<string, string>;
  totalPence: number;
  hostedInvoiceUrl: string;
  params: Stripe.InvoiceCreateParams;
  items: Stripe.InvoiceItemCreateParams[];
  payAttempts: Array<{ paymentMethodId: string | null; outcome: FakePayOutcome | "no-card" }>;
}

export interface FakeStripeState {
  seq: number;
  calls: Array<{ method: string; args: unknown }>;
  customers: Record<string, { orgId: string; name: string; defaultPaymentMethod?: string | null; balancePence?: number }>;
  sessions: Record<string, { params: Stripe.Checkout.SessionCreateParams; status: "open" | "expired" }>;
  setupIntents: Record<string, CardDetails>;
  detached: string[];
  invoices: Record<string, FakeInvoice | BillingInvoice>;
  /** idempotency key -> { object id, the parameters it was first used with }. */
  idempotency: Record<string, { id: string; params: string }>;
  /** A card's outcome when charged ("*" for every card); default succeed. */
  payOutcomes: Record<string, FakePayOutcome>;
}

const empty = (): FakeStripeState => ({
  seq: 0,
  calls: [],
  customers: {},
  sessions: {},
  setupIntents: {},
  detached: [],
  invoices: {},
  idempotency: {},
  payOutcomes: {},
});

export type FakeBillingStripe = BillingStripe & {
  state(): FakeStripeState;
  putSetupIntent(id: string, card: CardDetails): void;
  /** An invoice a test says exists (as Stripe would hold it). */
  putInvoice(invoice: BillingInvoice): void;
  setPayOutcome(paymentMethodId: string | "*", outcome: FakePayOutcome): void;
  /** Stripe forgets idempotency keys after 24 hours. */
  forgetIdempotencyKeys(): void;
  /** A customer credit balance: Stripe takes it off amount_due. */
  putCustomerBalance(customerId: string, pence: number): void;
};

const isFull = (inv: FakeInvoice | BillingInvoice | undefined): inv is FakeInvoice => !!inv && "items" in inv;

function view(inv: FakeInvoice | BillingInvoice, balancePence = 0): BillingInvoice {
  if (!isFull(inv)) return { ...inv };
  return {
    id: inv.id,
    status: inv.status,
    hostedInvoiceUrl: inv.hostedInvoiceUrl,
    totalPence: inv.totalPence,
    amountDuePence: inv.status === "paid" || inv.status === "void" ? 0 : Math.max(0, inv.totalPence - balancePence),
    customerId: inv.customerId,
    metadata: { ...inv.metadata },
  };
}

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
  /** Read, change, write, and record the call. A throw still records it. */
  function tx<T>(method: string, args: unknown, fn: (s: FakeStripeState) => T): T {
    const s = load();
    s.calls.push({ method, args });
    try {
      return fn(s);
    } finally {
      save(s);
    }
  }
  const next = (s: FakeStripeState, prefix: string) => `${prefix}_fake_${++s.seq}`;

  /** Stripe's idempotency: same key, same parameters: the same object. */
  function idempotent(s: FakeStripeState, key: string, params: unknown, create: () => string): string {
    const json = JSON.stringify(params);
    const seen = s.idempotency[key];
    if (seen) {
      if (seen.params !== json) {
        throw Object.assign(new Error(`Keys for idempotent requests can only be used with the same parameters they were first used with (${key})`), {
          type: "StripeIdempotencyError",
        });
      }
      return seen.id;
    }
    const id = create();
    s.idempotency[key] = { id, params: json };
    return id;
  }

  function full(s: FakeStripeState, invoiceId: string): FakeInvoice {
    const inv = s.invoices[invoiceId];
    if (!isFull(inv) || inv.status === "deleted") throw Object.assign(new Error(`No such invoice: '${invoiceId}'`), { code: "resource_missing" });
    return inv;
  }

  return {
    kind: "fake",

    state: () => load(),

    putSetupIntent(id, card) {
      const s = load();
      s.setupIntents[id] = card;
      save(s);
    },

    putInvoice(invoice) {
      const s = load();
      s.invoices[invoice.id] = invoice;
      save(s);
    },

    setPayOutcome(paymentMethodId, outcome) {
      const s = load();
      s.payOutcomes[paymentMethodId] = outcome;
      save(s);
    },

    putCustomerBalance(customerId, pence) {
      const s = load();
      (s.customers[customerId] ??= { orgId: "", name: "" }).balancePence = pence;
      save(s);
    },

    forgetIdempotencyKeys() {
      const s = load();
      s.idempotency = {};
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

    async retrieveSetupIntentCard(setupIntentId) {
      return tx("retrieveSetupIntentCard", { setupIntentId }, (s) => s.setupIntents[setupIntentId] ?? null);
    },

    async setDefaultPaymentMethod(args) {
      tx("setDefaultPaymentMethod", args, (s) => {
        const c = (s.customers[args.customerId] ??= { orgId: "", name: "" });
        c.defaultPaymentMethod = args.paymentMethodId;
      });
    },

    async detachPaymentMethod(paymentMethodId) {
      tx("detachPaymentMethod", { paymentMethodId }, (s) => {
        s.detached.push(paymentMethodId);
        for (const c of Object.values(s.customers)) {
          if (c.defaultPaymentMethod === paymentMethodId) c.defaultPaymentMethod = null;
        }
      });
    },

    async resetCustomerDetails(args) {
      tx("resetCustomerDetails", args, () => undefined);
    },

    async updateCustomer(args) {
      tx("updateCustomer", args, () => undefined);
    },

    async retrieveTaxRate(taxRateId) {
      // A rate id containing "exclusive" stands for a rate set up wrongly.
      return tx("retrieveTaxRate", { taxRateId }, () => ({ id: taxRateId, inclusive: !taxRateId.includes("exclusive"), percentage: 20, active: true }));
    },

    async retrieveInvoice(invoiceId) {
      return tx("retrieveInvoice", { invoiceId }, (s) => {
        const inv = s.invoices[invoiceId];
        if (!inv || (isFull(inv) && inv.status === "deleted")) return null;
        return view(inv, isFull(inv) ? (s.customers[inv.customerId]?.balancePence ?? 0) : 0);
      });
    },

    async findMonthInvoices(monthId) {
      return tx("findMonthInvoices", { monthId }, (s) =>
        Object.values(s.invoices)
          .filter((i) => isFull(i) && i.status !== "deleted" && i.metadata.purpose === "club-fee" && i.metadata.monthId === monthId)
          .map(view),
      );
    },

    async createMonthInvoice(args) {
      return tx("createMonthInvoice", args, (s) => {
        const { params, idempotencyKey } = buildMonthInvoiceParams(args);
        const id = idempotent(s, idempotencyKey, params, () => {
          const invId = next(s, "in");
          s.invoices[invId] = {
            id: invId,
            customerId: args.customerId,
            status: "draft",
            metadata: { ...(params.metadata as Record<string, string>) },
            totalPence: 0,
            hostedInvoiceUrl: `https://invoice.stripe.test/${invId}`,
            params,
            items: [],
            payAttempts: [],
          };
          return invId;
        });
        return view(s.invoices[id]);
      });
    },

    async addMonthInvoiceItem(args) {
      tx("addMonthInvoiceItem", args, (s) => {
        const { params, idempotencyKey } = buildMonthInvoiceItemParams(args);
        idempotent(s, idempotencyKey, params, () => {
          const inv = full(s, args.invoiceId);
          if (inv.status !== "draft") throw new Error(`You can only add invoice items to draft invoices (${inv.id} is ${inv.status})`);
          inv.items.push(params);
          const unit = params.price_data?.unit_amount ?? 0;
          const exclusive = (params.tax_rates ?? []).some((t) => t.includes("exclusive"));
          inv.totalPence += exclusive ? Math.round(unit * 1.2) : unit;
          return next(s, "ii");
        });
      });
    },

    async finalizeInvoice(invoiceId) {
      return tx("finalizeInvoice", { invoiceId }, (s) => {
        const inv = full(s, invoiceId);
        if (inv.status === "draft") inv.status = "open";
        return view(inv);
      });
    },

    async payInvoice(invoiceId, opts = {}) {
      return tx("payInvoice", { invoiceId, paymentMethodId: opts.paymentMethodId ?? null }, (s) => {
        const inv = full(s, invoiceId);
        if (inv.status === "paid") return { invoice: view(inv), declined: false };
        if (inv.status !== "open") throw new Error(`Invoice ${invoiceId} is ${inv.status}; only an open invoice can be paid`);
        const pm = opts.paymentMethodId ?? s.customers[inv.customerId]?.defaultPaymentMethod ?? null;
        const outcome: FakePayOutcome | "no-card" = !pm ? "no-card" : (s.payOutcomes[pm] ?? s.payOutcomes["*"] ?? "succeed");
        inv.payAttempts.push({ paymentMethodId: pm, outcome });
        if (outcome === "succeed") inv.status = "paid";
        return { invoice: view(inv), declined: outcome !== "succeed" };
      });
    },

    async voidInvoice(invoiceId) {
      return tx("voidInvoice", { invoiceId }, (s): VoidOutcome => {
        const inv = s.invoices[invoiceId];
        if (!inv || (isFull(inv) && inv.status === "deleted")) return "not-found";
        if (inv.status === "paid") return "paid";
        if (inv.status === "void") return "already-void";
        if (inv.status === "draft") {
          if (isFull(inv)) inv.status = "deleted";
          else delete s.invoices[invoiceId];
          return "deleted";
        }
        inv.status = "void";
        return "voided";
      });
    },
  };
}
