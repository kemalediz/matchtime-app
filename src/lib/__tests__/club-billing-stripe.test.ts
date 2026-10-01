/**
 * CLUB FEE BILLING, slice B3: the four card actions, the billing webhook's
 * handling, the state sync and plan changes on live subscriptions.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.2, 4.5, 5.2 to 5.4.
 *
 * The database is a small in-memory club; `setBillingState` is replaced by
 * one that applies the REAL pure `nextBillingState` to it (the one writer
 * itself is covered by club-billing.test.ts). Stripe is the fake adapter.
 * No network, no model; DMs are recorded, never sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

type Billing = {
  orgId: string;
  trialStartedAt: Date;
  trialEndsAt: Date;
  graceEndsAt: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeSubscriptionStatus: string | null;
  stripePriceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  stripePaymentMethodId: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  cardHolderUserId: string | null;
  paymentFailedAt: Date | null;
  pausedAt: Date | null;
  pausedReason: string | null;
  billingCountry: string | null;
  cardCountry: string | null;
  vatCountryCheck: boolean;
  resumedAt: Date | null;
};
type Org = {
  id: string;
  name: string;
  language: string;
  billingStatus: string;
  billingPlan: string;
  billingPricePence: number | null;
  approvedAt: Date | null;
  approvalStatus?: string;
};

const h = vi.hoisted(() => {
  const state = {
    org: null as Org | null,
    billing: null as Billing | null,
    events: new Map<string, { id: string; type: string; orgId: string | null; processedAt: Date | null; error: string | null }>(),
    dms: [] as Array<{ orgId: string; kind: string; cycleKey: string; userId: string; text: string; sendAfter?: Date | null }>,
    notices: new Set<string>(),
    contact: "user_colin" as string | null,
    users: {
      user_colin: { name: "Colin" },
      user_pat: { name: "Pat" },
      user_olly: { name: "Olly" },
    } as Record<string, { name: string }>,
    stateCalls: [] as string[],
    pending: [] as Array<{ kind: string; cycleKey: string; createdAt?: Date }>,
    exemptSince: null as Date | null,
    skipped: [] as Array<{ kind: string; cycleKey: string; why: string }>,
    failNextDm: false,
    paymentNotes: [] as Array<Record<string, unknown>>,
    ops: [] as Array<{ kind: string; title: string; dedupeKey?: string | null }>,
    /** Make the next clubBilling.updateMany lose a race (another writer first). */
    raceNextUpdate: null as null | (() => void),
  };
  const matches = (b: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (k === "orgId" ? true : b[k] === v));
  const db = {
    organisation: {
      findUnique: vi.fn(async () => (state.org ? { ...state.org } : null)),
    },
    clubBilling: {
      findUnique: vi.fn(async () => (state.billing ? { ...state.billing } : null)),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.billing && matches(state.billing as unknown as Record<string, unknown>, where) ? { ...state.billing } : null,
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Billing> }) => {
        if (state.raceNextUpdate) {
          const race = state.raceNextUpdate;
          state.raceNextUpdate = null;
          race();
        }
        if (!state.billing || !matches(state.billing as unknown as Record<string, unknown>, where)) return { count: 0 };
        Object.assign(state.billing, data);
        return { count: 1 };
      }),
    },
    billingEvent: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.events.get(where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: { id?: { startsWith?: string }; processedAt?: null; receivedAt?: { lte?: Date } } }) =>
        [...state.events.values()].filter((r) => {
          const row = r as typeof r & { receivedAt?: Date };
          if (where.id?.startsWith && !row.id.startsWith(where.id.startsWith)) return false;
          if (where.processedAt === null && row.processedAt !== null) return false;
          if (where.receivedAt?.lte && (row.receivedAt ?? new Date(0)) > where.receivedAt.lte) return false;
          return true;
        }),
      ),
      create: vi.fn(async ({ data }: { data: { id: string; type: string; orgId?: string | null } }) => {
        if (state.events.has(data.id)) throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        const row = { id: data.id, type: data.type, orgId: data.orgId ?? null, processedAt: null, error: null, receivedAt: new Date() };
        state.events.set(data.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.events.get(where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (state.users[where.id] ? { id: where.id, ...state.users[where.id] } : null)),
    },
  };
  return { state, db };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("../db", () => ({ db: h.db }));
vi.mock("../admin-link", () => ({
  buildAdminLink: vi.fn(async (a: { userId: string; nextPath: string }) => `https://mt.test/r/${a.userId}${a.nextPath}`),
}));
vi.mock("../ops-alerts", () => ({
  BILLING_ALERT_KIND: "club-billing",
  recordOpsEvent: vi.fn(async (a: { kind: string; title: string; dedupeKey?: string | null }) => {
    h.state.ops.push(a);
    return true;
  }),
}));
vi.mock("../club-billing-dms", () => ({
  notePaymentProblem: vi.fn(async (a: Record<string, unknown>) => {
    h.state.paymentNotes.push(a);
    return "pending";
  }),
}));
vi.mock("../club-billing", async () => {
  const rules = await import("../club-billing-rules");
  return {
    setBillingState: vi.fn(async (orgId: string, event: { type: string }, now: Date, opts: { noticeOnResume?: string } = {}) => {
      const o = h.state.org!;
      const b = h.state.billing;
      h.state.stateCalls.push(event.type);
      const t = rules.nextBillingState(
        { approvedAt: o.approvedAt, billingStatus: o.billingStatus, billingPlan: o.billingPlan, billing: b ? { trialEndsAt: b.trialEndsAt, graceEndsAt: b.graceEndsAt, pausedReason: b.pausedReason } : null },
        event as never,
        now,
      );
      if (!t) return { ok: false, reason: "no-change" };
      const from = o.billingStatus;
      o.billingStatus = t.to;
      if (b) {
        if (t.to === "paused") Object.assign(b, { pausedAt: now, pausedReason: t.pausedReason });
        else if (from === "paused") Object.assign(b, { pausedAt: null, pausedReason: null, resumedAt: now });
        if (t.to === "subscribed") Object.assign(b, { graceEndsAt: null, paymentFailedAt: null });
        if (t.graceEndsAt) b.graceEndsAt = t.graceEndsAt;
        if (t.paymentFailedAt) b.paymentFailedAt = t.paymentFailedAt;
      }
      if (t.resumes && opts.noticeOnResume) h.state.pending.push({ kind: opts.noticeOnResume, cycleKey: now.toISOString() });
      return { ok: true, from, to: t.to, resumed: t.resumes };
    }),
    loadBillingContactUserId: vi.fn(async () => h.state.contact),
    loadPendingBillingNotices: vi.fn(async () =>
      h.state.pending
        .filter((p) => !h.state.notices.has(`${h.state.org?.id ?? "org_1"}|${p.kind}|${p.cycleKey}`))
        .map((p) => ({ createdAt: new Date(p.cycleKey), ...p })),
    ),
    loadExemptSince: vi.fn(async () => h.state.exemptSince),
    skipBillingNotice: vi.fn(async (orgId: string, kind: string, cycleKey: string, why: string) => {
      h.state.notices.add(`${orgId}|${kind}|${cycleKey}`);
      h.state.skipped.push({ kind, cycleKey, why });
    }),
    queueBillingDm: vi.fn(
      async (a: { orgId: string; kind: string; cycleKey: string; userId: string; text: (u: { name: string | null }) => string; sendAfter?: Date | null }) => {
        const key = `${a.orgId}|${a.kind}|${a.cycleKey}`;
        if (h.state.notices.has(key)) return "already";
        if (h.state.failNextDm) {
          h.state.failNextDm = false;
          throw new Error("queue failed");
        }
        h.state.notices.add(key);
        h.state.dms.push({ orgId: a.orgId, kind: a.kind, cycleKey: a.cycleKey, userId: a.userId, text: a.text({ name: h.state.users[a.userId]?.name ?? null }), sendAfter: a.sendAfter });
        return "queued";
      },
    ),
  };
});

import { setBillingStripeForTests } from "../stripe-billing";
import { createFakeBillingStripe, type FakeBillingStripe } from "../stripe-billing-fake";
import {
  handleBillingEvent,
  openClubPortal,
  processBillingWebhook,
  removeMyCard,
  startCardReplace,
  startClubCheckout,
  syncPlanToStripe,
  cancelSubscriptionOnSuspend,
  flushPendingBillingNotices,
  sweepOpenRefundIntents,
} from "../club-billing-stripe";
import { applyCheckoutEvent } from "../payment-flow";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const APPROVED = new Date("2026-10-01T09:00:00Z");
const TRIAL_ENDS = new Date(APPROVED.getTime() + 30 * DAY);
const ORG = "org_1";
const ENV = { ...process.env };

let fake: FakeBillingStripe;

function setWorld(org: Partial<Org> = {}, billing: Partial<Billing> = {}) {
  h.state.org = {
    id: ORG,
    name: "Billing Sevens",
    language: "en",
    billingStatus: "trial",
    billingPlan: "standard",
    billingPricePence: null,
    approvedAt: APPROVED,
    ...org,
  };
  h.state.billing = {
    orgId: ORG,
    trialStartedAt: APPROVED,
    trialEndsAt: TRIAL_ENDS,
    graceEndsAt: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    stripePriceId: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    stripePaymentMethodId: null,
    cardBrand: null,
    cardLast4: null,
    cardHolderUserId: null,
    paymentFailedAt: null,
    pausedAt: null,
    pausedReason: null,
    billingCountry: null,
    cardCountry: null,
    vatCountryCheck: false,
    resumedAt: null,
    ...billing,
  };
}

beforeEach(() => {
  process.env.BILLING_ENABLED = "1";
  process.env.STRIPE_CLUB_PRICE_ID = "price_std";
  process.env.STRIPE_CLUB_PRODUCT_ID = "prod_club";
  process.env.STRIPE_CLUB_TAX_RATE_ID = "txr_vat";
  process.env.NEXTAUTH_URL = "https://mt.test";
  fake = createFakeBillingStripe();
  setBillingStripeForTests(fake);
  h.state.events.clear();
  h.state.dms.length = 0;
  h.state.notices.clear();
  h.state.stateCalls.length = 0;
  h.state.contact = "user_colin";
  h.state.pending = [];
  h.state.failNextDm = false;
  h.state.paymentNotes = [];
  h.state.ops = [];
  h.state.raceNextUpdate = null;
  h.state.exemptSince = null;
  h.state.skipped = [];
  process.env.STRIPE_CLUB_PORTAL_CONFIG_ID = "bpc_noinvoices";
  setWorld();
});

afterEach(() => {
  setBillingStripeForTests(null);
  process.env = { ...ENV };
  vi.clearAllMocks();
});

const calls = (method: string) => fake.state().calls.filter((c) => c.method === method).map((c) => c.args as Record<string, unknown>);

function sub(over: Partial<Parameters<FakeBillingStripe["putSubscription"]>[0]> = {}) {
  const s = {
    id: "sub_1",
    status: "trialing",
    customerId: h.state.billing?.stripeCustomerId ?? "cus_fake_1",
    metadata: { orgId: ORG, purpose: "club-fee", payerUserId: "user_colin" },
    cancelAtPeriodEnd: false,
    currentPeriodEnd: TRIAL_ENDS,
    trialEnd: TRIAL_ENDS,
    priceId: "price_std",
    itemId: "si_1",
    card: { paymentMethodId: "pm_colin", brand: "visa", last4: "4242", country: "GB" },
    ...over,
  };
  fake.putSubscription(s);
  return s;
}

let evtSeq = 0;
function event(type: string, object: Record<string, unknown>, created = Math.floor(Date.now() / 1000)): Stripe.Event {
  return { id: `evt_${++evtSeq}`, object: "event", type, created, data: { object } } as unknown as Stripe.Event;
}

function checkoutCompleted(over: Record<string, unknown> = {}) {
  return event("checkout.session.completed", {
    id: "cs_1",
    object: "checkout.session",
    mode: "subscription",
    customer: h.state.billing?.stripeCustomerId ?? "cus_fake_1",
    subscription: "sub_1",
    created: Math.floor(APPROVED.getTime() / 1000) + 20 * 86400,
    metadata: { orgId: ORG, payerUserId: "user_colin", purpose: "club-fee", action: "add-card" },
    customer_details: { email: "colin@example.test", name: "Colin", address: { country: "GB" } },
    ...over,
  });
}

// ── Add a card ───────────────────────────────────────────────────────────

describe("Add a card: startClubCheckout", () => {
  const now = new Date(APPROVED.getTime() + 21 * DAY);

  it("creates the club's Customer once and reuses it", async () => {
    const r1 = await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now });
    expect(r1).toMatchObject({ ok: true });
    const customer = h.state.billing!.stripeCustomerId;
    expect(customer).toMatch(/^cus_fake_/);
    await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now });
    expect(calls("createCustomer")).toHaveLength(1);
    expect(calls("createCheckoutSession").map((p) => p.customer)).toEqual([customer, customer]);
  });

  it("expires the club's open sessions before making a new one (two tabs never both subscribe)", async () => {
    setWorld({}, { stripeCustomerId: "cus_x" });
    await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now });
    // Stripe is asked for live subscriptions first (review fix 5), the new
    // payer gets a clean Customer (fix 4), then open sessions expire.
    expect(fake.state().calls.map((c) => c.method)).toEqual([
      "listLiveSubscriptions",
      "resetCustomerDetails",
      "expireOpenCheckoutSessions",
      "createCheckoutSession",
    ]);
  });

  it("in trial: trial_end is the free month's end on day 21", async () => {
    const r = await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now });
    const p = calls("createCheckoutSession")[0] as unknown as Stripe.Checkout.SessionCreateParams;
    expect(p.subscription_data?.trial_end).toBe(Math.floor(TRIAL_ENDS.getTime() / 1000));
    expect(r).toEqual({ ok: true, url: expect.stringContaining(`/billing/${ORG}?fake_checkout=`) });
  });

  it("in trial on day 29: trial_end pushed to now + 49h", async () => {
    const day29 = new Date(TRIAL_ENDS.getTime() - 24 * HOUR);
    await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now: day29 });
    const p = calls("createCheckoutSession")[0] as unknown as Stripe.Checkout.SessionCreateParams;
    expect(p.subscription_data?.trial_end).toBe(Math.floor((day29.getTime() + 49 * HOUR) / 1000));
  });

  it("in grace or paused: no trial, the first payment is taken at once", async () => {
    for (const status of ["grace", "paused"]) {
      setWorld({ billingStatus: status });
      fake = createFakeBillingStripe();
      setBillingStripeForTests(fake);
      await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now: new Date(TRIAL_ENDS.getTime() + 2 * DAY) });
      const p = calls("createCheckoutSession")[0] as unknown as Stripe.Checkout.SessionCreateParams;
      expect(p.subscription_data, status).not.toHaveProperty("trial_end");
    }
  });

  it("carries the tax rate, required billing address, VAT number collection and the club-fee metadata only", async () => {
    await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now });
    const p = calls("createCheckoutSession")[0] as unknown as Stripe.Checkout.SessionCreateParams;
    expect(p.subscription_data?.default_tax_rates).toEqual(["txr_vat"]);
    expect(p.billing_address_collection).toBe("required");
    expect(p.tax_id_collection).toEqual({ enabled: true });
    expect(p.line_items).toEqual([{ price: "price_std", quantity: 1 }]);
    expect(p.metadata).toEqual({ orgId: ORG, payerUserId: "user_colin", purpose: "club-fee", action: "add-card" });
  });

  it("a Custom plan uses its own price (looked up or made once), with the same tax rate", async () => {
    setWorld({ billingPlan: "custom", billingPricePence: 500 });
    await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now });
    const p = calls("createCheckoutSession")[0] as unknown as Stripe.Checkout.SessionCreateParams;
    expect(p.line_items).toEqual([{ price: "price_fake_500", quantity: 1 }]);
    expect(p.subscription_data?.default_tax_rates).toEqual(["txr_vat"]);
    expect(calls("findOrCreateCustomPrice")).toEqual([{ productId: "prod_club", pence: 500 }]);
  });

  it("refuses anyone but the billing contact (viewer, card holder)", async () => {
    for (const role of ["viewer", "card-holder"] as const) {
      expect(await startClubCheckout({ orgId: ORG, userId: "user_olly", role, now })).toEqual({ ok: false, reason: "not-allowed" });
    }
    expect(fake.state().calls).toEqual([]);
  });

  it("refuses a second subscription while one is live", async () => {
    setWorld({ billingStatus: "paused" }, { stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active" });
    expect(await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now })).toEqual({ ok: false, reason: "already-subscribed" });
    expect(fake.state().calls).toEqual([]);
  });

  it("refuses a club that is subscribed, exempt or on Free", async () => {
    for (const org of [{ billingStatus: "subscribed" }, { billingStatus: "past_due" }, { billingStatus: "exempt" }, { billingStatus: "exempt", billingPlan: "free" }]) {
      setWorld(org);
      expect(await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now }), JSON.stringify(org)).toEqual({ ok: false, reason: "not-billable" });
    }
  });

  it("slice B5: a club paused because MatchTime was removed is never offered a card (add MatchTime back first)", async () => {
    // Without the subscription (it ended with the paid month) and with it
    // still running to its end: Add a card would pay for a group MatchTime
    // is not in, and the webhook never resumes a removed club.
    for (const billing of [
      { pausedReason: "removed" },
      { pausedReason: "removed", stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", cancelAtPeriodEnd: true },
      { pausedReason: "removed", stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "past_due", cancelAtPeriodEnd: true },
    ]) {
      setWorld({ billingStatus: "paused" }, billing);
      expect(await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now }), JSON.stringify(billing)).toEqual({
        ok: false,
        reason: "removed-from-group",
      });
    }
    expect(fake.state().calls).toEqual([]);
  });

  it("not set up: no Stripe or no price says so, never a half-made session", async () => {
    delete process.env.STRIPE_CLUB_PRICE_ID;
    expect(await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now })).toEqual({ ok: false, reason: "not-set-up" });
    setBillingStripeForTests(null);
    process.env.STRIPE_CLUB_PRICE_ID = "price_std";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.BILLING_STRIPE_FAKE;
    expect(await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now })).toEqual({ ok: false, reason: "not-set-up" });
  });
});

