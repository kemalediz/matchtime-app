/**
 * CLUB FEE BILLING, slice P2: the card actions, Stop and Keep paying, the
 * billing webhook (card saved in setup mode, invoice paid / failed / bank
 * check / void), and the plan and suspension hooks.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.2, 4.5, 5.
 *
 * The database is a small in-memory club with its billing months; the
 * REAL month writer (club-billing-months.ts) runs on it; `setBillingState`
 * is replaced by one that applies the REAL pure `nextBillingState` (the one
 * writer itself is covered by club-billing.test.ts). Stripe is the fake
 * adapter. No network, no model; DMs are recorded, never sent.
 *
 * Replaces B3's subscription tests: no subscription, no Portal, no price
 * objects, no refunds (5.5). The B3 money-safety properties that still
 * apply are pinned again here: purpose "club-fee" only, Connect events
 * refused, the customer must be the club's, idempotent webhook, one open
 * session per club, a Free club never keeps a new card, the role re-checked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

type Billing = {
  orgId: string;
  trialStartedAt: Date;
  trialEndsAt: Date;
  graceEndsAt: Date | null;
  stripeCustomerId: string | null;
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
  approvalStatus: string;
};
type Month = {
  id: string;
  orgId: string;
  index: number;
  startsAt: Date;
  endsAt: Date;
  priceAtStartPence: number;
  status: string;
  stripeInvoiceId: string | null;
  amountPence: number | null;
  reason: string | null;
  closedAt: Date | null;
  paidAt: Date | null;
  updatedAt: Date;
};

const h = vi.hoisted(() => {
  const state = {
    org: null as Org | null,
    billing: null as Billing | null,
    months: [] as Month[],
    events: new Map<string, { id: string; type: string; orgId: string | null; processedAt: Date | null; error: string | null; receivedAt?: Date }>(),
    dms: [] as Array<{ kind: string; cycleKey: string; userId: string; text: string }>,
    notices: new Set<string>(),
    contact: "user_colin" as string | null,
    users: { user_colin: { name: "Colin" }, user_pat: { name: "Pat" }, user_olly: { name: "Olly" } } as Record<string, { name: string }>,
    stateCalls: [] as Array<{ type: string; unpaid?: boolean; noticeOnResume?: string }>,
    pending: [] as Array<{ kind: string; cycleKey: string; createdAt: Date }>,
    skipped: [] as Array<{ kind: string; cycleKey: string; why: string }>,
    paymentNotes: [] as Array<Record<string, unknown>>,
    ops: [] as Array<{ title: string; severity: string }>,
    spells: [] as Array<{ orgId: string; type: string; at: Date }>,
    locks: new Map<string, Promise<void>>(),
    receipts: [] as string[],
    lockKeys: [] as string[],
  };
  const cmp = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const cur = row[k];
      if (v instanceof Date) return cur instanceof Date && cur.getTime() === v.getTime();
      if (v && typeof v === "object") {
        const o = v as { in?: unknown[]; not?: unknown; lt?: Date; lte?: Date };
        if (o.in) return o.in.includes(cur);
        if ("not" in o) return cur !== o.not;
        if (o.lt) return cur instanceof Date && cur.getTime() < o.lt.getTime();
        if (o.lte) return cur instanceof Date && cur.getTime() <= o.lte.getTime();
        return false;
      }
      return cur === v;
    });
  const db = {
    organisation: {
      findUnique: vi.fn(async () => (state.org ? { ...state.org, clubBilling: state.billing ? { ...state.billing } : null } : null)),
    },
    clubBilling: {
      findUnique: vi.fn(async () => (state.billing ? { ...state.billing } : null)),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.billing && cmp(state.billing as unknown as Record<string, unknown>, where) ? { ...state.billing } : null,
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Billing> }) => {
        if (!state.billing) return { count: 0 };
        const { OR, ...rest } = where as Record<string, unknown> & { OR?: Array<Record<string, unknown>> };
        delete rest.orgId;
        if (!cmp(state.billing as unknown as Record<string, unknown>, rest)) return { count: 0 };
        if (OR && !OR.some((w) => cmp(state.billing as unknown as Record<string, unknown>, w))) return { count: 0 };
        Object.assign(state.billing, data);
        return { count: 1 };
      }),
    },
    clubBillingMonth: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const m = state.months.find((x) => x.id === where.id);
        return m ? { ...m } : null;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const rows = state.months.filter((m) => cmp(m as unknown as Record<string, unknown>, where)).sort((a, b) => b.index - a.index);
        // (orderBy is index desc for the opener; a presence check for the stop)
        return rows[0] ? { ...rows[0] } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.months.filter((m) => cmp(m as unknown as Record<string, unknown>, where)).map((m) => ({ ...m })),
      ),
      createMany: vi.fn(async ({ data }: { data: Array<Partial<Month>> }) => {
        let count = 0;
        for (const d of data) {
          if (state.months.some((m) => m.orgId === d.orgId && m.index === d.index)) continue;
          state.months.push({
            id: `cbm_${d.index}`,
            status: "open",
            stripeInvoiceId: null,
            amountPence: null,
            reason: null,
            closedAt: null,
            paidAt: null,
            updatedAt: new Date(),
            ...d,
          } as Month);
          count++;
        }
        return { count };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Month> }) => {
        let count = 0;
        for (const m of state.months) {
          if (!cmp(m as unknown as Record<string, unknown>, where)) continue;
          Object.assign(m, data);
          count++;
        }
        return { count };
      }),
    },
    billingEvent: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.events.get(where.id) ?? null),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            orgId: string;
            type: string;
            receivedAt?: { gt: Date };
            id?: { not: string };
            OR?: Array<{ receivedAt: Date | { gt: Date }; id?: { gt: string } }>;
          };
        }) => {
          const at = (e: { receivedAt?: Date }) => e.receivedAt?.getTime() ?? NaN;
          const orOk = (e: { id: string; receivedAt?: Date }) =>
            !where.OR ||
            where.OR.some((w) =>
              w.receivedAt instanceof Date
                ? at(e) === w.receivedAt.getTime() && (!w.id || e.id > w.id.gt)
                : at(e) > w.receivedAt.gt.getTime(),
            );
          return (
            [...state.events.values()].find(
              (e) =>
                e.orgId === where.orgId &&
                e.type === where.type &&
                (!where.receivedAt || (e.receivedAt !== undefined && e.receivedAt.getTime() > where.receivedAt.gt.getTime())) &&
                (!where.id || e.id !== where.id.not) &&
                orOk(e),
            ) ?? null
          );
        },
      ),
      create: vi.fn(async ({ data }: { data: { id: string; type: string; orgId?: string | null; receivedAt?: Date } }) => {
        if (state.events.has(data.id)) throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        const row = { id: data.id, type: data.type, orgId: data.orgId ?? null, processedAt: null, error: null, receivedAt: data.receivedAt };
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
    /** An interactive transaction whose `$executeRaw` takes a transaction-
     *  scoped advisory lock (released when the callback settles), as
     *  Postgres does: a second taker waits for the first. */
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      let release: () => void = () => undefined;
      const tx = {
        $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const key = String(values[0]);
          state.lockKeys.push(key);
          const prev = state.locks.get(key) ?? Promise.resolve();
          const mine = new Promise<void>((r) => (release = r));
          state.locks.set(key, prev.then(() => mine));
          await prev;
          return 1;
        }),
      };
      try {
        return await fn(tx);
      } finally {
        release();
      }
    }),
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
  recordOpsEvent: vi.fn(async (a: { title: string; severity: string }) => {
    h.state.ops.push(a);
    return true;
  }),
}));
vi.mock("../club-billing-dms", () => ({
  notePaymentProblem: vi.fn(async (a: Record<string, unknown>) => {
    h.state.paymentNotes.push(a);
    return "pending";
  }),
  // Slice P3: the receipt after invoice.paid (its own tests: club-billing-p3-dms.test.ts).
  sendMonthCharged: vi.fn(async (orgId: string, monthId: string) => {
    h.state.receipts.push(monthId);
    return "queued";
  }),
}));
vi.mock("../club-billing-month-loader", () => ({ loadClubMonthInput: vi.fn(async () => null) }));
vi.mock("../club-billing-spells", () => ({
  recordSuspended: vi.fn(async (orgId: string, now: Date) => {
    h.state.spells.push({ orgId, type: "mt.suspended", at: now });
    return true;
  }),
  closeNotBillableSpells: vi.fn(async () => 0),
}));
vi.mock("../club-billing", async () => {
  const rules = await vi.importActual<typeof import("../club-billing-rules")>("../club-billing-rules");
  return {
    setBillingState: vi.fn(async (_orgId: string, event: { type: string; unpaid?: boolean }, now: Date, opts: { noticeOnResume?: string } = {}) => {
      const o = h.state.org!;
      const b = h.state.billing;
      h.state.stateCalls.push({ type: event.type, ...(event.unpaid !== undefined ? { unpaid: event.unpaid } : {}), ...(opts.noticeOnResume ? { noticeOnResume: opts.noticeOnResume } : {}) });
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
        else if (from === "paused") {
          if (b.pausedReason === "cancelled") b.cancelAtPeriodEnd = false;
          Object.assign(b, { pausedAt: null, pausedReason: null, resumedAt: now });
        }
        if (t.to === "subscribed") Object.assign(b, { graceEndsAt: null, paymentFailedAt: null });
        if (t.graceEndsAt) b.graceEndsAt = t.graceEndsAt;
        if (t.paymentFailedAt) b.paymentFailedAt = t.paymentFailedAt;
      }
      if (t.resumes && opts.noticeOnResume) h.state.pending.push({ kind: opts.noticeOnResume, cycleKey: now.toISOString(), createdAt: now });
      return { ok: true, from, to: t.to, resumed: t.resumes };
    }),
    loadBillingContactUserId: vi.fn(async () => h.state.contact),
    loadPendingBillingNotices: vi.fn(async () => h.state.pending.filter((p) => !h.state.notices.has(`${p.kind}|${p.cycleKey}`))),
    notePendingBillingNotice: vi.fn(async (_orgId: string, kind: string, cycleKey: string, now: Date) => {
      if (!h.state.pending.some((p) => p.kind === kind && p.cycleKey === cycleKey)) h.state.pending.push({ kind, cycleKey, createdAt: now });
    }),
    skipBillingNotice: vi.fn(async (_orgId: string, kind: string, cycleKey: string, why: string) => {
      h.state.notices.add(`${kind}|${cycleKey}`);
      h.state.skipped.push({ kind, cycleKey, why });
    }),
    queueBillingDm: vi.fn(async (a: { kind: string; cycleKey: string; userId: string; text: (u: { name: string | null }) => string }) => {
      const key = `${a.kind}|${a.cycleKey}`;
      if (h.state.notices.has(key)) return "already";
      h.state.notices.add(key);
      h.state.dms.push({ kind: a.kind, cycleKey: a.cycleKey, userId: a.userId, text: a.text({ name: h.state.users[a.userId]?.name ?? null }) });
      return "queued";
    }),
  };
});

