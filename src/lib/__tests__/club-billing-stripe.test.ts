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
};

const h = vi.hoisted(() => {
  const state = {
    org: null as Org | null,
    billing: null as Billing | null,
    events: new Map<string, { id: string; type: string; orgId: string | null; processedAt: Date | null; error: string | null }>(),
    dms: [] as Array<{ orgId: string; kind: string; cycleKey: string; userId: string; text: string }>,
    notices: new Set<string>(),
    contact: "user_colin" as string | null,
    users: {
      user_colin: { name: "Colin" },
      user_pat: { name: "Pat" },
      user_olly: { name: "Olly" },
    } as Record<string, { name: string }>,
    stateCalls: [] as string[],
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
        if (!state.billing || !matches(state.billing as unknown as Record<string, unknown>, where)) return { count: 0 };
        Object.assign(state.billing, data);
        return { count: 1 };
      }),
    },
    billingEvent: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.events.get(where.id) ?? null),
      create: vi.fn(async ({ data }: { data: { id: string; type: string; orgId?: string | null } }) => {
        if (state.events.has(data.id)) throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        const row = { id: data.id, type: data.type, orgId: data.orgId ?? null, processedAt: null, error: null };
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
vi.mock("../club-billing", async () => {
  const rules = await import("../club-billing-rules");
  return {
    setBillingState: vi.fn(async (orgId: string, event: { type: string }, now: Date) => {
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
      return { ok: true, from, to: t.to, resumed: t.resumes };
    }),
    loadBillingContactUserId: vi.fn(async () => h.state.contact),
    queueBillingDm: vi.fn(
      async (a: { orgId: string; kind: string; cycleKey: string; userId: string; text: (u: { name: string | null }) => string }) => {
        const key = `${a.orgId}|${a.kind}|${a.cycleKey}`;
        if (h.state.notices.has(key)) return "already";
        h.state.notices.add(key);
        h.state.dms.push({ orgId: a.orgId, kind: a.kind, cycleKey: a.cycleKey, userId: a.userId, text: a.text({ name: h.state.users[a.userId]?.name ?? null }) });
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
    expect(fake.state().calls.map((c) => c.method)).toEqual(["expireOpenCheckoutSessions", "createCheckoutSession"]);
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

  it("refuses the card holder themselves (they use the Portal), a viewer, and a club with no live subscription", async () => {
    expect(await startCardReplace({ orgId: ORG, userId: "user_colin", role: "contact" })).toEqual({ ok: false, reason: "own-card" });
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

  it("refuses a contact whose card is not on file (the old collector's card would show) and a viewer", async () => {
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

  it("invoice.payment_action_required is synced and changes nothing else (the 3DS DM is slice B4)", async () => {
    live();
    sub({ status: "active" });
    const r = await handleBillingEvent(invoice("invoice.payment_action_required"), now);
    expect(r).toMatchObject({ orgId: ORG });
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.dms).toEqual([]);
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

  it("the same price: nothing sent to Stripe", async () => {
    live();
    expect(await syncPlanToStripe(ORG)).toEqual({ action: "unchanged" });
    expect(fake.state().calls).toEqual([]);
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