// ── Use my card instead, Change card or cancel, Remove my card ──────────

describe("Use my card instead: startCardReplace (setup mode)", () => {
  beforeEach(() =>
    setWorld(
      { billingStatus: "subscribed" },
      { stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", stripePaymentMethodId: "pm_colin", cardHolderUserId: "user_colin" },
    ),
  );

  it("the new collector gets a setup session on the same Customer", async () => {
    const r = await startCardReplace({ orgId: ORG, userId: "user_pat", role: "contact" });
    expect(r).toMatchObject({ ok: true });
    const p = calls("createCheckoutSession")[0] as unknown as Stripe.Checkout.SessionCreateParams;
    expect(p).toMatchObject({ mode: "setup", customer: "cus_x", billing_address_collection: "required" });
    expect(p.metadata).toEqual({ orgId: ORG, payerUserId: "user_pat", purpose: "club-fee", action: "replace-card" });
  });

  it("refuses a viewer and a club with no live subscription", async () => {
    expect(await startCardReplace({ orgId: ORG, userId: "user_pat", role: "viewer" })).toEqual({ ok: false, reason: "not-allowed" });
    h.state.billing!.stripeSubscriptionStatus = "canceled";
    expect(await startCardReplace({ orgId: ORG, userId: "user_pat", role: "contact" })).toEqual({ ok: false, reason: "no-subscription" });
  });
});

describe("Change card or cancel: openClubPortal", () => {
  it("opens the Portal for the contact who holds the card, returning to the billing page", async () => {
    setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_x", cardHolderUserId: "user_colin" });
    process.env.STRIPE_CLUB_PORTAL_CONFIG_ID = "bpc_noinvoices";
    expect(await openClubPortal({ orgId: ORG, userId: "user_colin", role: "contact" })).toEqual({ ok: true, url: `https://mt.test/billing/${ORG}?fake_portal=1` });
    expect(calls("createPortalSession")).toEqual([{ customerId: "cus_x", returnUrl: `https://mt.test/billing/${ORG}`, configuration: "bpc_noinvoices" }]);
  });

  it("refuses a contact whose card is not on file (the old collector's card would show), a viewer, a null holder", async () => {
    setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_x", cardHolderUserId: "user_colin" });
    expect(await openClubPortal({ orgId: ORG, userId: "user_pat", role: "contact" })).toEqual({ ok: false, reason: "not-allowed" });
    expect(await openClubPortal({ orgId: ORG, userId: "user_colin", role: "viewer" })).toEqual({ ok: false, reason: "not-allowed" });
    setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: null });
    expect(await openClubPortal({ orgId: ORG, userId: "user_colin", role: "contact" })).toEqual({ ok: false, reason: "no-customer" });
  });
});