import { setBillingStripeForTests } from "../stripe-billing";
import { createFakeBillingStripe, type FakeBillingStripe } from "../stripe-billing-fake";
import {
  flushPendingBillingNotices,
  handleBillingEvent,
  keepPaying,
  onClubSuspended,
  onPlanChanged,
  processBillingWebhook,
  removeMyCard,
  startCardReplace,
  startClubCheckout,
  stopPaying,
} from "../club-billing-stripe";
import * as glue from "../club-billing-stripe";
import { applyCheckoutEvent } from "../payment-flow";

const DAY = 24 * 60 * 60 * 1000;
const APPROVED = new Date("2026-10-02T14:00:00Z");
const TRIAL_ENDS = new Date("2026-11-01T14:00:00Z");
const M1_END = new Date("2026-12-01T00:00:00Z");
const ORG = "org_1";
/** 11:00 London on day 21: DMs go at once. */
const DAYTIME = new Date("2026-10-23T10:00:00Z");
/** 02:00 London: DMs wait. */
const NIGHT = new Date("2026-10-23T01:00:00Z");
/** Mid month 1 (after the free month). */
const MID_M1 = new Date("2026-11-15T12:00:00Z");
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
    approvalStatus: "approved",
    ...org,
  };
  h.state.billing = {
    orgId: ORG,
    trialStartedAt: APPROVED,
    trialEndsAt: TRIAL_ENDS,
    graceEndsAt: null,
    stripeCustomerId: null,
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
const withCard = (over: Partial<Billing> = {}): Partial<Billing> => ({
  stripeCustomerId: "cus_fake_1",
  stripePaymentMethodId: "pm_colin",
  cardBrand: "visa",
  cardLast4: "4242",
  cardHolderUserId: "user_colin",
  ...over,
});

beforeEach(() => {
  process.env.BILLING_ENABLED = "1";
  process.env.STRIPE_CLUB_PRODUCT_ID = "prod_club";
  process.env.STRIPE_CLUB_TAX_RATE_ID = "txr_vat";
  process.env.NEXTAUTH_URL = "https://mt.test";
  fake = createFakeBillingStripe();
  setBillingStripeForTests(fake);
  Object.assign(h.state, { months: [], dms: [], stateCalls: [], pending: [], skipped: [], paymentNotes: [], ops: [], spells: [], receipts: [], lockKeys: [], contact: "user_colin" });
  h.state.locks.clear();
  h.state.events.clear();
  h.state.notices.clear();
  setWorld();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  setBillingStripeForTests(null);
  process.env = { ...ENV };
  vi.restoreAllMocks();
});

const calls = (method: string) => fake.state().calls.filter((c) => c.method === method).map((c) => c.args as Record<string, unknown>);
const moneyCalls = () => fake.state().calls.filter((c) => /Invoice|payInvoice|finalize/i.test(c.method) && c.method !== "retrieveInvoice").map((c) => c.method);

let evtSeq = 0;
function event(type: string, object: Record<string, unknown>, opts: { id?: string; account?: string } = {}): Stripe.Event {
  return {
    id: opts.id ?? `evt_${++evtSeq}`,
    object: "event",
    type,
    created: 0,
    data: { object },
    ...(opts.account ? { account: opts.account } : {}),
  } as unknown as Stripe.Event;
}

function cardSaved(action: "add-card" | "replace-card", payer = "user_colin", over: Record<string, unknown> = {}) {
  fake.putSetupIntent(`seti_${payer}`, { paymentMethodId: `pm_${payer.replace("user_", "")}`, brand: "visa", last4: payer === "user_colin" ? "4242" : "1881", country: "GB" });
  return event("checkout.session.completed", {
    id: "cs_1",
    object: "checkout.session",
    mode: "setup",
    customer: h.state.billing?.stripeCustomerId ?? "cus_fake_1",
    setup_intent: `seti_${payer}`,
    created: Math.floor(DAYTIME.getTime() / 1000),
    metadata: { orgId: ORG, payerUserId: payer, purpose: "club-fee", action },
    customer_details: { email: `${payer}@example.test`, name: payer, address: { country: "GB", line1: "1 Road" } },
    ...over,
  });
}

/** A month with a finalised invoice of `pence`, as the close leaves it. */
async function invoicedMonth(index = 1, status = "invoiced", pence = 749) {
  const monthId = `cbm_${index}`;
  const inv = await fake.createMonthInvoice({ orgId: ORG, monthId, customerId: "cus_fake_1", description: "d" });
  await fake.addMonthInvoiceItem({ orgId: ORG, monthId, customerId: "cus_fake_1", description: "d", invoiceId: inv.id, amountPence: pence, productId: "prod_club", taxRateId: "txr_vat" });
  await fake.finalizeInvoice(inv.id);
  h.state.months.push({
    id: monthId,
    orgId: ORG,
    index,
    startsAt: TRIAL_ENDS,
    endsAt: M1_END,
    priceAtStartPence: 999,
    status,
    stripeInvoiceId: inv.id,
    amountPence: pence,
    reason: null,
    closedAt: M1_END,
    paidAt: null,
    updatedAt: M1_END,
  });
  return inv.id;
}
function invoiceEvent(type: string, invoiceId: string, over: Record<string, unknown> = {}, opts: { id?: string } = {}) {
  return event(type, { id: invoiceId, object: "invoice", metadata: { orgId: ORG, purpose: "club-fee", monthId: "cbm_1" }, ...over }, opts);
}

// ── Add a card ───────────────────────────────────────────────────────────

describe("Add a card (5.3): setup mode, NOTHING charged", () => {
  it("the contact in the free month gets a setup session on the club's one Customer; no invoice, no payment", async () => {
    const r = await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now: DAYTIME });
    expect(r).toMatchObject({ ok: true, url: expect.stringContaining("fake_checkout=cs_fake_") });
    expect(h.state.billing!.stripeCustomerId).toMatch(/^cus_fake_/);
    const [params] = calls("createCheckoutSession");
    expect(params).toMatchObject({
      mode: "setup",
      customer: h.state.billing!.stripeCustomerId,
      metadata: { orgId: ORG, payerUserId: "user_colin", purpose: "club-fee", action: "add-card" },
      billing_address_collection: "required",
    });
    expect(JSON.stringify(params)).not.toMatch(/matchId|application_fee|line_items|subscription_data|trial_end/);
    expect(moneyCalls()).toEqual([]);
  });

  it("only ONE session is ever open: open ones are expired before a new one (two tabs, a double tap)", async () => {
    await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now: DAYTIME });
    await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact", now: DAYTIME });
    const methods = fake.state().calls.map((c) => c.method).filter((m) => m !== "createCustomer");
    expect(methods).toEqual(["expireOpenCheckoutSessions", "createCheckoutSession", "expireOpenCheckoutSessions", "createCheckoutSession"]);
    expect(Object.values(fake.state().sessions).filter((s) => s.status === "open")).toHaveLength(1);
    expect(calls("createCustomer")).toHaveLength(1);
  });

  it("refused for anyone but the contact, a club not billed, a removed club, a card already on file, or Stripe not set up", async () => {
    expect(await startClubCheckout({ orgId: ORG, userId: "user_olly", role: "viewer" })).toEqual({ ok: false, reason: "not-allowed" });
    expect(await startClubCheckout({ orgId: ORG, userId: "user_pat", role: "card-holder" })).toEqual({ ok: false, reason: "not-allowed" });
    setWorld({ billingPlan: "free", billingStatus: "exempt" });
    expect(await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact" })).toEqual({ ok: false, reason: "not-billable" });
    setWorld({ approvalStatus: "suspended" });
    expect(await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact" })).toEqual({ ok: false, reason: "not-billable" });
    setWorld({ billingStatus: "paused" }, { pausedReason: "removed" });
    expect(await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact" })).toEqual({ ok: false, reason: "removed-from-group" });
    setWorld({ billingStatus: "subscribed" }, withCard());
    expect(await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact" })).toEqual({ ok: false, reason: "already-card" });
    setWorld();
    delete process.env.STRIPE_CLUB_TAX_RATE_ID;
    expect(await startClubCheckout({ orgId: ORG, userId: "user_colin", role: "contact" })).toEqual({ ok: false, reason: "not-set-up" });
    expect(calls("createCheckoutSession")).toHaveLength(0);
  });

  it("Use my card instead / Change card / Update card and pay: the same setup session, action replace-card; a past due club may", async () => {
    setWorld({ billingStatus: "past_due" }, withCard());
    expect(await startCardReplace({ orgId: ORG, userId: "user_colin", role: "contact" })).toMatchObject({ ok: true });
    expect(calls("createCheckoutSession")[0]).toMatchObject({ mode: "setup", metadata: { action: "replace-card" }, success_url: expect.stringContaining("replaced=1") });
    expect(await startCardReplace({ orgId: ORG, userId: "user_olly", role: "viewer" })).toEqual({ ok: false, reason: "not-allowed" });
  });
});

// ── The webhook: a card saved ────────────────────────────────────────────

describe("webhook: a card saved (checkout.session.completed, setup mode)", () => {
  it("add-card in the free month: the card is the Customer's default, the club 'subscribed', ONE card-added DM, NOTHING charged", async () => {
    setWorld({}, { stripeCustomerId: "cus_fake_1" });
    const r = await handleBillingEvent(cardSaved("add-card"), DAYTIME);
    expect(r).toEqual({ action: "card-added", orgId: ORG });
    expect(h.state.billing).toMatchObject({ stripePaymentMethodId: "pm_colin", cardLast4: "4242", cardHolderUserId: "user_colin", billingCountry: "GB", vatCountryCheck: false });
    expect(calls("setDefaultPaymentMethod")).toEqual([{ customerId: "cus_fake_1", paymentMethodId: "pm_colin", email: "user_colin@example.test", name: "user_colin" }]);
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.dms).toHaveLength(1);
    expect(h.state.dms[0]).toMatchObject({ kind: "card-added", userId: "user_colin", cycleKey: "pm_colin" });
    // The first charge is the morning month 1 ends (1 Dec), never today.
    expect(h.state.dms[0].text).toMatch(/1 Dec/);
    expect(h.state.dms[0].text).not.toMatch(/taken today/);
    expect(moneyCalls()).toEqual([]);
  });

  it("a re-delivered event is answered as a duplicate: one card, one DM", async () => {
    setWorld({}, { stripeCustomerId: "cus_fake_1" });
    const e = cardSaved("add-card");
    expect((await processBillingWebhook(e, DAYTIME)).status).toBe(200);
    expect(await processBillingWebhook(e, DAYTIME)).toEqual({ status: 200, body: { received: true, duplicate: true } });
    expect(h.state.dms).toHaveLength(1);
    expect(calls("setDefaultPaymentMethod")).toHaveLength(1);
  });

  it("at night the card-added DM is pending; the 10:00 run sends it only while that card is still on file", async () => {
    setWorld({}, { stripeCustomerId: "cus_fake_1" });
    await handleBillingEvent(cardSaved("add-card"), NIGHT);
    expect(h.state.dms).toEqual([]);
    expect(h.state.pending).toEqual([{ kind: "card-added", cycleKey: "pm_colin", createdAt: NIGHT }]);
    expect(await flushPendingBillingNotices(ORG, DAYTIME)).toBe(1);
    expect(h.state.dms.map((d) => d.kind)).toEqual(["card-added"]);

    h.state.pending = [];
    h.state.dms = [];
    await handleBillingEvent(cardSaved("add-card", "user_colin"), NIGHT);
    h.state.billing!.stripePaymentMethodId = "pm_other"; // replaced before morning
    h.state.notices.clear();
    expect(await flushPendingBillingNotices(ORG, DAYTIME)).toBe(0);
    expect(h.state.skipped).toContainEqual({ kind: "card-added", cycleKey: "pm_colin", why: "not-current" });
  });

  it("a club paused for no card resumes when the card is saved; nothing is charged at that moment", async () => {
    setWorld({ billingStatus: "paused" }, { stripeCustomerId: "cus_fake_1", pausedReason: "no-card" });
    await handleBillingEvent(cardSaved("add-card"), MID_M1);
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(moneyCalls()).toEqual([]);
  });

  it("a club paused because removed from the group: the card is kept but the club is NOT resumed", async () => {
    setWorld({ billingStatus: "paused" }, { stripeCustomerId: "cus_fake_1", pausedReason: "removed" });
    await handleBillingEvent(cardSaved("add-card"), MID_M1);
    expect(h.state.org!.billingStatus).toBe("paused");
    expect(h.state.billing!.stripePaymentMethodId).toBe("pm_colin");
  });

  it("a club set Free (or exempt) never keeps a NEW card: removed again at once, nothing else", async () => {
    setWorld({ billingPlan: "free", billingStatus: "exempt" }, { stripeCustomerId: "cus_fake_1" });
    expect(await handleBillingEvent(cardSaved("add-card"), DAYTIME)).toMatchObject({ action: "ignored", reason: "not-billable" });
    expect(fake.state().detached).toEqual(["pm_colin"]);
    expect(h.state.billing!.stripePaymentMethodId).toBeNull();
    expect(h.state.stateCalls).toEqual([]);
  });

  it("a suspended club: the card is mirrored, the state NEVER moves, no DM", async () => {
    setWorld({ approvalStatus: "suspended" }, { stripeCustomerId: "cus_fake_1" });
    await handleBillingEvent(cardSaved("add-card"), DAYTIME);
    expect(h.state.stateCalls).toEqual([]);
    expect(h.state.dms).toEqual([]);
  });

  it("replace-card by a NEW collector: the Customer is reset first, the old card removed, its holder told once", async () => {
    setWorld({ billingStatus: "subscribed" }, withCard());
    h.state.contact = "user_pat";
    expect(await handleBillingEvent(cardSaved("replace-card", "user_pat"), DAYTIME)).toEqual({ action: "card-replaced", orgId: ORG });
    const order = fake.state().calls.map((c) => c.method).filter((m) => ["resetCustomerDetails", "setDefaultPaymentMethod", "updateCustomer", "detachPaymentMethod"].includes(m));
    expect(order).toEqual(["resetCustomerDetails", "setDefaultPaymentMethod", "updateCustomer", "detachPaymentMethod"]);
    expect(fake.state().detached).toEqual(["pm_colin"]);
    expect(h.state.billing).toMatchObject({ stripePaymentMethodId: "pm_pat", cardHolderUserId: "user_pat", cardLast4: "1881" });
    expect(h.state.dms).toEqual([expect.objectContaining({ kind: "card-replaced", userId: "user_colin", cycleKey: "pm_colin|user_colin" })]);
    expect(moneyCalls()).toEqual([]);
  });

  it("M1: a LATE retry of an OLDER session never overwrites a newer card: its own card is detached, the payer's details untouched", async () => {
    setWorld({ billingStatus: "subscribed" }, withCard());
    h.state.contact = "user_pat";
    const newer = cardSaved("replace-card", "user_pat", { id: "cs_new", created: Math.floor(DAYTIME.getTime() / 1000) });
    await handleBillingEvent(newer, DAYTIME);
    expect(h.state.billing).toMatchObject({ stripePaymentMethodId: "pm_pat", cardHolderUserId: "user_pat" });
    const before = fake.state().calls.length;
    // Colin's session from an hour EARLIER arrives now (Stripe retried it).
    const older = cardSaved("replace-card", "user_olly", { id: "cs_old", created: Math.floor(DAYTIME.getTime() / 1000) - 3600 });
    expect(await handleBillingEvent(older, DAYTIME)).toMatchObject({ action: "ignored", reason: "superseded-session" });
    expect(h.state.billing).toMatchObject({ stripePaymentMethodId: "pm_pat", cardHolderUserId: "user_pat", cardLast4: "1881" });
    const after = fake.state().calls.slice(before).map((c) => c.method);
    expect(after).not.toContain("resetCustomerDetails");
    expect(after).not.toContain("setDefaultPaymentMethod");
    expect(after).not.toContain("updateCustomer");
    expect(fake.state().detached).toContain("pm_olly");
    expect(fake.state().detached).not.toContain("pm_pat");
    // A re-delivery of the NEWER session itself is not "superseded".
    expect(await handleBillingEvent(cardSaved("replace-card", "user_pat", { id: "cs_new", created: Math.floor(DAYTIME.getTime() / 1000) }), DAYTIME)).toMatchObject({
      action: "card-replaced",
    });
  });

  it("'Update card and pay': an unpaid month's invoice is paid on the NEW card at once; the club stays past due until invoice.paid", async () => {
    setWorld({ billingStatus: "past_due" }, withCard({ paymentFailedAt: M1_END }));
    const inv = await invoicedMonth(1, "failed");
    await handleBillingEvent(cardSaved("replace-card", "user_colin"), MID_M1);
    expect(calls("payInvoice")).toEqual([{ invoiceId: inv, paymentMethodId: "pm_colin" }]);
    // The writer is asked with the unpaid month known: a no-op for past due.
    expect(h.state.stateCalls).toEqual([{ type: "card-added", unpaid: true }]);
    expect(h.state.org!.billingStatus).toBe("past_due");
  });

  it("refuses a session on another Customer, without the club fee marker, from a Connect account, or in subscription mode", async () => {
    setWorld({}, { stripeCustomerId: "cus_fake_1" });
    expect(await handleBillingEvent(cardSaved("add-card", "user_colin", { customer: "cus_other" }), DAYTIME)).toMatchObject({ reason: "customer-mismatch" });
    expect(await handleBillingEvent(cardSaved("add-card", "user_colin", { metadata: { orgId: ORG } }), DAYTIME)).toMatchObject({ reason: "not-club-fee" });
    expect(await handleBillingEvent(event("checkout.session.completed", { mode: "setup", metadata: { orgId: ORG, purpose: "club-fee", action: "add-card" } }, { account: "acct_collector" }), DAYTIME)).toMatchObject({ reason: "connect-event" });
    expect(await handleBillingEvent(cardSaved("add-card", "user_colin", { mode: "subscription" }), DAYTIME)).toMatchObject({ reason: "subscription-retired" });
    expect(h.state.billing!.stripePaymentMethodId).toBeNull();
  });

  it("the Connect side ignores this same session: applyCheckoutEvent sees no matchId", async () => {
    const e = cardSaved("add-card");
    expect(await applyCheckoutEvent("checkout.session.completed", e.data.object as Stripe.Checkout.Session)).toEqual({ action: "ignored", reason: "no-metadata" });
  });

  it("customer.subscription.* events: answered and ignored (none exist any more)", async () => {
    for (const t of ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]) {
      expect(await handleBillingEvent(event(t, { id: "sub_old", metadata: { orgId: ORG, purpose: "club-fee" } }), DAYTIME)).toMatchObject({ reason: "subscription-retired" });
    }
    expect(h.state.stateCalls).toEqual([]);
  });
});