describe("Remove my card: removeMyCard", () => {
  beforeEach(() =>
    setWorld(
      { billingStatus: "subscribed" },
      { stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", stripePaymentMethodId: "pm_colin", cardBrand: "visa", cardLast4: "4242", cardHolderUserId: "user_colin" },
    ),
  );

  it("the old card holder detaches their card; the card fields are cleared", async () => {
    expect(await removeMyCard({ orgId: ORG, userId: "user_colin", role: "card-holder" })).toEqual({ ok: true });
    expect(calls("detachPaymentMethod")).toEqual([{ paymentMethodId: "pm_colin" }]);
    expect(h.state.billing).toMatchObject({ stripePaymentMethodId: null, cardBrand: null, cardLast4: null, cardHolderUserId: null });
    expect(h.state.org!.billingStatus).toBe("subscribed");
  });

  it("refuses anyone who is not the card holder role", async () => {
    expect(await removeMyCard({ orgId: ORG, userId: "user_colin", role: "contact" })).toEqual({ ok: false, reason: "not-allowed" });
    expect(await removeMyCard({ orgId: ORG, userId: "user_pat", role: "card-holder" })).toEqual({ ok: false, reason: "not-allowed" });
    expect(calls("detachPaymentMethod")).toEqual([]);
  });
});

// ── The webhook ─────────────────────────────────────────────────────────

describe("processBillingWebhook: BillingEvent idempotency", () => {
  it("records, handles once, and answers a duplicate delivery without handling it again", async () => {
    setWorld({}, { stripeCustomerId: "cus_fake_1" });
    sub();
    const e = checkoutCompleted();
    expect((await processBillingWebhook(e, new Date(APPROVED.getTime() + 21 * DAY))).status).toBe(200);
    expect(h.state.events.get(e.id)).toMatchObject({ type: "checkout.session.completed", orgId: ORG, error: null });
    expect(h.state.events.get(e.id)!.processedAt).toBeInstanceOf(Date);
    const again = await processBillingWebhook(e, new Date(APPROVED.getTime() + 21 * DAY));
    expect(again).toEqual({ status: 200, body: { received: true, duplicate: true } });
    expect(h.state.dms).toHaveLength(1);
  });

  it("a handler error is recorded and answered 500 so Stripe retries; the retry then succeeds", async () => {
    setWorld({}, { stripeCustomerId: "cus_fake_1" });
    const e = checkoutCompleted(); // sub_1 not in Stripe yet: retrieve throws
    const r = await processBillingWebhook(e, new Date(APPROVED.getTime() + 21 * DAY));
    expect(r.status).toBe(500);
    expect(h.state.events.get(e.id)).toMatchObject({ processedAt: null, error: expect.stringContaining("No such subscription") });
    sub();
    expect((await processBillingWebhook(e, new Date(APPROVED.getTime() + 21 * DAY))).status).toBe(200);
    expect(h.state.events.get(e.id)).toMatchObject({ error: null });
    expect(h.state.org!.billingStatus).toBe("subscribed");
  });
});

describe("checkout.session.completed (subscription)", () => {
  const now = new Date(APPROVED.getTime() + 21 * DAY);

  it("trial to subscribed; stores the subscription, card, holder, countries; DMs 'card-added' once to the payer", async () => {
    setWorld({}, { stripeCustomerId: "cus_fake_1" });
    sub();
    const r = await handleBillingEvent(checkoutCompleted(), now);
    expect(r).toMatchObject({ orgId: ORG });
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.billing).toMatchObject({
      stripeSubscriptionId: "sub_1",
      stripeSubscriptionStatus: "trialing",
      stripePriceId: "price_std",
      currentPeriodEnd: TRIAL_ENDS,
      stripePaymentMethodId: "pm_colin",
      cardBrand: "visa",
      cardLast4: "4242",
      cardHolderUserId: "user_colin",
      billingCountry: "GB",
      cardCountry: "GB",
      vatCountryCheck: false,
    });
    expect(h.state.dms).toEqual([
      expect.objectContaining({ kind: "card-added", cycleKey: "sub_1", userId: "user_colin" }),
    ]);
    const text = h.state.dms[0].text;
    expect(text).toContain("Thanks Colin, your card is saved.");
    expect(text).toContain("The first £9.99 is taken on Sat 31 Oct");
    expect(text).toContain(`https://mt.test/r/user_colin/billing/${ORG}`);
    expect(text).not.toMatch(/[—–]/);
    await handleBillingEvent(checkoutCompleted(), now);
    expect(h.state.dms).toHaveLength(1);
  });

  it("a non-GB billing address or card flags vatCountryCheck and KEEPS the subscription", async () => {
    setWorld({}, { stripeCustomerId: "cus_fake_1" });
    sub({ card: { paymentMethodId: "pm_tr", brand: "visa", last4: "1111", country: "TR" } });
    await handleBillingEvent(checkoutCompleted(), now);
    expect(h.state.billing).toMatchObject({ vatCountryCheck: true, cardCountry: "TR", billingCountry: "GB", stripeSubscriptionId: "sub_1" });
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(calls("cancelSubscription")).toEqual([]);
  });

  it("grace: the first payment was taken, 'card-added' says so", async () => {
    setWorld({ billingStatus: "grace" }, { stripeCustomerId: "cus_fake_1", graceEndsAt: new Date(TRIAL_ENDS.getTime() + 7 * DAY) });
    sub({ status: "active", trialEnd: null, currentPeriodEnd: new Date(TRIAL_ENDS.getTime() + 32 * DAY) });
    await handleBillingEvent(checkoutCompleted(), new Date(TRIAL_ENDS.getTime() + 2 * DAY));
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.billing!.graceEndsAt).toBeNull();
    expect(h.state.dms[0].text).toContain("The first £9.99 has been taken today");
  });

  it("paused: resumes, and the one DM says MatchTime is back on", async () => {
    setWorld({ billingStatus: "paused" }, { stripeCustomerId: "cus_fake_1", pausedReason: "no-card", pausedAt: new Date(TRIAL_ENDS.getTime() + 7 * DAY) });
    sub({ status: "active", trialEnd: null });
    await handleBillingEvent(checkoutCompleted(), new Date(TRIAL_ENDS.getTime() + 10 * DAY));
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.dms).toHaveLength(1);
    expect(h.state.dms[0].text).toContain("MatchTime is back on for Billing Sevens");
    expect(h.state.dms[0].text).toContain("should say it again");
  });

  it("an incomplete subscription (payment not through): synced, but no 'card added' DM and no state change", async () => {
    setWorld({ billingStatus: "grace" }, { stripeCustomerId: "cus_fake_1" });
    sub({ status: "incomplete", trialEnd: null });
    await handleBillingEvent(checkoutCompleted(), new Date(TRIAL_ENDS.getTime() + 2 * DAY));
    expect(h.state.org!.billingStatus).toBe("grace");
    expect(h.state.dms).toEqual([]);
  });

  it("ignored without purpose 'club-fee' (a match fee session)", async () => {
    sub();
    const r = await handleBillingEvent(
      checkoutCompleted({ metadata: { matchId: "m1", userId: "u1", quantity: "1" } }),
      now,
    );
    expect(r).toEqual({ action: "ignored", reason: "not-club-fee", orgId: null });
    expect(h.state.org!.billingStatus).toBe("trial");
  });

  it("ignored when the event's Customer is not the club's (never cross-wired)", async () => {
    setWorld({}, { stripeCustomerId: "cus_club" });
    sub({ customerId: "cus_other" });
    const r = await handleBillingEvent(checkoutCompleted({ customer: "cus_other" }), now);
    expect(r).toMatchObject({ action: "ignored", reason: "customer-mismatch" });
    expect(h.state.org!.billingStatus).toBe("trial");
  });

  it("a SECOND live subscription for a club that already has one is cancelled at once, never kept", async () => {
    setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", cardHolderUserId: "user_colin" });
    sub({ id: "sub_1", status: "active" });
    sub({ id: "sub_2", status: "active" });
    const r = await handleBillingEvent(checkoutCompleted({ id: "cs_2", subscription: "sub_2" }), now);
    expect(r).toMatchObject({ action: "duplicate-cancelled" });
    expect(calls("cancelSubscription")).toEqual([{ subscriptionId: "sub_2" }]);
    expect(h.state.billing!.stripeSubscriptionId).toBe("sub_1");
    expect(h.state.dms).toEqual([]);
  });

  it("the Connect side ignores this same session: applyCheckoutEvent sees no matchId", async () => {
    const e = checkoutCompleted();
    const r = await applyCheckoutEvent("checkout.session.completed", e.data.object as Stripe.Checkout.Session);
    expect(r).toEqual({ action: "ignored", reason: "no-metadata" });
  });
});