// ── The webhook: invoices ────────────────────────────────────────────────

describe("webhook: a month's invoice (paid / failed / bank check / void)", () => {
  it("payment failed: the month 'failed', the club past due with 7 days, the DM noted for the daytime", async () => {
    setWorld({ billingStatus: "subscribed" }, withCard());
    const inv = await invoicedMonth();
    expect(await handleBillingEvent(invoiceEvent("invoice.payment_failed", inv), M1_END)).toEqual({ action: "month-failed", orgId: ORG });
    expect(h.state.months[0].status).toBe("failed");
    expect(h.state.org!.billingStatus).toBe("past_due");
    expect(h.state.billing!.graceEndsAt).toEqual(new Date(M1_END.getTime() + 7 * DAY));
    expect(h.state.paymentNotes).toEqual([expect.objectContaining({ orgId: ORG, invoiceId: inv, kind: "payment-failed" })]);
  });

  it("then paid: the month 'paid', the club 'subscribed' again", async () => {
    setWorld({ billingStatus: "subscribed" }, withCard());
    const inv = await invoicedMonth();
    await handleBillingEvent(invoiceEvent("invoice.payment_failed", inv), M1_END);
    await fake.payInvoice(inv, { paymentMethodId: "pm_colin" });
    expect(await handleBillingEvent(invoiceEvent("invoice.paid", inv), new Date(M1_END.getTime() + DAY))).toEqual({ action: "month-paid", orgId: ORG });
    expect(h.state.months[0]).toMatchObject({ status: "paid", paidAt: new Date(M1_END.getTime() + DAY) });
    expect(h.state.org!.billingStatus).toBe("subscribed");
  });

  it("a club PAUSED for the failed payment is resumed by the paid invoice, with a 'resumed' DM noted", async () => {
    setWorld({ billingStatus: "paused" }, withCard({ pausedReason: "payment-failed" }));
    const inv = await invoicedMonth(1, "failed");
    await fake.payInvoice(inv, { paymentMethodId: "pm_colin" });
    await handleBillingEvent(invoiceEvent("invoice.paid", inv), DAYTIME);
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.stateCalls).toEqual([{ type: "invoice-paid", noticeOnResume: "resumed" }]);
    expect(h.state.dms.map((d) => d.kind)).toEqual(["resumed"]);
  });

  it("OUT OF ORDER: a 'payment_failed' delivered after the invoice was paid is applied as paid (fresh read), never past due", async () => {
    setWorld({ billingStatus: "subscribed" }, withCard());
    const inv = await invoicedMonth();
    await fake.payInvoice(inv, { paymentMethodId: "pm_colin" });
    await handleBillingEvent(invoiceEvent("invoice.paid", inv), M1_END);
    expect(await handleBillingEvent(invoiceEvent("invoice.payment_failed", inv), M1_END)).toEqual({ action: "month-paid", orgId: ORG });
    expect(h.state.months[0].status).toBe("paid");
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.paymentNotes).toEqual([]);
  });

  it("two unpaid months: paying one does not clear past due", async () => {
    setWorld({ billingStatus: "past_due" }, withCard({ graceEndsAt: new Date(M1_END.getTime() + 7 * DAY) }));
    const inv1 = await invoicedMonth(1, "failed");
    await invoicedMonth(2, "failed");
    await fake.payInvoice(inv1, { paymentMethodId: "pm_colin" });
    await handleBillingEvent(invoiceEvent("invoice.paid", inv1), M1_END);
    expect(h.state.org!.billingStatus).toBe("past_due");
  });

  it("a bank check (3DS): noted with the invoice's own page; the month and the state are left", async () => {
    setWorld({ billingStatus: "subscribed" }, withCard());
    const inv = await invoicedMonth();
    expect(await handleBillingEvent(invoiceEvent("invoice.payment_action_required", inv), M1_END)).toEqual({ action: "payment-action", orgId: ORG });
    expect(h.state.paymentNotes).toEqual([expect.objectContaining({ kind: "payment-action", hostedUrl: `https://invoice.stripe.test/${inv}` })]);
    expect(h.state.months[0].status).toBe("invoiced");
    expect(h.state.stateCalls).toEqual([]);
  });

  it("voided or marked uncollectible in Stripe: the month is void", async () => {
    setWorld({ billingStatus: "subscribed" }, withCard());
    const inv = await invoicedMonth();
    await fake.voidInvoice(inv);
    expect(await handleBillingEvent(invoiceEvent("invoice.voided", inv), M1_END)).toEqual({ action: "month-void", orgId: ORG });
    expect(h.state.months[0].status).toBe("void");
  });

  it("M3: the only unpaid invoice voided in Stripe: the club leaves past due (back to subscribed); with another unpaid month it stays", async () => {
    setWorld({ billingStatus: "past_due" }, withCard({ graceEndsAt: new Date(M1_END.getTime() + 7 * DAY) }));
    const inv = await invoicedMonth(1, "failed");
    await fake.voidInvoice(inv);
    await handleBillingEvent(invoiceEvent("invoice.voided", inv), M1_END);
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.stateCalls).toEqual([{ type: "unpaid-cleared", noticeOnResume: "resumed" }]);

    setWorld({ billingStatus: "past_due" }, withCard());
    h.state.months = [];
    h.state.stateCalls = [];
    const one = await invoicedMonth(1, "failed");
    await invoicedMonth(2, "failed");
    await fake.voidInvoice(one);
    await handleBillingEvent(invoiceEvent("invoice.voided", one), M1_END);
    expect(h.state.org!.billingStatus).toBe("past_due");
  });

  it("M3: marked uncollectible while PAUSED for that payment: back on (subscribed)", async () => {
    setWorld({ billingStatus: "paused" }, withCard({ pausedReason: "payment-failed" }));
    const inv = await invoicedMonth(1, "failed");
    const stored = fake.state().invoices[inv] as { status: string };
    stored.status = "uncollectible";
    fake.putInvoice({ ...(await fake.retrieveInvoice(inv))!, status: "uncollectible" });
    await handleBillingEvent(invoiceEvent("invoice.marked_uncollectible", inv), M1_END);
    expect(h.state.months[0].status).toBe("void");
    expect(h.state.org!.billingStatus).toBe("subscribed");
  });

  it("re-delivery of invoice.paid: one change only (BillingEvent idempotency)", async () => {
    setWorld({ billingStatus: "past_due" }, withCard());
    const inv = await invoicedMonth(1, "failed");
    await fake.payInvoice(inv, { paymentMethodId: "pm_colin" });
    const e = invoiceEvent("invoice.paid", inv, {}, { id: "evt_paid_once" });
    await processBillingWebhook(e, M1_END);
    expect(await processBillingWebhook(e, M1_END)).toEqual({ status: 200, body: { received: true, duplicate: true } });
    expect(h.state.stateCalls).toHaveLength(1);
  });

  it("a handler error answers 500 and the retry runs cleanly", async () => {
    setWorld({ billingStatus: "subscribed" }, withCard());
    const inv = await invoicedMonth();
    const real = fake.retrieveInvoice.bind(fake);
    let once = true;
    fake.retrieveInvoice = async (id: string) => {
      if (once) {
        once = false;
        throw new Error("Stripe hiccup");
      }
      return real(id);
    };
    const e = invoiceEvent("invoice.payment_failed", inv, {}, { id: "evt_retry" });
    expect((await processBillingWebhook(e, M1_END)).status).toBe(500);
    expect((await processBillingWebhook(e, M1_END)).status).toBe(200);
    expect(h.state.months[0].status).toBe("failed");
  });

  it("ignored: not a club fee invoice, another club's month, an invoice on another customer, a Connect account", async () => {
    setWorld({ billingStatus: "subscribed" }, withCard());
    const inv = await invoicedMonth();
    expect(await handleBillingEvent(event("invoice.paid", { id: inv, metadata: { matchId: "m" } }), M1_END)).toMatchObject({ reason: "not-club-fee" });
    // An invoice naming a month that is not this club's (or does not exist).
    const stray = await fake.createMonthInvoice({ orgId: ORG, monthId: "cbm_9", customerId: "cus_fake_1", description: "d" });
    expect(await handleBillingEvent(event("invoice.paid", { id: stray.id, metadata: { orgId: ORG, purpose: "club-fee", monthId: "cbm_9" } }), M1_END)).toBeTruthy();
    expect(await handleBillingEvent(event("invoice.voided", { id: stray.id, metadata: { orgId: ORG, purpose: "club-fee", monthId: "cbm_9" } }), M1_END)).toMatchObject({ action: "ignored", reason: "stale-invoice.voided" });
    await fake.addMonthInvoiceItem({ orgId: ORG, monthId: "cbm_9", customerId: "cus_fake_1", description: "d", invoiceId: stray.id, amountPence: 999, productId: "p", taxRateId: "t" });
    await fake.finalizeInvoice(stray.id);
    await fake.payInvoice(stray.id, { paymentMethodId: "pm_colin" });
    expect(await handleBillingEvent(event("invoice.paid", { id: stray.id, metadata: { orgId: ORG, purpose: "club-fee", monthId: "cbm_9" } }), M1_END)).toEqual({ action: "month-not-found", orgId: ORG });
    expect(h.state.months[0].status).toBe("invoiced");
    h.state.billing!.stripeCustomerId = "cus_somebody_else";
    expect(await handleBillingEvent(invoiceEvent("invoice.paid", inv), M1_END)).toMatchObject({ reason: "customer-mismatch" });
    expect(await handleBillingEvent(event("invoice.paid", { id: inv, metadata: { orgId: ORG, purpose: "club-fee", monthId: "cbm_1" } }, { account: "acct_x" }), M1_END)).toMatchObject({ reason: "connect-event" });
  });

  it("a payment for a club that is no longer billed (Free): recorded paid, flagged for the owner, the state never moves", async () => {
    setWorld({ billingStatus: "exempt", billingPlan: "free" }, withCard());
    const inv = await invoicedMonth();
    await fake.payInvoice(inv, { paymentMethodId: "pm_colin" });
    await handleBillingEvent(invoiceEvent("invoice.paid", inv), M1_END);
    expect(h.state.months[0].status).toBe("paid");
    expect(h.state.ops).toContainEqual(expect.objectContaining({ title: expect.stringMatching(/not billed/) }));
    expect(h.state.stateCalls).toEqual([]);
  });
});