describe("out-of-order events converge on Stripe's latest truth", () => {
  it("subscription.updated BEFORE checkout.session.completed: subscribed once, card-added once", async () => {
    setWorld({}, { stripeCustomerId: "cus_fake_1" });
    const s = sub();
    const now = new Date(APPROVED.getTime() + 21 * DAY);
    await handleBillingEvent(event("customer.subscription.updated", { id: s.id, object: "subscription", metadata: s.metadata, customer: s.customerId }), now);
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.billing).toMatchObject({ stripeSubscriptionId: "sub_1", cardHolderUserId: "user_colin" });
    expect(h.state.dms).toEqual([]);
    await handleBillingEvent(checkoutCompleted(), now);
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.dms.map((d) => d.kind)).toEqual(["card-added"]);
    expect(h.state.billing!.billingCountry).toBe("GB");
  });

  it("a stale 'past_due' event after the invoice was paid reads the live status (active) and changes nothing", async () => {
    setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active" });
    sub({ status: "active" });
    await handleBillingEvent(event("customer.subscription.updated", { id: "sub_1", object: "subscription", status: "past_due", metadata: { orgId: ORG, purpose: "club-fee" } }), new Date());
    expect(h.state.org!.billingStatus).toBe("subscribed");
  });
});

describe("subscription and invoice events", () => {
  const live = () =>
    setWorld(
      { billingStatus: "subscribed" },
      { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", stripePaymentMethodId: "pm_colin", cardHolderUserId: "user_colin" },
    );
  const invoice = (type: string, over: Record<string, unknown> = {}) =>
    event(type, { id: "in_1", object: "invoice", customer: "cus_fake_1", billing_reason: "subscription_cycle", parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } }, ...over });
  const now = new Date("2026-12-01T12:00:00Z");

  it("invoice.payment_failed: subscribed to past_due, a fresh 7 day grace", async () => {
    live();
    sub({ status: "past_due" });
    await handleBillingEvent(invoice("invoice.payment_failed"), now);
    expect(h.state.org!.billingStatus).toBe("past_due");
    expect(h.state.billing!.graceEndsAt).toEqual(new Date(now.getTime() + 7 * DAY));
    expect(h.state.billing!.paymentFailedAt).toEqual(now);
  });

  it("invoice.paid: past_due back to subscribed, failure fields cleared", async () => {
    live();
    h.state.org!.billingStatus = "past_due";
    h.state.billing!.paymentFailedAt = now;
    sub({ status: "active" });
    await handleBillingEvent(invoice("invoice.paid"), now);
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.billing).toMatchObject({ paymentFailedAt: null, graceEndsAt: null });
  });

  it("invoice.paid on a club paused for a failed payment: resumes, DMs 'resumed' once to the contact", async () => {
    live();
    Object.assign(h.state.org!, { billingStatus: "paused" });
    Object.assign(h.state.billing!, { pausedReason: "payment-failed" });
    sub({ status: "active" });
    await handleBillingEvent(invoice("invoice.paid"), now);
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.dms).toEqual([expect.objectContaining({ kind: "resumed", userId: "user_colin" })]);
    expect(h.state.dms[0].text).toContain("MatchTime is back on for Billing Sevens");
  });

  it("subscription status unpaid on a past due club: paused (payment-failed)", async () => {
    live();
    h.state.org!.billingStatus = "past_due";
    sub({ status: "unpaid" });
    await handleBillingEvent(event("customer.subscription.updated", { id: "sub_1", object: "subscription", metadata: { orgId: ORG, purpose: "club-fee" } }), now);
    expect(h.state.org!.billingStatus).toBe("paused");
    expect(h.state.billing!.pausedReason).toBe("payment-failed");
  });

  it("customer.subscription.deleted after a cancel: paused (cancelled)", async () => {
    live();
    h.state.billing!.cancelAtPeriodEnd = true;
    sub({ status: "canceled", cancelAtPeriodEnd: true });
    await handleBillingEvent(event("customer.subscription.deleted", { id: "sub_1", object: "subscription", metadata: { orgId: ORG, purpose: "club-fee" } }), now);
    expect(h.state.org!.billingStatus).toBe("paused");
    expect(h.state.billing!.pausedReason).toBe("cancelled");
    expect(h.state.billing!.stripeSubscriptionStatus).toBe("canceled");
  });

  it("customer.subscription.deleted when Stripe gave up: paused (payment-failed)", async () => {
    live();
    h.state.org!.billingStatus = "past_due";
    sub({ status: "canceled" });
    await handleBillingEvent(event("customer.subscription.deleted", { id: "sub_1", object: "subscription", metadata: { orgId: ORG, purpose: "club-fee" } }), now);
    expect(h.state.org!.billingStatus).toBe("paused");
    expect(h.state.billing!.pausedReason).toBe("payment-failed");
  });

  it("a cancel in the Portal: cancelAtPeriodEnd stored, still subscribed, no DM", async () => {
    live();
    sub({ status: "active", cancelAtPeriodEnd: true });
    await handleBillingEvent(event("customer.subscription.updated", { id: "sub_1", object: "subscription", metadata: { orgId: ORG, purpose: "club-fee" } }), now);
    expect(h.state.billing!.cancelAtPeriodEnd).toBe(true);
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.dms).toEqual([]);
  });

  it("a subscription without purpose 'club-fee' (on Stripe's fresh copy) is ignored, whatever the event's copy says", async () => {
    live();
    sub({ status: "canceled", metadata: { orgId: ORG } });
    const r = await handleBillingEvent(
      event("customer.subscription.deleted", { id: "sub_1", object: "subscription", metadata: { orgId: ORG, purpose: "club-fee" } }),
      now,
    );
    expect(r).toMatchObject({ action: "ignored", reason: "not-club-fee" });
    expect(h.state.org!.billingStatus).toBe("subscribed");
  });

  it("an exempt club (set Free, its subscription cancelled) never moves on the deletion", async () => {
    live();
    Object.assign(h.state.org!, { billingStatus: "exempt", billingPlan: "free" });
    sub({ status: "canceled" });
    await handleBillingEvent(event("customer.subscription.deleted", { id: "sub_1", object: "subscription", metadata: { orgId: ORG, purpose: "club-fee" } }), now);
    expect(h.state.org!.billingStatus).toBe("exempt");
    expect(h.state.billing!.stripeSubscriptionStatus).toBe("canceled");
  });

  it("invoice.payment_action_required is synced, changes no state, and notes the 3DS DM with the invoice's own page (slice B4)", async () => {
    live();
    sub({ status: "active" });
    const r = await handleBillingEvent(invoice("invoice.payment_action_required", { hosted_invoice_url: "https://invoice.stripe.com/i/in_1" }), now);
    expect(r).toMatchObject({ orgId: ORG });
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.dms).toEqual([]);
    expect(h.state.paymentNotes).toEqual([
      { orgId: ORG, invoiceId: "in_1", kind: "payment-action", hostedUrl: "https://invoice.stripe.com/i/in_1", now },
    ]);
  });

  it("invoice.payment_failed notes the 'payment failed' DM for that invoice, AFTER the sync moved the club to past due (slice B4)", async () => {
    live();
    sub({ status: "past_due" });
    await handleBillingEvent(invoice("invoice.payment_failed"), now);
    expect(h.state.org!.billingStatus).toBe("past_due");
    expect(h.state.paymentNotes).toEqual([{ orgId: ORG, invoiceId: "in_1", kind: "payment-failed", hostedUrl: null, now }]);
  });

  it("invoice.paid notes nothing", async () => {
    live();
    sub({ status: "active" });
    await handleBillingEvent(invoice("invoice.paid"), now);
    expect(h.state.paymentNotes).toEqual([]);
  });

  it("payment_method.detached for the card on file clears the card fields; any other card is ignored", async () => {
    live();
    await handleBillingEvent(event("payment_method.detached", { id: "pm_other", object: "payment_method" }), now);
    expect(h.state.billing!.stripePaymentMethodId).toBe("pm_colin");
    await handleBillingEvent(event("payment_method.detached", { id: "pm_colin", object: "payment_method" }), now);
    expect(h.state.billing).toMatchObject({ stripePaymentMethodId: null, cardHolderUserId: null, cardBrand: null, cardLast4: null });
  });

  it("anything else is recorded and ignored", async () => {
    expect(await handleBillingEvent(event("customer.created", { id: "cus_1" }), now)).toEqual({ action: "ignored", reason: "unhandled-type", orgId: null });
  });
});