// ── Stop paying / Keep paying ────────────────────────────────────────────

describe("Stop paying and Keep paying (4.2)", () => {
  it("after the free month: billing ends with the CURRENT month (opened if the cron has not yet); no Stripe call", async () => {
    setWorld({ billingStatus: "subscribed" }, withCard());
    expect(await stopPaying({ orgId: ORG, userId: "user_colin", role: "contact", now: MID_M1 })).toEqual({ ok: true, freeMonth: false });
    expect(h.state.billing).toMatchObject({ cancelAtPeriodEnd: true, currentPeriodEnd: M1_END });
    expect(h.state.months.map((m) => m.index)).toEqual([1]);
    expect(fake.state().calls).toEqual([]);
    expect(h.state.org!.billingStatus).toBe("subscribed");
  });

  it("inside the free month: the card is removed at once and the club is back in its free month, same end date", async () => {
    setWorld({ billingStatus: "subscribed" }, withCard());
    expect(await stopPaying({ orgId: ORG, userId: "user_colin", role: "contact", now: DAYTIME })).toEqual({ ok: true, freeMonth: true });
    expect(fake.state().detached).toEqual(["pm_colin"]);
    expect(h.state.billing).toMatchObject({ stripePaymentMethodId: null, cardHolderUserId: null, trialEndsAt: TRIAL_ENDS });
    expect(h.state.org!.billingStatus).toBe("trial");
  });

  it("refused: not the contact, a payment overdue, no card, a club not billed", async () => {
    setWorld({ billingStatus: "subscribed" }, withCard());
    expect(await stopPaying({ orgId: ORG, userId: "user_olly", role: "viewer", now: MID_M1 })).toEqual({ ok: false, reason: "not-allowed" });
    setWorld({ billingStatus: "past_due" }, withCard());
    expect(await stopPaying({ orgId: ORG, userId: "user_colin", role: "contact", now: MID_M1 })).toEqual({ ok: false, reason: "past-due" });
    setWorld({ billingStatus: "subscribed" }, { stripeCustomerId: "cus_fake_1" });
    expect(await stopPaying({ orgId: ORG, userId: "user_colin", role: "contact", now: MID_M1 })).toEqual({ ok: false, reason: "no-card" });
    setWorld({ billingStatus: "exempt", billingPlan: "free" }, withCard());
    expect(await stopPaying({ orgId: ORG, userId: "user_colin", role: "contact", now: MID_M1 })).toEqual({ ok: false, reason: "not-billable" });
  });

  it("L3: Stop paying with BILLING_ENABLED off is refused (nothing recorded)", async () => {
    setWorld({ billingStatus: "subscribed" }, withCard());
    delete process.env.BILLING_ENABLED;
    expect(await stopPaying({ orgId: ORG, userId: "user_colin", role: "contact", now: MID_M1 })).toEqual({ ok: false, reason: "not-billable" });
    expect(h.state.billing!.cancelAtPeriodEnd).toBe(false);
    expect(h.state.months).toEqual([]);
  });

  it("L2: Keep paying after the stop took effect, with a month still UNPAID: refused (pay it first)", async () => {
    setWorld({ billingStatus: "paused" }, withCard({ pausedReason: "cancelled", cancelAtPeriodEnd: true }));
    await invoicedMonth(1, "failed");
    expect(await keepPaying({ orgId: ORG, userId: "user_colin", role: "contact", now: MID_M1 })).toEqual({ ok: false, reason: "past-due" });
    expect(h.state.org!.billingStatus).toBe("paused");
  });

  it("L2: Keep paying while past due with Stop pressed: the stop is undone (the debt is handled by Update card and pay)", async () => {
    setWorld({ billingStatus: "past_due" }, withCard({ cancelAtPeriodEnd: true }));
    expect(await keepPaying({ orgId: ORG, userId: "user_colin", role: "contact", now: MID_M1 })).toEqual({ ok: true });
    expect(h.state.billing!.cancelAtPeriodEnd).toBe(false);
  });

  it("L2: the stopping club's last invoice is paid late (it was declined at the close): THEN it pauses (cancelled)", async () => {
    setWorld({ billingStatus: "past_due" }, withCard({ cancelAtPeriodEnd: true, currentPeriodEnd: M1_END }));
    const inv = await invoicedMonth(1, "failed");
    await fake.payInvoice(inv, { paymentMethodId: "pm_colin" });
    await handleBillingEvent(invoiceEvent("invoice.paid", inv), new Date(M1_END.getTime() + 3 * DAY));
    // P3 (P2 review LOW 4): the stop is applied FIRST, so the club is never
    // moved back on (or told "MatchTime is back") on its way to the pause.
    expect(h.state.stateCalls.map((c) => c.type)).toEqual(["billing-stopped"]);
    expect(h.state.org!.billingStatus).toBe("paused");
    expect(h.state.billing!.pausedReason).toBe("cancelled");
  });

  it("Keep paying undoes it before the month ends", async () => {
    setWorld({ billingStatus: "subscribed" }, withCard({ cancelAtPeriodEnd: true, currentPeriodEnd: M1_END }));
    expect(await keepPaying({ orgId: ORG, userId: "user_colin", role: "contact", now: MID_M1 })).toEqual({ ok: true });
    expect(h.state.billing!.cancelAtPeriodEnd).toBe(false);
  });

  it("after the stop took effect (paused, cancelled) with the card still on: Keep paying starts again, nothing charged", async () => {
    setWorld({ billingStatus: "paused" }, withCard({ pausedReason: "cancelled", cancelAtPeriodEnd: true }));
    expect(await keepPaying({ orgId: ORG, userId: "user_colin", role: "contact", now: MID_M1 })).toEqual({ ok: true });
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.billing!.cancelAtPeriodEnd).toBe(false);
    expect(moneyCalls()).toEqual([]);
  });

  it("Keep paying with nothing stopped, or by someone else: refused", async () => {
    setWorld({ billingStatus: "subscribed" }, withCard());
    expect(await keepPaying({ orgId: ORG, userId: "user_colin", role: "contact", now: MID_M1 })).toEqual({ ok: false, reason: "not-stopping" });
    expect(await keepPaying({ orgId: ORG, userId: "user_olly", role: "viewer", now: MID_M1 })).toEqual({ ok: false, reason: "not-allowed" });
  });
});

// ── Remove my card ───────────────────────────────────────────────────────

describe("Remove my card (4.5 point 6)", () => {
  it("only the old card holder, only their own card", async () => {
    setWorld({ billingStatus: "subscribed" }, withCard());
    expect(await removeMyCard({ orgId: ORG, userId: "user_pat", role: "card-holder" })).toEqual({ ok: false, reason: "not-allowed" });
    expect(await removeMyCard({ orgId: ORG, userId: "user_colin", role: "contact" })).toEqual({ ok: false, reason: "not-allowed" });
    expect(await removeMyCard({ orgId: ORG, userId: "user_colin", role: "card-holder" })).toEqual({ ok: true });
    expect(fake.state().detached).toEqual(["pm_colin"]);
    expect(h.state.billing!.stripePaymentMethodId).toBeNull();
  });
});

// ── Plan changes and suspension ──────────────────────────────────────────

describe("plan changes and suspension (2A.6)", () => {
  it("Free: open sessions expired, the open month waived, unpaid invoices voided", async () => {
    setWorld({ billingStatus: "exempt", billingPlan: "free" }, withCard());
    const inv = await invoicedMonth(1, "failed");
    h.state.months.push({ ...h.state.months[0], id: "cbm_2", index: 2, status: "open", stripeInvoiceId: null, amountPence: null });
    expect(await onPlanChanged(ORG, MID_M1)).toEqual({ action: "forgiven", waived: 1, voided: 1, alreadyPaid: 0, failed: 0 });
    expect(calls("expireOpenCheckoutSessions")).toEqual([{ customerId: "cus_fake_1" }]);
    expect(h.state.months.map((m) => [m.index, m.status, m.reason])).toEqual([
      [1, "void", "free-plan"],
      [2, "waived", "free-plan"],
    ]);
    expect((await fake.retrieveInvoice(inv))?.status).toBe("void");
  });

  it("Standard to Custom (or back): nothing in Stripe but the session expiry; the close reads the lower price", async () => {
    setWorld({ billingStatus: "subscribed", billingPlan: "custom", billingPricePence: 500 }, withCard());
    expect(await onPlanChanged(ORG, MID_M1)).toEqual({ action: "none" });
    expect(fake.state().calls.map((c) => c.method)).toEqual(["expireOpenCheckoutSessions"]);
  });

  it("suspended: the open month waived, open sessions expired; earlier unpaid invoices left for the owner", async () => {
    setWorld({ billingStatus: "subscribed", approvalStatus: "suspended" }, withCard());
    const inv = await invoicedMonth(1, "failed");
    h.state.months.push({ ...h.state.months[0], id: "cbm_2", index: 2, status: "open", stripeInvoiceId: null, amountPence: null });
    expect(await onClubSuspended(ORG, MID_M1)).toEqual({ waived: 1 });
    // H1: the not-billable spell starts now, so no game while suspended is ever charged.
    expect(h.state.spells).toEqual([{ orgId: ORG, type: "mt.suspended", at: MID_M1 }]);
    expect(h.state.months.map((m) => m.status)).toEqual(["failed", "waived"]);
    expect((await fake.retrieveInvoice(inv))?.status).toBe("open");
  });
});