describe("checkout.session.completed (setup, replace-card)", () => {
  beforeEach(() => {
    setWorld(
      { billingStatus: "subscribed" },
      { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", stripePaymentMethodId: "pm_colin", cardBrand: "visa", cardLast4: "4242", cardHolderUserId: "user_colin", billingCountry: "GB", cardCountry: "GB" },
    );
    sub({ status: "active" });
    fake.putSetupIntent("seti_1", { paymentMethodId: "pm_pat", brand: "mastercard", last4: "4444", country: "GB" });
  });
  const replaced = (over: Record<string, unknown> = {}) =>
    event("checkout.session.completed", {
      id: "cs_setup",
      object: "checkout.session",
      mode: "setup",
      customer: "cus_fake_1",
      setup_intent: "seti_1",
      metadata: { orgId: ORG, payerUserId: "user_pat", purpose: "club-fee", action: "replace-card" },
      customer_details: { email: "pat@example.test", name: "Pat", address: { country: "GB" } },
      ...over,
    });

  it("makes the new card the default, detaches the old one, and DMs the old holder once", async () => {
    h.state.contact = "user_pat";
    await handleBillingEvent(replaced(), new Date());
    expect(calls("setDefaultPaymentMethod")).toEqual([
      { customerId: "cus_fake_1", subscriptionId: "sub_1", paymentMethodId: "pm_pat", email: "pat@example.test", name: "Pat" },
    ]);
    expect(calls("detachPaymentMethod")).toEqual([{ paymentMethodId: "pm_colin" }]);
    expect(h.state.billing).toMatchObject({ stripePaymentMethodId: "pm_pat", cardBrand: "mastercard", cardLast4: "4444", cardHolderUserId: "user_pat", vatCountryCheck: false });
    expect(h.state.dms).toEqual([expect.objectContaining({ kind: "card-replaced", cycleKey: "pm_colin", userId: "user_colin" })]);
    expect(h.state.dms[0].text).toBe("Hi Colin, Pat now pays the MatchTime fee for Billing Sevens. Your card has been removed and won't be charged for it again.");
    expect(calls("payOpenInvoices")).toEqual([]);
    // Re-delivered: nothing detached again, no second DM.
    await handleBillingEvent(replaced(), new Date());
    expect(calls("detachPaymentMethod")).toHaveLength(1);
    expect(h.state.dms).toHaveLength(1);
  });

  it("past due: the open invoice is retried on the new card at once", async () => {
    h.state.org!.billingStatus = "past_due";
    await handleBillingEvent(replaced(), new Date());
    expect(calls("payOpenInvoices")).toEqual([{ subscriptionId: "sub_1" }]);
  });

  it("the club's subscription has ended: ignored, never a retry loop", async () => {
    h.state.billing!.stripeSubscriptionStatus = "canceled";
    expect(await handleBillingEvent(replaced(), new Date())).toMatchObject({ action: "ignored", reason: "no-subscription" });
    expect(calls("setDefaultPaymentMethod")).toEqual([]);
  });

  it("a Turkish card flags the VAT country check", async () => {
    fake.putSetupIntent("seti_1", { paymentMethodId: "pm_pat", brand: "visa", last4: "9999", country: "TR" });
    await handleBillingEvent(replaced(), new Date());
    expect(h.state.billing).toMatchObject({ vatCountryCheck: true, cardCountry: "TR" });
  });
});

// ── Plan changes on live subscriptions ──────────────────────────────────

describe("syncPlanToStripe: plan changes on a live subscription (5.2)", () => {
  const live = (org: Partial<Org> = {}) =>
    setWorld(
      { billingStatus: "subscribed", ...org },
      { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", stripePriceId: "price_std" },
    );

  it("Custom: the item's price is swapped (no proration), from the next month", async () => {
    live({ billingPlan: "custom", billingPricePence: 500 });
    sub({ status: "active" });
    expect(await syncPlanToStripe(ORG)).toEqual({ action: "price-changed", priceId: "price_fake_500" });
    expect(calls("updateSubscriptionPrice")).toEqual([{ subscriptionId: "sub_1", itemId: "si_1", priceId: "price_fake_500" }]);
    expect(h.state.billing!.stripePriceId).toBe("price_fake_500");
  });

  it("back to Standard: swapped back to the standard price", async () => {
    live();
    h.state.billing!.stripePriceId = "price_fake_500";
    sub({ status: "active", priceId: "price_fake_500" });
    expect(await syncPlanToStripe(ORG)).toEqual({ action: "price-changed", priceId: "price_std" });
  });

  it("the same price: only the open sessions are expired, nothing else sent", async () => {
    live();
    expect(await syncPlanToStripe(ORG)).toEqual({ action: "unchanged" });
    expect(fake.state().calls.map((c) => c.method)).toEqual(["expireOpenCheckoutSessions"]);
  });

  it("Free: the subscription is cancelled at once, and stored as cancelled at once", async () => {
    live({ billingStatus: "exempt", billingPlan: "free" });
    sub({ status: "active" });
    expect(await syncPlanToStripe(ORG)).toEqual({ action: "cancelled" });
    expect(calls("cancelSubscription")).toEqual([{ subscriptionId: "sub_1" }]);
    // So "Add a card" after Free and back is not refused while the
    // deletion webhook is still on its way.
    expect(h.state.billing!.stripeSubscriptionStatus).toBe("canceled");
  });

  it("no live subscription: nothing to do", async () => {
    setWorld({ billingStatus: "trial" });
    expect(await syncPlanToStripe(ORG)).toEqual({ action: "no-subscription" });
    expect(fake.state().calls).toEqual([]);
  });
});

describe("BILLING_ENABLED off: nothing reachable changes", () => {
  it("no DM is queued from a webhook (the link would land on a 404)", async () => {
    delete process.env.BILLING_ENABLED;
    setWorld({}, { stripeCustomerId: "cus_fake_1" });
    sub();
    await handleBillingEvent(checkoutCompleted(), new Date(APPROVED.getTime() + 21 * DAY));
    expect(h.state.dms).toEqual([]);
  });
});

// ── Review fixes (PR #181 adversarial review) ───────────────────────────

describe("review fix 1 (HIGH): a club on Free or exempt never keeps a live subscription", () => {
  const now = new Date(APPROVED.getTime() + 21 * DAY);

  it("a Checkout that completes AFTER the club was set Free: cancelled at once, its payment refunded, never adopted", async () => {
    setWorld({ billingStatus: "exempt", billingPlan: "free" }, { stripeCustomerId: "cus_fake_1" });
    h.state.exemptSince = new Date(Date.now() - 60_000);
    sub({ status: "active", trialEnd: null });
    fake.putPaidInvoice("sub_1", 999);
    const r = await handleBillingEvent(checkoutCompleted(), now);
    expect(r).toMatchObject({ action: "unwanted-cancelled", orgId: ORG });
    expect(calls("cancelSubscription")).toEqual([{ subscriptionId: "sub_1" }]);
    expect(fake.state().refunds).toEqual([expect.objectContaining({ subscriptionId: "sub_1", pence: 999 })]);
    expect(h.state.billing!.stripeSubscriptionId).toBeNull();
    expect(h.state.org!.billingStatus).toBe("exempt");
    expect(h.state.dms).toEqual([]);
    expect(h.state.ops).toEqual([expect.objectContaining({ kind: "club-billing", dedupeKey: "unwanted:sub_1" })]);
  });

  it("a subscription event for an exempt club with no billing row (Sutton FC's shape): cancelled too", async () => {
    setWorld({ billingStatus: "exempt", approvedAt: null });
    h.state.billing = null;
    sub({ status: "trialing", customerId: "cus_x" });
    const r = await handleBillingEvent(event("customer.subscription.created", { id: "sub_1", object: "subscription" }), now);
    expect(r).toMatchObject({ action: "unwanted-cancelled" });
    expect(calls("cancelSubscription")).toEqual([{ subscriptionId: "sub_1" }]);
  });

  it("setting Free expires every open Checkout session on the club's Customer, even with no subscription yet", async () => {
    setWorld({ billingStatus: "exempt", billingPlan: "free" }, { stripeCustomerId: "cus_x" });
    expect(await syncPlanToStripe(ORG)).toEqual({ action: "no-subscription" });
    expect(calls("expireOpenCheckoutSessions")).toEqual([{ customerId: "cus_x" }]);
  });

  it("a price change expires open sessions too (a later completion cannot land on the old price)", async () => {
    setWorld(
      { billingStatus: "subscribed", billingPlan: "custom", billingPricePence: 500 },
      { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", stripePriceId: "price_std" },
    );
    sub({ status: "active" });
    await syncPlanToStripe(ORG);
    const methods = fake.state().calls.map((c) => c.method);
    expect(methods.indexOf("expireOpenCheckoutSessions")).toBeLessThan(methods.indexOf("updateSubscriptionPrice"));
  });

  it("an adopted subscription on a stale price is corrected to the club's current plan", async () => {
    setWorld({ billingPlan: "custom", billingPricePence: 500 }, { stripeCustomerId: "cus_fake_1" });
    sub({ priceId: "price_std" });
    await handleBillingEvent(checkoutCompleted(), now);
    expect(calls("updateSubscriptionPrice")).toEqual([{ subscriptionId: "sub_1", itemId: "si_1", priceId: "price_fake_500" }]);
    expect(h.state.billing!.stripePriceId).toBe("price_fake_500");
    expect(h.state.org!.billingStatus).toBe("subscribed");
  });
});

describe("review fix 2: a club whose subscription is unpaid can always pay", () => {
  const later = new Date(TRIAL_ENDS.getTime() + 10 * DAY);

  it("paused with a past_due subscription: Add a card becomes the setup-mode 'update card and pay' path, never a dead end", async () => {
    setWorld(
      { billingStatus: "paused" },
      { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "past_due", cardHolderUserId: "user_colin", stripePaymentMethodId: "pm_colin", pausedReason: "payment-failed" },
    );
    sub({ status: "past_due", trialEnd: null });
    const r = await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now: later });
    expect(r).toMatchObject({ ok: true });
    const p = calls("createCheckoutSession")[0] as unknown as Stripe.Checkout.SessionCreateParams;
    expect(p.mode).toBe("setup");
    expect(p.metadata).toMatchObject({ action: "replace-card", payerUserId: "user_colin" });
  });

  it("the card holder may use setup mode on their OWN card while it is unpaid, and the open invoice is retried", async () => {
    setWorld(
      { billingStatus: "past_due" },
      { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "past_due", cardHolderUserId: "user_colin", stripePaymentMethodId: "pm_colin" },
    );
    expect(await startCardReplace({ orgId: ORG, userId: "user_colin", role: "contact" })).toMatchObject({ ok: true });
  });

  it("an incomplete subscription is retried on the new card too", async () => {
    setWorld(
      { billingStatus: "grace" },
      { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "incomplete", cardHolderUserId: "user_colin", stripePaymentMethodId: "pm_colin" },
    );
    sub({ status: "incomplete", trialEnd: null });
    fake.putSetupIntent("seti_2", { paymentMethodId: "pm_new", brand: "visa", last4: "1881", country: "GB" });
    await handleBillingEvent(
      event("checkout.session.completed", {
        id: "cs_s",
        mode: "setup",
        customer: "cus_fake_1",
        setup_intent: "seti_2",
        metadata: { orgId: ORG, payerUserId: "user_colin", purpose: "club-fee", action: "replace-card" },
        customer_details: { address: { country: "GB" } },
      }),
      later,
    );
    expect(calls("payOpenInvoices")).toEqual([{ subscriptionId: "sub_1" }]);
  });

  it("Stripe holds a live UNPAID subscription our mirror has not seen yet: the pay path, not a second subscription", async () => {
    setWorld({ billingStatus: "grace" }, { stripeCustomerId: "cus_fake_1" });
    sub({ status: "past_due", trialEnd: null });
    await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now: later });
    expect((calls("createCheckoutSession")[0] as { mode: string }).mode).toBe("setup");
  });
});

describe("review fix 3: the card holder never comes from subscription metadata", () => {
  it("a removed card is not put back on the old payer by a later subscription event", async () => {
    setWorld(
      { billingStatus: "subscribed" },
      { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", stripePaymentMethodId: null, cardHolderUserId: null },
    );
    sub({ status: "active", card: null, metadata: { orgId: ORG, purpose: "club-fee", payerUserId: "user_olly" } });
    await handleBillingEvent(event("customer.subscription.updated", { id: "sub_1" }), new Date());
    expect(h.state.billing!.cardHolderUserId).toBeNull();
  });

  it("a card changed in the Portal (a new card on the subscription) makes the billing CONTACT the holder", async () => {
    setWorld(
      { billingStatus: "subscribed" },
      { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", stripePaymentMethodId: "pm_old", cardHolderUserId: "user_olly" },
    );
    h.state.contact = "user_pat";
    sub({ status: "active", card: { paymentMethodId: "pm_portal", brand: "visa", last4: "5556", country: "GB" }, metadata: { orgId: ORG, purpose: "club-fee", payerUserId: "user_olly" } });
    await handleBillingEvent(event("customer.subscription.updated", { id: "sub_1" }), new Date());
    expect(h.state.billing).toMatchObject({ stripePaymentMethodId: "pm_portal", cardHolderUserId: "user_pat" });
  });

  it("a completed Checkout makes the person who completed it the holder, whatever the metadata says", async () => {
    setWorld({}, { stripeCustomerId: "cus_fake_1" });
    sub({ metadata: { orgId: ORG, purpose: "club-fee", payerUserId: "user_olly" } });
    await handleBillingEvent(checkoutCompleted(), new Date(APPROVED.getTime() + 21 * DAY));
    expect(h.state.billing!.cardHolderUserId).toBe("user_colin");
  });
});

describe("review fix 4 (privacy): the Portal, and the shared Customer's details", () => {
  it("no Portal without STRIPE_CLUB_PORTAL_CONFIG_ID (never the account default)", async () => {
    delete process.env.STRIPE_CLUB_PORTAL_CONFIG_ID;
    setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_x", cardHolderUserId: "user_colin" });
    expect(await openClubPortal({ orgId: ORG, userId: "user_colin", role: "contact" })).toEqual({ ok: false, reason: "not-set-up" });
    expect(calls("createPortalSession")).toEqual([]);
  });

  it("a contact with no card of their own on file never gets the Portal (setup mode instead)", async () => {
    setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_x", cardHolderUserId: null });
    expect(await openClubPortal({ orgId: ORG, userId: "user_colin", role: "contact" })).toEqual({ ok: false, reason: "not-allowed" });
  });

  it("round-2 N3: starting a setup session NEVER resets the shared Customer (the current payer's details stay while their card pays)", async () => {
    setWorld(
      { billingStatus: "subscribed" },
      { stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", cardHolderUserId: "user_colin", stripePaymentMethodId: "pm_colin" },
    );
    await startCardReplace({ orgId: ORG, userId: "user_pat", role: "contact" });
    expect(calls("resetCustomerDetails")).toEqual([]);
  });

  it("the same payer again: no reset", async () => {
    setWorld({ billingStatus: "grace" }, { stripeCustomerId: "cus_x", cardHolderUserId: "user_colin" });
    await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now: new Date(TRIAL_ENDS.getTime() + DAY) });
    expect(calls("resetCustomerDetails")).toEqual([]);
  });

  it("the new card's billing address goes onto the Customer for the invoices", async () => {
    setWorld(
      { billingStatus: "subscribed" },
      { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", cardHolderUserId: "user_colin", stripePaymentMethodId: "pm_colin" },
    );
    fake.putSetupIntent("seti_9", { paymentMethodId: "pm_pat", brand: "visa", last4: "4000", country: "GB" });
    const address = { country: "GB", line1: "1 Pitch Lane", city: "London", postal_code: "SM1 1AA" };
    await handleBillingEvent(
      event("checkout.session.completed", {
        id: "cs_s",
        mode: "setup",
        customer: "cus_fake_1",
        setup_intent: "seti_9",
        metadata: { orgId: ORG, payerUserId: "user_pat", purpose: "club-fee", action: "replace-card" },
        customer_details: { email: "pat@example.test", name: "Pat", address },
      }),
      new Date(),
    );
    expect(calls("updateCustomer")).toEqual([{ customerId: "cus_fake_1", address }]);
  });
});

describe("review fix 5: no double charge", () => {
  const now = new Date(APPROVED.getTime() + 21 * DAY);

  it("Stripe already holds a live (paid or trialing) subscription for the club: no new session", async () => {
    setWorld({}, { stripeCustomerId: "cus_fake_1" });
    sub({ status: "trialing" });
    expect(await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now })).toEqual({ ok: false, reason: "already-subscribed" });
    expect(calls("createCheckoutSession")).toEqual([]);
  });

  it("adoption is a compare-and-set: if another subscription was stored meanwhile, this one is the duplicate", async () => {
    setWorld({}, { stripeCustomerId: "cus_fake_1" });
    sub({ id: "sub_2", status: "active", trialEnd: null });
    sub({ id: "sub_1", status: "active", trialEnd: null });
    h.state.raceNextUpdate = () => Object.assign(h.state.billing!, { stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active" });
    const r = await handleBillingEvent(checkoutCompleted({ subscription: "sub_2" }), now);
    expect(r).toMatchObject({ action: "duplicate-cancelled" });
    expect(h.state.billing!.stripeSubscriptionId).toBe("sub_1");
    expect(calls("cancelSubscription")).toEqual([{ subscriptionId: "sub_2" }]);
  });

  it("a cancelled duplicate that was PAID is refunded automatically and recorded on /admin/health (no DM to anyone)", async () => {
    setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", cardHolderUserId: "user_colin" });
    sub({ id: "sub_1", status: "active" });
    sub({ id: "sub_2", status: "active", trialEnd: null });
    fake.putPaidInvoice("sub_2", 999);
    await handleBillingEvent(checkoutCompleted({ id: "cs_2", subscription: "sub_2" }), now);
    expect(fake.state().refunds).toEqual([expect.objectContaining({ subscriptionId: "sub_2", pence: 999 })]);
    expect(h.state.ops).toEqual([expect.objectContaining({ kind: "club-billing", dedupeKey: "duplicate:sub_2" })]);
    // Recorded BEFORE any money moves (round-2 N2), so it states the plan,
    // not an amount; the amount is in the logs and in Stripe.
    expect(h.state.ops[0].title).toBe("Second club fee subscription cancelled and its payments refunded");
    expect(h.state.dms).toEqual([]);
  });
});

describe("review fix 7: cancelled during the free month", () => {
  it("back to trial (card removed), and a new card keeps trial_end = the free month's end", async () => {
    setWorld(
      { billingStatus: "subscribed" },
      { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "trialing", stripePaymentMethodId: "pm_colin", cardHolderUserId: "user_colin", cardLast4: "4242" },
    );
    sub({ status: "canceled" });
    const day10 = new Date(APPROVED.getTime() + 10 * DAY);
    await handleBillingEvent(event("customer.subscription.deleted", { id: "sub_1" }), day10);
    expect(h.state.org!.billingStatus).toBe("trial");
    expect(h.state.billing).toMatchObject({ stripePaymentMethodId: null, cardHolderUserId: null, cardLast4: null, stripeSubscriptionStatus: "canceled" });
    await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now: day10 });
    const p = calls("createCheckoutSession")[0] as unknown as Stripe.Checkout.SessionCreateParams;
    expect(p.subscription_data?.trial_end).toBe(Math.floor(TRIAL_ENDS.getTime() / 1000));
  });
});

describe("review fix 10: the 'resumed' DM is derived from a pending notice", () => {
  const live = () =>
    setWorld(
      { billingStatus: "paused" },
      { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "past_due", cardHolderUserId: "user_colin", stripePaymentMethodId: "pm_colin", pausedReason: "payment-failed" },
    );
  const invoicePaid = () =>
    event("invoice.paid", { id: "in_1", billing_reason: "subscription_cycle", parent: { subscription_details: { subscription: "sub_1" } } });

  it("the DM fails the first time: the retried webhook still sends it, once", async () => {
    live();
    sub({ status: "active", trialEnd: null });
    h.state.failNextDm = true;
    const e = invoicePaid();
    expect((await processBillingWebhook(e, new Date())).status).toBe(500);
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.dms).toEqual([]);
    expect((await processBillingWebhook(e, new Date())).status).toBe(200);
    expect(h.state.dms.map((d) => d.kind)).toEqual(["resumed"]);
    await processBillingWebhook(invoicePaid(), new Date());
    expect(h.state.dms).toHaveLength(1);
  });
});