describe("the retired subscription code is gone", () => {
  it("no Portal, subscription sync, refund sweep or plan price sync", () => {
    for (const name of ["openClubPortal", "isClubPortalAvailable", "syncPlanToStripe", "cancelSubscriptionOnSuspend", "sweepOpenRefundIntents", "REFUND_SWEEP_MIN_AGE_MS"]) {
      expect(name in glue, name).toBe(false);
    }
  });
});

// ── Slice P3: the four LOW items from the P2 review ─────────────────────

describe("P2 review LOW fixes (slice P3)", () => {
  const SAME_SECOND = Math.floor(DAYTIME.getTime() / 1000);
  const sessionA = () => cardSaved("replace-card", "user_olly", { id: "cs_a", created: SAME_SECOND });
  const sessionB = () => cardSaved("replace-card", "user_pat", { id: "cs_b", created: SAME_SECOND });

  for (const order of ["a-then-b", "b-then-a", "concurrent"] as const) {
    it(`LOW 1: two card sessions created in the SAME second, ${order}: the higher session id wins, the other card is removed`, async () => {
      setWorld({ billingStatus: "subscribed" }, withCard());
      h.state.contact = "user_pat";
      if (order === "a-then-b") {
        await handleBillingEvent(sessionA(), DAYTIME);
        await handleBillingEvent(sessionB(), DAYTIME);
      } else if (order === "b-then-a") {
        await handleBillingEvent(sessionB(), DAYTIME);
        expect(await handleBillingEvent(sessionA(), DAYTIME)).toMatchObject({ action: "ignored", reason: "superseded-session" });
      } else {
        await Promise.all([handleBillingEvent(sessionA(), DAYTIME), handleBillingEvent(sessionB(), DAYTIME)]);
      }
      expect(h.state.billing).toMatchObject({ stripePaymentMethodId: "pm_pat", cardHolderUserId: "user_pat" });
      expect(fake.state().detached).toContain("pm_olly");
      expect(fake.state().detached).not.toContain("pm_pat");
      // The Customer's default is the winner's card.
      expect(fake.state().customers["cus_fake_1"]?.defaultPaymentMethod ?? "pm_pat").toBe("pm_pat");
      // Serialised per club by an advisory lock.
      expect(h.state.lockKeys.every((k) => k === `club-card-session:${ORG}`)).toBe(true);
    });
  }

  it("LOW 3: a suspension records the not-billable marker BEFORE touching Stripe (a Stripe error never loses it)", async () => {
    setWorld({ billingStatus: "subscribed", approvalStatus: "suspended" }, withCard());
    vi.spyOn(fake, "expireOpenCheckoutSessions").mockRejectedValueOnce(new Error("Stripe is down"));
    await expect(onClubSuspended(ORG, MID_M1)).rejects.toThrow("Stripe is down");
    expect(h.state.spells).toEqual([{ orgId: ORG, type: "mt.suspended", at: MID_M1 }]);
  });

  it("LOW 4: paused for a failed payment with Stop paying due: the paid invoice moves it to paused (cancelled), never 'MatchTime is back'", async () => {
    setWorld({ billingStatus: "paused" }, withCard({ pausedReason: "payment-failed", cancelAtPeriodEnd: true, currentPeriodEnd: M1_END }));
    const inv = await invoicedMonth(1, "failed");
    await fake.payInvoice(inv, { paymentMethodId: "pm_colin" });
    await handleBillingEvent(invoiceEvent("invoice.paid", inv), new Date(M1_END.getTime() + 9 * DAY));
    expect(h.state.stateCalls.map((c) => c.type)).toEqual(["billing-stopped"]);
    expect(h.state.org!.billingStatus).toBe("paused");
    expect(h.state.billing!.pausedReason).toBe("cancelled");
    expect(h.state.pending.filter((p) => p.kind === "resumed")).toEqual([]);
    expect(h.state.dms.filter((d) => d.kind === "resumed")).toEqual([]);
    // The money WAS taken: the receipt still goes.
    expect(h.state.receipts).toEqual(["cbm_1"]);
  });

  it("LOW 4: voided while past due with Stop paying due: straight to paused (cancelled), never back to subscribed first", async () => {
    setWorld({ billingStatus: "past_due" }, withCard({ cancelAtPeriodEnd: true, currentPeriodEnd: M1_END }));
    const inv = await invoicedMonth(1, "failed");
    await fake.voidInvoice(inv);
    await handleBillingEvent(invoiceEvent("invoice.voided", inv), new Date(M1_END.getTime() + 2 * DAY));
    expect(h.state.stateCalls.map((c) => c.type)).toEqual(["billing-stopped"]);
    expect(h.state.org!.billingStatus).toBe("paused");
    expect(h.state.pending.filter((p) => p.kind === "resumed")).toEqual([]);
  });

  it("LOW 4: no stop pending: a paid invoice still resumes as before, and the receipt is sent", async () => {
    setWorld({ billingStatus: "paused" }, withCard({ pausedReason: "payment-failed" }));
    const inv = await invoicedMonth(1, "failed");
    await fake.payInvoice(inv, { paymentMethodId: "pm_colin" });
    await handleBillingEvent(invoiceEvent("invoice.paid", inv), new Date(M1_END.getTime() + 9 * DAY));
    expect(h.state.stateCalls.map((c) => c.type)).toEqual(["invoice-paid"]);
    expect(h.state.org!.billingStatus).toBe("subscribed");
    expect(h.state.receipts).toEqual(["cbm_1"]);
  });
});