describe("review fix 11", () => {
  it("an event from a CONNECTED account (event.account set) is ignored here", async () => {
    sub();
    const e = { ...checkoutCompleted(), account: "acct_collector" } as Stripe.Event;
    expect(await handleBillingEvent(e, new Date())).toEqual({ action: "ignored", reason: "connect-event", orgId: null });
    expect(fake.state().calls).toEqual([]);
  });

  it("suspending a billed club cancels its live subscription at once (no refund) and expires open sessions", async () => {
    setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active" });
    expect(await cancelSubscriptionOnSuspend(ORG)).toEqual({ action: "cancelled" });
    expect(calls("expireOpenCheckoutSessions")).toEqual([{ customerId: "cus_fake_1" }]);
    expect(calls("cancelSubscription")).toEqual([{ subscriptionId: "sub_1", reason: "suspend" }]);
    expect(calls("refundPaidInvoices")).toEqual([]);
    expect(h.state.billing!.stripeSubscriptionStatus).toBe("canceled");
  });

  it("suspending a club with no subscription does nothing in Stripe", async () => {
    setWorld({ billingStatus: "trial" });
    expect(await cancelSubscriptionOnSuspend(ORG)).toEqual({ action: "no-subscription" });
    expect(fake.state().calls).toEqual([]);
  });
});

// ── Round-2 review (PR #181) ─────────────────────────────────────────────

describe("round-2 N1 (HIGH): a club on Free, exempt, suspended or gone: cancel; refund only what it paid after it stopped being billed", () => {
  const now = new Date();

  it("a long-paying club set Free: a webhook landing before syncPlanToStripe's cancel cancels it, and its HISTORY is not refunded", async () => {
    setWorld({ billingStatus: "exempt", billingPlan: "free" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active" });
    h.state.exemptSince = new Date(now.getTime() - 60_000);
    sub({ status: "active", trialEnd: null });
    for (let i = 1; i <= 6; i++) fake.putPaidInvoice("sub_1", 999, new Date(now.getTime() - i * 30 * DAY));
    await handleBillingEvent(event("customer.subscription.updated", { id: "sub_1" }), now);
    expect(calls("cancelSubscription")).toEqual([{ subscriptionId: "sub_1" }]);
    expect(fake.state().refunds).toEqual([]);
    expect(h.state.billing!.stripeSubscriptionStatus).toBe("canceled");
  });

  it("an invoice paid AFTER the club became Free is refunded, and only that one", async () => {
    setWorld({ billingStatus: "exempt", billingPlan: "free" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active" });
    h.state.exemptSince = new Date(now.getTime() - 60 * 60_000);
    sub({ status: "active", trialEnd: null });
    fake.putPaidInvoice("sub_1", 999, new Date(now.getTime() - 40 * DAY), "in_history");
    fake.putPaidInvoice("sub_1", 999, new Date(now.getTime() - 60_000), "in_after_free");
    await handleBillingEvent(event("invoice.paid", { id: "in_after_free", parent: { subscription_details: { subscription: "sub_1" } } }), now);
    expect(fake.state().refunds).toEqual([{ subscriptionId: "sub_1", invoiceId: "in_after_free", pence: 999 }]);
  });

  it("a deleted club: cancel, NO automatic refund, recorded on /admin/health", async () => {
    h.state.org = null;
    h.state.billing = null;
    sub({ status: "active", trialEnd: null, customerId: "cus_gone" });
    fake.putPaidInvoice("sub_1", 999);
    const r = await handleBillingEvent(event("customer.subscription.updated", { id: "sub_1" }), now);
    expect(r).toMatchObject({ action: "unwanted-cancelled" });
    expect(calls("cancelSubscription")).toEqual([{ subscriptionId: "sub_1" }]);
    expect(fake.state().refunds).toEqual([]);
    expect(h.state.ops).toEqual([expect.objectContaining({ kind: "club-billing", dedupeKey: "unwanted:sub_1" })]);
    expect(h.state.ops[0].title).toContain("not refunded automatically");
  });

  it("a suspended club: cancel only, no refund", async () => {
    setWorld({ billingStatus: "subscribed", approvalStatus: "suspended" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active" });
    sub({ status: "active", trialEnd: null });
    fake.putPaidInvoice("sub_1", 999);
    await handleBillingEvent(event("customer.subscription.updated", { id: "sub_1" }), now);
    expect(calls("cancelSubscription")).toEqual([{ subscriptionId: "sub_1" }]);
    expect(fake.state().refunds).toEqual([]);
    expect(h.state.org!.billingStatus).toBe("subscribed");
  });

  it("a TRUE duplicate still has its own paid invoices refunded in full", async () => {
    setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", cardHolderUserId: "user_colin" });
    sub({ id: "sub_1", status: "active" });
    sub({ id: "sub_2", status: "active", trialEnd: null });
    fake.putPaidInvoice("sub_2", 999, new Date(now.getTime() - 60 * DAY));
    await handleBillingEvent(checkoutCompleted({ id: "cs_2", subscription: "sub_2" }), now);
    expect(fake.state().refunds).toEqual([expect.objectContaining({ subscriptionId: "sub_2", pence: 999 })]);
  });
});

describe("B4 follow-up to round-2 N2: CANCEL FIRST, then refund (intent recorded); a retry or the hourly sweep completes a missing refund", () => {
  const dup = () => {
    setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", cardHolderUserId: "user_colin" });
    sub({ id: "sub_1", status: "active" });
    sub({ id: "sub_2", status: "active", trialEnd: null });
    fake.putPaidInvoice("sub_2", 999);
  };

  it("the order: ops event, refund intent, CANCEL, then refund, then the intent closed", async () => {
    dup();
    await handleBillingEvent(checkoutCompleted({ id: "cs_2", subscription: "sub_2" }), new Date());
    const methods = fake.state().calls.map((c) => c.method);
    expect(methods.indexOf("cancelSubscription")).toBeGreaterThan(-1);
    expect(methods.indexOf("cancelSubscription")).toBeLessThan(methods.indexOf("refundPaidInvoices"));
    expect(h.state.events.get("mt_refund_sub_2")).toMatchObject({ type: "mt.refund-intent", orgId: ORG, processedAt: expect.any(Date) });
  });

  it("the refund FAILS: the unwanted subscription is ALREADY cancelled (it can never charge again), the intent stays open, 500; the retry refunds without cancelling twice", async () => {
    dup();
    const spy = vi.spyOn(fake, "refundPaidInvoices").mockRejectedValueOnce(new Error("stripe 500"));
    const e = checkoutCompleted({ id: "cs_2", subscription: "sub_2" });
    expect((await processBillingWebhook(e, new Date())).status).toBe(500);
    expect(h.state.ops).toHaveLength(1);
    expect(calls("cancelSubscription")).toEqual([{ subscriptionId: "sub_2" }]);
    expect(fake.state().subscriptions.sub_2.status).toBe("canceled");
    expect(h.state.events.get("mt_refund_sub_2")).toMatchObject({ processedAt: null, error: "stripe 500" });
    spy.mockRestore();
    expect((await processBillingWebhook(e, new Date())).status).toBe(200);
    expect(fake.state().refunds).toEqual([expect.objectContaining({ subscriptionId: "sub_2" })]);
    expect(calls("cancelSubscription")).toEqual([{ subscriptionId: "sub_2" }]);
    expect(h.state.events.get("mt_refund_sub_2")!.processedAt).toBeInstanceOf(Date);
  });

  it("the CANCEL fails: nothing is refunded yet, the intent stays open, 500; the retry cancels and then refunds", async () => {
    dup();
    const spy = vi.spyOn(fake, "cancelSubscription").mockRejectedValueOnce(new Error("stripe 502"));
    const e = checkoutCompleted({ id: "cs_2", subscription: "sub_2" });
    expect((await processBillingWebhook(e, new Date())).status).toBe(500);
    expect(fake.state().refunds).toEqual([]);
    expect(h.state.events.get("mt_refund_sub_2")).toMatchObject({ processedAt: null });
    spy.mockRestore();
    expect((await processBillingWebhook(e, new Date())).status).toBe(200);
    expect(fake.state().subscriptions.sub_2.status).toBe("canceled");
    expect(fake.state().refunds).toEqual([expect.objectContaining({ subscriptionId: "sub_2" })]);
    expect(h.state.events.get("mt_refund_sub_2")!.processedAt).toBeInstanceOf(Date);
  });

  it("a refund intent left open while the subscription is already cancelled is completed by the next event for it", async () => {
    setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active" });
    h.state.events.set("mt_refund_sub_2", { id: "mt_refund_sub_2", type: "mt.refund-intent", orgId: ORG, processedAt: null, error: "earlier failure" });
    sub({ id: "sub_2", status: "canceled", trialEnd: null });
    fake.putPaidInvoice("sub_2", 999);
    await handleBillingEvent(event("customer.subscription.deleted", { id: "sub_2" }), new Date());
    expect(fake.state().refunds).toEqual([expect.objectContaining({ subscriptionId: "sub_2" })]);
    expect(h.state.events.get("mt_refund_sub_2")!.processedAt).toBeInstanceOf(Date);
  });

  describe("the hourly sweep of open refund intents (sweepOpenRefundIntents)", () => {
    const openIntent = (subId: string, type = "mt.refund-intent", receivedAt = new Date(Date.now() - HOUR)) =>
      h.state.events.set(`mt_refund_${subId}`, { id: `mt_refund_${subId}`, type, orgId: ORG, processedAt: null, error: "earlier failure", receivedAt } as never);

    it("finishes an open intent nobody else will retry: refunds (once) and closes it; a cancelled subscription is not cancelled again", async () => {
      setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active" });
      openIntent("sub_2");
      sub({ id: "sub_2", status: "canceled", trialEnd: null });
      fake.putPaidInvoice("sub_2", 999);
      const r = await sweepOpenRefundIntents(new Date());
      expect(r).toEqual({ finished: 1, failed: 0 });
      expect(fake.state().refunds).toEqual([expect.objectContaining({ subscriptionId: "sub_2", pence: 999 })]);
      expect(calls("cancelSubscription")).toEqual([]);
      expect(h.state.events.get("mt_refund_sub_2")!.processedAt).toBeInstanceOf(Date);
      // A second sweep finds nothing open.
      expect(await sweepOpenRefundIntents(new Date())).toEqual({ finished: 0, failed: 0 });
      expect(fake.state().refunds).toHaveLength(1);
    });

    it("an intent whose subscription is somehow still live is CANCELLED first, then refunded", async () => {
      setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active" });
      openIntent("sub_2");
      sub({ id: "sub_2", status: "active", trialEnd: null });
      fake.putPaidInvoice("sub_2", 999);
      await sweepOpenRefundIntents(new Date());
      const methods = fake.state().calls.map((c) => c.method);
      expect(methods.indexOf("cancelSubscription")).toBeLessThan(methods.indexOf("refundPaidInvoices"));
      expect(fake.state().subscriptions.sub_2.status).toBe("canceled");
    });

    it("keeps the 'after' policy of the intent (only payments after the club became Free are refunded)", async () => {
      setWorld({ billingStatus: "exempt", billingPlan: "free" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "canceled" });
      const since = new Date(Date.now() - 2 * DAY);
      openIntent("sub_1", `mt.refund-intent:after:${since.toISOString()}`);
      sub({ id: "sub_1", status: "canceled" });
      fake.putPaidInvoice("sub_1", 999, new Date(Date.now() - 40 * DAY), "in_before");
      fake.putPaidInvoice("sub_1", 999, new Date(Date.now() - DAY), "in_after");
      await sweepOpenRefundIntents(new Date());
      expect(fake.state().refunds).toEqual([{ subscriptionId: "sub_1", invoiceId: "in_after", pence: 999 }]);
    });

    it("a refund that keeps failing stays open with its error and is counted; the next one is still tried", async () => {
      setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active" });
      openIntent("sub_2");
      openIntent("sub_3");
      sub({ id: "sub_2", status: "canceled", trialEnd: null });
      sub({ id: "sub_3", status: "canceled", trialEnd: null });
      fake.putPaidInvoice("sub_3", 999);
      const spy = vi.spyOn(fake, "refundPaidInvoices").mockRejectedValueOnce(new Error("still down"));
      const r = await sweepOpenRefundIntents(new Date());
      spy.mockRestore();
      expect(r).toEqual({ finished: 1, failed: 1 });
      expect(h.state.events.get("mt_refund_sub_2")).toMatchObject({ processedAt: null, error: "still down" });
      expect(h.state.events.get("mt_refund_sub_3")!.processedAt).toBeInstanceOf(Date);
    });

    it("leaves an intent opened in the last few minutes to the webhook that is working on it", async () => {
      setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active" });
      openIntent("sub_2", "mt.refund-intent", new Date());
      sub({ id: "sub_2", status: "canceled", trialEnd: null });
      expect(await sweepOpenRefundIntents(new Date())).toEqual({ finished: 0, failed: 0 });
    });
  });
});

describe("round-2 N3: the shared Customer is reset only once the new card is confirmed", () => {
  const replaced = (payer: string) =>
    event("checkout.session.completed", {
      id: "cs_s",
      mode: "setup",
      customer: "cus_fake_1",
      setup_intent: "seti_r",
      metadata: { orgId: ORG, payerUserId: payer, purpose: "club-fee", action: "replace-card" },
      customer_details: { email: `${payer}@example.test`, name: payer, address: { country: "GB", line1: "1 Lane" } },
    });
  beforeEach(() => {
    setWorld(
      { billingStatus: "subscribed" },
      { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", cardHolderUserId: "user_colin", stripePaymentMethodId: "pm_colin" },
    );
    sub({ status: "active" });
    fake.putSetupIntent("seti_r", { paymentMethodId: "pm_new", brand: "visa", last4: "4000", country: "GB" });
  });

  it("a NEW payer: reset (old payer's email, address, VAT numbers gone), then their card and details", async () => {
    await handleBillingEvent(replaced("user_pat"), new Date());
    const methods = fake.state().calls.map((c) => c.method).filter((m) => ["resetCustomerDetails", "setDefaultPaymentMethod", "updateCustomer"].includes(m));
    expect(methods).toEqual(["resetCustomerDetails", "setDefaultPaymentMethod", "updateCustomer"]);
    expect(calls("resetCustomerDetails")).toEqual([{ customerId: "cus_fake_1", name: "Billing Sevens" }]);
  });

  it("the same payer updating their own card: no reset", async () => {
    await handleBillingEvent(replaced("user_colin"), new Date());
    expect(calls("resetCustomerDetails")).toEqual([]);
  });
});

describe("round-2 N4: a subscription cancelled by a suspension leaves the billing state alone", () => {
  it("the deletion of a suspend-marked subscription: mirrored as cancelled, the state unchanged (not trial, not paused)", async () => {
    setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active" });
    sub({ status: "canceled", metadata: { orgId: ORG, purpose: "club-fee", cancelledBy: "suspend" } });
    await handleBillingEvent(event("customer.subscription.deleted", { id: "sub_1" }), new Date(APPROVED.getTime() + 10 * DAY));
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.billing!.stripeSubscriptionStatus).toBe("canceled");
    expect(h.state.stateCalls).toEqual([]);
  });

  it("a suspended club never moves on a subscription event, whatever its metadata", async () => {
    setWorld({ billingStatus: "subscribed", approvalStatus: "suspended" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active" });
    sub({ status: "canceled" });
    await handleBillingEvent(event("customer.subscription.deleted", { id: "sub_1" }), new Date());
    expect(h.state.stateCalls).toEqual([]);
  });
});

describe("round-2 N5: pending DMs are re-checked against the club's state before they go", () => {
  const now = new Date();
  const iso = (d: Date) => d.toISOString();

  it("plan-billed goes only while the club is still in THAT grace cycle", async () => {
    const at = new Date(now.getTime() - DAY);
    setWorld({ billingStatus: "grace" }, { graceEndsAt: new Date(at.getTime() + 7 * DAY) });
    h.state.pending = [{ kind: "plan-billed", cycleKey: iso(at) }];
    await flushPendingBillingNotices(ORG, now);
    expect(h.state.dms.map((d) => d.kind)).toEqual(["plan-billed"]);
  });

  it("plan-billed for an older grace cycle, or after the club left grace: skipped", async () => {
    const at = new Date(now.getTime() - DAY);
    setWorld({ billingStatus: "grace" }, { graceEndsAt: new Date(now.getTime() + 7 * DAY) });
    h.state.pending = [{ kind: "plan-billed", cycleKey: iso(at) }];
    await flushPendingBillingNotices(ORG, now);
    setWorld({ billingStatus: "subscribed" }, { graceEndsAt: null });
    h.state.pending = [{ kind: "plan-billed", cycleKey: iso(new Date(at.getTime() + 1000)) }];
    await flushPendingBillingNotices(ORG, now);
    expect(h.state.dms).toEqual([]);
    expect(h.state.skipped.map((x) => x.why)).toEqual(["not-current", "not-current"]);
  });

  it("resumed goes only while the club is serving", async () => {
    setWorld({ billingStatus: "paused" });
    h.state.pending = [{ kind: "resumed", cycleKey: iso(new Date(now.getTime() - 60_000)) }];
    await flushPendingBillingNotices(ORG, now);
    expect(h.state.dms).toEqual([]);
    expect(h.state.skipped).toEqual([expect.objectContaining({ kind: "resumed", why: "not-current" })]);
  });

  it("older than 3 days: expired, never sent", async () => {
    setWorld({ billingStatus: "subscribed" });
    h.state.pending = [{ kind: "resumed", cycleKey: iso(new Date(now.getTime() - 4 * DAY)) }];
    await flushPendingBillingNotices(ORG, now);
    expect(h.state.dms).toEqual([]);
    expect(h.state.skipped).toEqual([expect.objectContaining({ why: "expired" })]);
  });

  it("two of the same kind (plans toggled): only the newest can go, the older is superseded", async () => {
    setWorld({ billingStatus: "subscribed" });
    h.state.pending = [
      { kind: "resumed", cycleKey: iso(new Date(now.getTime() - 2 * 60_000)) },
      { kind: "resumed", cycleKey: iso(new Date(now.getTime() - 60_000)) },
    ];
    await flushPendingBillingNotices(ORG, now);
    expect(h.state.dms).toHaveLength(1);
    expect(h.state.skipped).toEqual([expect.objectContaining({ why: "superseded" })]);
  });

  it("no billing contact: expired rather than kept for ever", async () => {
    setWorld({ billingStatus: "subscribed" });
    h.state.contact = null;
    h.state.pending = [{ kind: "resumed", cycleKey: iso(new Date(now.getTime() - 60_000)) }];
    await flushPendingBillingNotices(ORG, now);
    expect(h.state.skipped).toEqual([expect.objectContaining({ why: "no-contact" })]);
  });
});

describe("slice B4: the webhook's own DMs wait for daytime (10:00 to 20:00 London)", () => {
  it("'card added' at 23:00 London is queued for 10:00 the next morning; in the daytime it goes at once", async () => {
    sub({ status: "trialing" });
    await handleBillingEvent(checkoutCompleted(), new Date("2026-10-21T22:00:00Z"));
    expect(h.state.dms[0]).toMatchObject({ kind: "card-added" });
    expect(h.state.dms[0].sendAfter).toEqual(new Date("2026-10-22T09:00:00Z"));

    setWorld();
    h.state.dms.length = 0;
    h.state.notices.clear();
    sub({ id: "sub_9", status: "trialing" });
    await handleBillingEvent(checkoutCompleted({ id: "cs_9", subscription: "sub_9" }), new Date("2026-10-21T12:00:00Z"));
    expect(h.state.dms[0].sendAfter ?? null).toBeNull();
  });

  it("a pending 'resumed' flushed at night is queued for 10:00", async () => {
    setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_fake_1", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active" });
    const night = new Date("2026-12-01T02:00:00Z");
    h.state.pending.push({ kind: "resumed", cycleKey: night.toISOString() });
    await flushPendingBillingNotices(ORG, night);
    expect(h.state.dms[0]).toMatchObject({ kind: "resumed", sendAfter: new Date("2026-12-01T10:00:00Z") });
  });
});
