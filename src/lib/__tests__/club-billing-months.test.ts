/**
 * CLUB FEE BILLING, slice P2: the month close and charge
 * (src/lib/club-billing-months.ts, the ONE writer of ClubBillingMonth).
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 2A, 3.6, 5.3, 6.
 *
 * The database is a small in-memory world (one or two clubs, their
 * ClubBilling rows and months); the month's games come from the REAL
 * `countClubMonth` over fixture matches (the loader is replaced by one that
 * returns them); `setBillingState` applies the REAL pure `nextBillingState`;
 * Stripe is the fake adapter. No network, no model, no production data.
 *
 * Fixture calendar: the free month ends Sun 1 Nov 2026 14:00 London, so
 * month 1 is 1 Nov to 30 Nov (four Tuesdays: 3, 10, 17, 24) and month 2
 * is 1 Dec to 31 Dec (five Tuesdays: 1, 8, 15, 22, 29). The club plays
 * on Tuesdays at 19:00.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CountClubMonthInput, CycleMatch } from "../club-billing-cycle-rules";

type Month = {
  id: string;
  orgId: string;
  index: number;
  startsAt: Date;
  endsAt: Date;
  priceAtStartPence: number;
  status: string;
  scheduled: number | null;
  played: number | null;
  pricePence: number | null;
  amountPence: number | null;
  reason: string | null;
  games: unknown;
  stripeInvoiceId: string | null;
  closedAt: Date | null;
  paidAt: Date | null;
  refundedPence: number;
  createdAt: Date;
  updatedAt: Date;
};
type Billing = {
  orgId: string;
  trialEndsAt: Date;
  graceEndsAt: Date | null;
  stripeCustomerId: string | null;
  stripePaymentMethodId: string | null;
  cardHolderUserId: string | null;
  cardLast4: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  pausedReason: string | null;
};
type Org = {
  id: string;
  name: string;
  approvalStatus: string;
  approvedAt: Date | null;
  billingStatus: string;
  billingPlan: string;
  billingPricePence: number | null;
  featureAttendance: boolean;
};

const h = vi.hoisted(() => {
  const state = {
    orgs: new Map<string, Org>(),
    billings: new Map<string, Billing>(),
    months: new Map<string, Month>(),
    /** The month's games, per club: matches the loader returns. */
    matches: new Map<string, CycleMatch[]>(),
    activityActive: true,
    seq: 0,
    ops: [] as Array<{ title: string; severity: string; dedupeKey?: string | null }>,
    stateCalls: [] as string[],
    /** Throw from the next month write whose data has this key. */
    failNextMonthWriteWith: null as string | null,
    /** Run once, just before the loader returns (to change the club mid close). */
    duringLoad: null as null | (() => void),
    /** BillingEvent rows (spans and spells). */
    events: [] as Array<{ id: string; type: string; orgId: string | null; receivedAt: Date }>,
  };

  const cmp = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      const cur = row[k];
      if (v instanceof Date) return cur instanceof Date && cur.getTime() === v.getTime();
      if (v && typeof v === "object") {
        const o = v as { in?: unknown[]; not?: unknown; lte?: Date; lt?: Date };
        if (o.in) return o.in.includes(cur);
        if ("not" in o) return cur !== o.not;
        if (o.lte) return cur instanceof Date && cur.getTime() <= o.lte.getTime();
        if (o.lt) return cur instanceof Date && cur.getTime() < o.lt.getTime();
        return false;
      }
      return cur === v;
    });

  const db = {
    billingEvent: {
      findFirst: vi.fn(async ({ where }: { where: { orgId: string | null; type: { in: string[] } } }) => {
        const rows = state.events
          .filter((e) => e.orgId === where.orgId && where.type.in.includes(e.type))
          .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
        return rows[0] ?? null;
      }),
      create: vi.fn(async ({ data }: { data: { id: string; type: string; orgId: string | null; receivedAt: Date } }) => {
        if (state.events.some((e) => e.id === data.id)) throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        state.events.push({ id: data.id, type: data.type, orgId: data.orgId, receivedAt: data.receivedAt });
        return data;
      }),
    },
    organisation: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const o = state.orgs.get(where.id);
        if (!o) return null;
        const b = state.billings.get(where.id);
        return { ...o, clubBilling: b ? { ...b } : null };
      }),
    },
    clubBilling: {
      findUnique: vi.fn(async ({ where }: { where: { orgId: string } }) => {
        const b = state.billings.get(where.orgId);
        return b ? { ...b } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Billing> }) => {
        const b = state.billings.get(where.orgId as string);
        if (!b) return { count: 0 };
        const { OR, ...rest } = where as Record<string, unknown> & { OR?: Array<Record<string, unknown>> };
        delete rest.orgId;
        if (!cmp(b as unknown as Record<string, unknown>, rest)) return { count: 0 };
        if (OR && !OR.some((w) => cmp(b as unknown as Record<string, unknown>, w) || (w.currentPeriodEnd === null && b.currentPeriodEnd === null))) {
          return { count: 0 };
        }
        Object.assign(b, data);
        return { count: 1 };
      }),
    },
    clubBillingMonth: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const m = state.months.get(where.id);
        return m ? { ...m } : null;
      }),
      findFirst: vi.fn(async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: { index: "asc" | "desc" } }) => {
        const rows = [...state.months.values()].filter((m) => cmp(m as unknown as Record<string, unknown>, where));
        rows.sort((a, b) => (orderBy?.index === "desc" ? b.index - a.index : a.index - b.index));
        return rows[0] ? { ...rows[0] } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...state.months.values()]
          .filter((m) => cmp(m as unknown as Record<string, unknown>, where))
          .sort((a, b) => a.orgId.localeCompare(b.orgId) || a.index - b.index)
          .map((m) => ({ ...m })),
      ),
      createMany: vi.fn(async ({ data }: { data: Array<Partial<Month>>; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const d of data) {
          if ([...state.months.values()].some((m) => m.orgId === d.orgId && m.index === d.index)) continue;
          const id = `cbm_${++state.seq}`;
          state.months.set(id, {
            id,
            status: "open",
            scheduled: null,
            played: null,
            pricePence: null,
            amountPence: null,
            reason: null,
            games: null,
            stripeInvoiceId: null,
            closedAt: null,
            paidAt: null,
            refundedPence: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...d,
          } as Month);
          count++;
        }
        return { count };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Month> }) => {
        if (state.failNextMonthWriteWith && state.failNextMonthWriteWith in data) {
          state.failNextMonthWriteWith = null;
          throw new Error("database went away");
        }
        let count = 0;
        for (const m of state.months.values()) {
          if (!cmp(m as unknown as Record<string, unknown>, where)) continue;
          Object.assign(m, data, data.updatedAt ? {} : { updatedAt: new Date() });
          count++;
        }
        return { count };
      }),
    },
  };
  return { state, db };
});

vi.mock("../db", () => ({ db: h.db }));
vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("../ops-alerts", () => ({
  BILLING_ALERT_KIND: "club-billing",
  recordOpsEvent: vi.fn(async (a: { title: string; severity: string; dedupeKey?: string | null }) => {
    h.state.ops.push(a);
    return true;
  }),
}));
vi.mock("../club-billing-month-loader", async () => {
  const rules = await vi.importActual<typeof import("../club-billing-cycle-rules")>("../club-billing-cycle-rules");
  return {
  loadClubMonthInput: vi.fn(async (_client: unknown, orgId: string, month: { startsAt: Date; endsAt: Date }): Promise<CountClubMonthInput | null> => {
    const org = h.state.orgs.get(orgId);
    if (!org) return null;
    // As the real loader: the club's spans and spells plus the global ones.
    const spans = rules.notChargedSpansFrom(
      h.state.events
        .filter((e) => (e.orgId === orgId || e.orgId === null) && e.receivedAt < month.endsAt)
        .map((e) => ({ type: e.type, at: e.receivedAt })),
    );
    const input: CountClubMonthInput = {
      startsAt: month.startsAt,
      endsAt: month.endsAt,
      activities: [
        { id: "act_tue", dayOfWeek: 2, time: "19:00", venue: "Pitch", isActive: h.state.activityActive, createdAt: new Date("2026-01-01T00:00:00Z") },
      ],
      matches: (h.state.matches.get(orgId) ?? []).filter((m) => m.date >= month.startsAt && m.date < month.endsAt),
      pauseSpans: spans,
      tracksAttendance: org.featureAttendance,
    };
    if (h.state.duringLoad) {
      const f = h.state.duringLoad;
      h.state.duringLoad = null;
      f();
    }
    return input;
  }),
  };
});
vi.mock("../club-billing", async () => {
  const rules = await vi.importActual<typeof import("../club-billing-rules")>("../club-billing-rules");
  return {
    setBillingState: vi.fn(async (orgId: string, event: { type: string }, now: Date) => {
      const org = h.state.orgs.get(orgId)!;
      const b = h.state.billings.get(orgId) ?? null;
      const t = rules.nextBillingState(
        { approvedAt: org.approvedAt, billingStatus: org.billingStatus, billingPlan: org.billingPlan, billing: b },
        event as never,
        now,
      );
      h.state.stateCalls.push(event.type);
      if (!t) return { ok: false, reason: "no-change" };
      const from = org.billingStatus;
      org.billingStatus = t.to;
      if (b) b.pausedReason = t.pausedReason;
      return { ok: true, from, to: t.to, resumed: t.resumes };
    }),
  };
});

import { setBillingStripeForTests } from "../stripe-billing";
import { createFakeBillingStripe, type FakeBillingStripe, type FakeInvoice } from "../stripe-billing-fake";
import { recordBillingFlagState, recordSuspended } from "../club-billing-spells";
import {
  CLOSING_STALE_MS,
  applyMonthInvoice,
  applyStopIfDue,
  closeMonth,
  closeNextDueMonth,
  openDueMonths,
  payUnpaidMonths,
  sweepUnwantedMonthInvoices,
  unpaidMonthIds,
  voidUnpaidMonthInvoices,
  waiveOpenMonths,
} from "../club-billing-months";

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const ORG = "org_sevens";
const TRIAL_ENDS = new Date("2026-11-01T14:00:00Z");
const M1_END = new Date("2026-12-01T00:00:00Z");
const M2_END = new Date("2027-01-01T00:00:00Z");
/** 10:00 London the morning after month 1 ends (GMT in December). */
const CLOSE_M1 = new Date("2026-12-01T10:00:00Z");
const CLOSE_M2 = new Date("2027-01-01T10:00:00Z");
const NOV_TUESDAYS = ["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24"];
const DEC_TUESDAYS = ["2026-12-01", "2026-12-08", "2026-12-15", "2026-12-22", "2026-12-29"];

type Week = "played" | "cancelled" | "nobody" | "none";

let fake: FakeBillingStripe;
const ENV_KEYS = ["BILLING_ENABLED", "STRIPE_CLUB_PRODUCT_ID", "STRIPE_CLUB_TAX_RATE_ID"] as const;
const savedEnv: Record<string, string | undefined> = {};

function club(over: Partial<Org> = {}, billing: Partial<Billing> = {}, orgId = ORG) {
  h.state.orgs.set(orgId, {
    id: orgId,
    name: "Card Sevens",
    approvalStatus: "approved",
    approvedAt: new Date("2026-10-02T14:00:00Z"),
    billingStatus: "subscribed",
    billingPlan: "standard",
    billingPricePence: null,
    featureAttendance: true,
    ...over,
  });
  h.state.billings.set(orgId, {
    orgId,
    trialEndsAt: TRIAL_ENDS,
    graceEndsAt: null,
    stripeCustomerId: "cus_sevens",
    stripePaymentMethodId: "pm_colin",
    cardHolderUserId: "user_colin",
    cardLast4: "4242",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    pausedReason: null,
    ...billing,
  });
}

/** The club's Tuesdays, each played, cancelled, ended with nobody IN, or no row. */
function weeks(days: string[], plan: Week[], orgId = ORG) {
  const list = h.state.matches.get(orgId) ?? [];
  days.forEach((d, i) => {
    const w = plan[i];
    if (w === "none") return;
    list.push({
      id: `m_${d}`,
      activityId: "act_tue",
      date: new Date(`${d}T19:00:00Z`),
      status: w === "cancelled" ? "CANCELLED" : "COMPLETED",
      isHistorical: false,
      redScore: null,
      yellowScore: null,
      confirmedCount: w === "played" ? 6 : 0,
    });
  });
  h.state.matches.set(orgId, list);
}

function monthsOf(orgId = ORG) {
  return [...h.state.months.values()].filter((m) => m.orgId === orgId).sort((a, b) => a.index - b.index);
}
const month = (index: number, orgId = ORG) => monthsOf(orgId).find((m) => m.index === index)!;
const invoices = () => Object.values(fake.state().invoices).filter((i): i is FakeInvoice => "items" in i && i.status !== "deleted");
const stripeCalls = () => fake.state().calls.map((c) => c.method);

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.BILLING_ENABLED = "1";
  process.env.STRIPE_CLUB_PRODUCT_ID = "prod_club";
  process.env.STRIPE_CLUB_TAX_RATE_ID = "txr_vat_inclusive";
  h.state.orgs.clear();
  h.state.billings.clear();
  h.state.months.clear();
  h.state.matches.clear();
  h.state.activityActive = true;
  h.state.ops = [];
  h.state.stateCalls = [];
  h.state.failNextMonthWriteWith = null;
  h.state.duringLoad = null;
  h.state.events = [];
  fake = createFakeBillingStripe();
  setBillingStripeForTests(fake);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setBillingStripeForTests(null);
  vi.restoreAllMocks();
});

/** Month 1 (and 2 when asked) opened the way the cron would. */
async function openThrough(at: Date) {
  await openDueMonths(ORG, at);
}

// ── Opening ──────────────────────────────────────────────────────────────

describe("opening months (plan 6)", () => {
  it("nothing inside the free month; month 1 at the free month's end, at any hour, with the plan's price", async () => {
    club({ billingStatus: "trial" }, { stripePaymentMethodId: null });
    expect(await openDueMonths(ORG, new Date(TRIAL_ENDS.getTime() - 1))).toEqual({ opened: [] });
    expect(await openDueMonths(ORG, TRIAL_ENDS)).toEqual({ opened: [1] });
    expect(month(1)).toMatchObject({ index: 1, startsAt: TRIAL_ENDS, endsAt: M1_END, priceAtStartPence: 999, status: "open" });
    expect(h.state.billings.get(ORG)!.currentPeriodEnd).toEqual(M1_END);
  });

  it("is idempotent: a second run (or a racing one) opens nothing more", async () => {
    club();
    await openDueMonths(ORG, TRIAL_ENDS);
    await Promise.all([openDueMonths(ORG, TRIAL_ENDS), openDueMonths(ORG, TRIAL_ENDS)]);
    expect(monthsOf()).toHaveLength(1);
  });

  it("a Custom plan's month opens at its monthly maximum", async () => {
    club({ billingPlan: "custom", billingPricePence: 500 });
    await openDueMonths(ORG, TRIAL_ENDS);
    expect(month(1).priceAtStartPence).toBe(500);
  });

  it("H1: only the month containing now opens, never a missed one (no catch-up)", async () => {
    club();
    await openDueMonths(ORG, new Date("2027-01-05T12:00:00Z"));
    expect(monthsOf().map((m) => m.index)).toEqual([3]);
    expect(h.state.billings.get(ORG)!.currentPeriodEnd).toEqual(new Date("2027-02-01T00:00:00Z"));
  });

  it("never for an exempt club, Sutton FC's shape, a Free plan, a suspended club, an unapproved one or with the flag off", async () => {
    const cases: Array<[string, Partial<Org>]> = [
      ["exempt", { billingStatus: "exempt" }],
      ["sutton", { approvedAt: null, billingStatus: "exempt" }],
      ["free", { billingPlan: "free", billingStatus: "exempt" }],
      ["suspended", { approvalStatus: "suspended" }],
      ["pending", { approvalStatus: "pending" }],
    ];
    for (const [name, over] of cases) {
      h.state.months.clear();
      club(over);
      const r = await openDueMonths(ORG, CLOSE_M1);
      expect(r.opened, name).toEqual([]);
      expect(monthsOf(), name).toHaveLength(0);
    }
    club();
    delete process.env.BILLING_ENABLED;
    expect(await openDueMonths(ORG, CLOSE_M1)).toEqual({ opened: [], skipped: "off" });
    expect(monthsOf()).toHaveLength(0);
  });

  it("not while paused because removed from the group or after Stop paying; yes while paused for no card", async () => {
    club({ billingStatus: "paused" }, { pausedReason: "removed" });
    expect((await openDueMonths(ORG, CLOSE_M1)).opened).toEqual([]);
    club({ billingStatus: "paused" }, { pausedReason: "cancelled" });
    expect((await openDueMonths(ORG, CLOSE_M1)).opened).toEqual([]);
    club({ billingStatus: "paused" }, { pausedReason: "no-card", stripePaymentMethodId: null });
    expect((await openDueMonths(ORG, CLOSE_M1)).opened).toEqual([2]);
  });

  it("Stop paying: no month after the one it was pressed in", async () => {
    club({}, { cancelAtPeriodEnd: true, currentPeriodEnd: M1_END });
    await openDueMonths(ORG, TRIAL_ENDS);
    await openDueMonths(ORG, CLOSE_M1);
    expect(monthsOf().map((m) => m.index)).toEqual([1]);
  });
});

// ── Closing: what each count charges ─────────────────────────────────────

describe("closing a month: each count to an amount, or to no invoice at all (2A.4)", () => {
  it("Kemal's example: 3 of 4 played is £7.49, ONE invoice, tax inclusive, on the club's card", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "cancelled", "played"]);
    await openThrough(TRIAL_ENDS);
    const r = await closeMonth(month(1).id, CLOSE_M1);
    expect(r).toMatchObject({ outcome: "paid", amountPence: 749 });
    expect(month(1)).toMatchObject({ status: "paid", scheduled: 4, played: 3, pricePence: 999, amountPence: 749 });
    const [inv] = invoices();
    expect(invoices()).toHaveLength(1);
    expect(month(1).stripeInvoiceId).toBe(inv.id);
    expect(inv).toMatchObject({ customerId: "cus_sevens", status: "paid", totalPence: 749, metadata: { orgId: ORG, purpose: "club-fee", monthId: month(1).id } });
    expect(inv.params).toMatchObject({ collection_method: "charge_automatically", pending_invoice_items_behavior: "exclude", auto_advance: false });
    // L4: no club name (it can change between retries of the same key).
    expect(inv.params.description).toBe("MatchTime club fee, 1 Nov 2026 to 30 Nov 2026: 3 of 4 games played");
    expect(inv.items).toHaveLength(1);
    expect(inv.items[0]).toMatchObject({
      price_data: { currency: "gbp", product: "prod_club", unit_amount: 749 },
      tax_rates: ["txr_vat_inclusive"],
    });
    expect(inv.payAttempts).toEqual([{ paymentMethodId: "pm_colin", outcome: "succeed" }]);
    expect(fake.state().idempotency).toHaveProperty(`club-fee-invoice-${month(1).id}`);
    expect(fake.state().idempotency).toHaveProperty(`club-fee-item-${month(1).id}`);
  });

  it("Kemal's example: 4 of 5 played is £7.99", async () => {
    club();
    weeks(DEC_TUESDAYS, ["played", "played", "nobody", "played", "played"]);
    await openThrough(new Date("2026-12-01T01:00:00Z"));
    const r = await closeMonth(month(2).id, CLOSE_M2);
    expect(r).toMatchObject({ outcome: "paid", amountPence: 799 });
    expect(month(2)).toMatchObject({ scheduled: 5, played: 4, amountPence: 799 });
  });

  it("all played: the full £9.99", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await openThrough(TRIAL_ENDS);
    expect(await closeMonth(month(1).id, CLOSE_M1)).toMatchObject({ amountPence: 999 });
  });

  it("Kemal's example: 0 of 4 played is NOTHING: no invoice, no Stripe call, recorded with its reason and no amount", async () => {
    club();
    weeks(NOV_TUESDAYS, ["cancelled", "nobody", "cancelled", "none"]);
    await openThrough(TRIAL_ENDS);
    expect(await closeMonth(month(1).id, CLOSE_M1)).toMatchObject({ outcome: "no-games", amountPence: null });
    expect(month(1)).toMatchObject({ status: "no-games", scheduled: 4, played: 0, amountPence: null, reason: "none-played", stripeInvoiceId: null });
    expect(invoices()).toHaveLength(0);
    expect(stripeCalls()).toEqual([]);
  });

  it("Kemal's example: a summer break with no games at all (weekly game switched off, no matches): nothing", async () => {
    club();
    h.state.activityActive = false;
    await openThrough(TRIAL_ENDS);
    expect(await closeMonth(month(1).id, CLOSE_M1)).toMatchObject({ outcome: "no-games" });
    expect(month(1)).toMatchObject({ status: "no-games", scheduled: 0, played: 0, amountPence: null, reason: "none-scheduled" });
    expect(stripeCalls()).toEqual([]);
  });

  it("a Custom £5 maximum: 3 of 4 is £3.75", async () => {
    club({ billingPlan: "custom", billingPricePence: 500 });
    weeks(NOV_TUESDAYS, ["played", "played", "played", "cancelled"]);
    await openThrough(TRIAL_ENDS);
    expect(await closeMonth(month(1).id, CLOSE_M1)).toMatchObject({ amountPence: 375 });
  });

  it("a Custom £1 maximum, 1 of 4 is 25p: under Stripe's 30p minimum, NOTHING charged, no amount stored", async () => {
    club({ billingPlan: "custom", billingPricePence: 100 });
    weeks(NOV_TUESDAYS, ["played", "cancelled", "cancelled", "cancelled"]);
    await openThrough(TRIAL_ENDS);
    expect(await closeMonth(month(1).id, CLOSE_M1)).toMatchObject({ outcome: "below-minimum", amountPence: null });
    expect(month(1)).toMatchObject({ status: "below-minimum", played: 1, scheduled: 4, amountPence: null, reason: "under-30p" });
    expect(stripeCalls()).toEqual([]);
  });

  it("the plan changed during the month: the LOWER of the price at the start and at the close", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "played", "cancelled"]);
    await openThrough(TRIAL_ENDS);
    const o = h.state.orgs.get(ORG)!;
    o.billingPlan = "custom";
    o.billingPricePence = 500;
    expect(await closeMonth(month(1).id, CLOSE_M1)).toMatchObject({ amountPence: 375 });
    expect(month(1).pricePence).toBe(500);
    // And never the higher one.
    h.state.months.clear();
    o.billingPlan = "standard";
    o.billingPricePence = null;
    h.state.billings.get(ORG)!.currentPeriodEnd = null;
    await openThrough(TRIAL_ENDS);
    h.state.months.get(month(1).id)!.priceAtStartPence = 500;
    expect(await closeMonth(month(1).id, CLOSE_M1)).toMatchObject({ amountPence: 375 });
  });

  it("games played but NO card on file: recorded 'no-card', nothing charged, no Stripe call", async () => {
    club({ billingStatus: "paused" }, { pausedReason: "no-card", stripePaymentMethodId: null, cardHolderUserId: null });
    weeks(NOV_TUESDAYS, ["played", "played", "cancelled", "none"]);
    await openThrough(TRIAL_ENDS);
    expect(await closeMonth(month(1).id, CLOSE_M1)).toMatchObject({ outcome: "no-card", amountPence: null });
    expect(month(1)).toMatchObject({ status: "no-card", reason: "no-card", played: 2, amountPence: null });
    expect(stripeCalls()).toEqual([]);
  });

  it("a declined card: the invoice stays open, the month 'invoiced' (the payment_failed webhook takes it from there)", async () => {
    club();
    fake.setPayOutcome("pm_colin", "decline");
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await openThrough(TRIAL_ENDS);
    expect(await closeMonth(month(1).id, CLOSE_M1)).toMatchObject({ outcome: "invoiced", amountPence: 999 });
    expect(invoices()[0].status).toBe("open");
    expect(month(1).status).toBe("invoiced");
  });
});

// ── Closing: who is never charged ────────────────────────────────────────

describe("closing a month: exempt, Free, suspended and the kill switch", () => {
  beforeEach(() => weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]));

  it("a club on the Free plan (exempt): waived, no Stripe call", async () => {
    club();
    await openThrough(TRIAL_ENDS);
    Object.assign(h.state.orgs.get(ORG)!, { billingPlan: "free", billingStatus: "exempt" });
    expect(await closeMonth(month(1).id, CLOSE_M1)).toMatchObject({ outcome: "waived", reason: "free-plan" });
    expect(month(1)).toMatchObject({ status: "waived", amountPence: null });
    expect(stripeCalls()).toEqual([]);
  });

  it("a suspended club: waived", async () => {
    club();
    await openThrough(TRIAL_ENDS);
    h.state.orgs.get(ORG)!.approvalStatus = "suspended";
    expect(await closeMonth(month(1).id, CLOSE_M1)).toMatchObject({ outcome: "waived", reason: "suspended" });
    expect(stripeCalls()).toEqual([]);
  });

  it("Sutton FC's shape (approvedAt NULL) with a stray month row: waived, never charged", async () => {
    club();
    await openThrough(TRIAL_ENDS);
    Object.assign(h.state.orgs.get(ORG)!, { approvedAt: null, billingStatus: "exempt" });
    expect(await closeMonth(month(1).id, CLOSE_M1)).toMatchObject({ outcome: "waived", reason: "exempt-club" });
    expect(stripeCalls()).toEqual([]);
  });

  it("BILLING_ENABLED off: nothing closes, nothing is charged", async () => {
    club();
    await openThrough(TRIAL_ENDS);
    delete process.env.BILLING_ENABLED;
    expect(await closeMonth(month(1).id, CLOSE_M1)).toEqual({ skipped: "off", monthId: month(1).id });
    expect(await closeNextDueMonth(ORG, CLOSE_M1)).toEqual({ skipped: "off" });
    expect(month(1).status).toBe("open");
    expect(stripeCalls()).toEqual([]);
  });

  it("DEFENCE IN DEPTH: the club is set Free while its month is being counted: re-checked right before the money, waived", async () => {
    club();
    await openThrough(TRIAL_ENDS);
    h.state.duringLoad = () => Object.assign(h.state.orgs.get(ORG)!, { billingPlan: "free", billingStatus: "exempt" });
    expect(await closeMonth(month(1).id, CLOSE_M1)).toMatchObject({ outcome: "waived", reason: "free-plan" });
    expect(invoices()).toHaveLength(0);
  });

  it("Stripe not set up (no product id): the month goes back to open for the next run, recorded on /admin/health", async () => {
    club();
    delete process.env.STRIPE_CLUB_PRODUCT_ID;
    await openThrough(TRIAL_ENDS);
    expect(await closeMonth(month(1).id, CLOSE_M1)).toEqual({ skipped: "not-set-up", monthId: month(1).id });
    expect(month(1).status).toBe("open");
    expect(stripeCalls()).toEqual([]);
    expect(h.state.ops.map((o) => o.title)).toEqual([expect.stringMatching(/not set up/i)]);
  });
});

// ── Closing: when ────────────────────────────────────────────────────────

describe("closing a month: when (plan 6)", () => {
  it("not before 6 hours after the month ends", async () => {
    club();
    await openThrough(TRIAL_ENDS);
    expect(await closeMonth(month(1).id, new Date(M1_END.getTime() + 6 * HOUR - 1))).toEqual({ skipped: "not-due", monthId: month(1).id });
  });

  it("closeNextDueMonth: daytime only (10:00 to 20:00 London), the LOWEST open month first, one per run", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    weeks(DEC_TUESDAYS, ["played", "played", "played", "played", "played"]);
    await openDueMonths(ORG, TRIAL_ENDS);
    await openDueMonths(ORG, new Date("2026-12-01T01:00:00Z"));
    expect(await closeNextDueMonth(ORG, new Date("2027-01-02T03:00:00Z"))).toEqual({ skipped: "night" });
    expect(await closeNextDueMonth(ORG, new Date("2027-01-02T11:00:00Z"))).toMatchObject({ outcome: "paid", index: 1 });
    expect(month(2).status).toBe("open");
    expect(await closeNextDueMonth(ORG, new Date("2027-01-02T12:00:00Z"))).toMatchObject({ outcome: "paid", index: 2 });
    expect(await closeNextDueMonth(ORG, new Date("2027-01-02T13:00:00Z"))).toEqual({ skipped: "none" });
  });
});

// ── Idempotency ──────────────────────────────────────────────────────────

describe("idempotency: double cron, retry after failure", () => {
  beforeEach(() => weeks(NOV_TUESDAYS, ["played", "played", "cancelled", "played"]));

  it("two cron runs at once: ONE invoice, ONE charge (compare-and-set open to closing)", async () => {
    club();
    await openThrough(TRIAL_ENDS);
    const id = month(1).id;
    const [a, b] = await Promise.all([closeMonth(id, CLOSE_M1), closeMonth(id, CLOSE_M1)]);
    expect([a, b].filter((r) => "outcome" in r)).toHaveLength(1);
    expect([a, b].filter((r) => "skipped" in r && r.skipped === "busy")).toHaveLength(1);
    expect(invoices()).toHaveLength(1);
    expect(invoices()[0].payAttempts).toHaveLength(1);
  });

  it("a closed month is never closed again", async () => {
    club();
    await openThrough(TRIAL_ENDS);
    await closeMonth(month(1).id, CLOSE_M1);
    expect(await closeMonth(month(1).id, new Date(CLOSE_M1.getTime() + HOUR))).toEqual({ skipped: "already-closed", monthId: month(1).id });
    expect(invoices()).toHaveLength(1);
  });

  it("a crash after Stripe made the invoice but before we stored it: a retry within the key window finds the SAME invoice", async () => {
    club();
    await openThrough(TRIAL_ENDS);
    const id = month(1).id;
    h.state.failNextMonthWriteWith = "stripeInvoiceId";
    expect(await closeMonth(id, CLOSE_M1)).toMatchObject({ error: expect.stringMatching(/database went away/) });
    expect(month(1).status).toBe("closing");
    // Too soon: another run may still be working on it.
    expect(await closeMonth(id, new Date(CLOSE_M1.getTime() + MIN))).toEqual({ skipped: "busy", monthId: id });
    // Stale: taken over, and the invoice is the same one.
    h.state.months.get(id)!.updatedAt = new Date(CLOSE_M1.getTime() - CLOSING_STALE_MS - MIN);
    expect(await closeMonth(id, CLOSE_M1)).toMatchObject({ outcome: "paid", amountPence: 749 });
    expect(invoices()).toHaveLength(1);
    expect(invoices()[0].items).toHaveLength(1);
    expect(invoices()[0].payAttempts).toHaveLength(1);
  });

  it("the same crash retried AFTER the 24 hour key window: found by its month id, never a second invoice", async () => {
    club();
    await openThrough(TRIAL_ENDS);
    const id = month(1).id;
    h.state.failNextMonthWriteWith = "stripeInvoiceId";
    await closeMonth(id, CLOSE_M1);
    fake.forgetIdempotencyKeys();
    h.state.months.get(id)!.updatedAt = new Date(0);
    expect(await closeMonth(id, new Date(CLOSE_M1.getTime() + 25 * HOUR))).toMatchObject({ outcome: "paid" });
    expect(invoices()).toHaveLength(1);
    expect(invoices()[0].items).toHaveLength(1);
  });

  it("a Stripe failure part way (the finalise fails): the retry completes the same invoice", async () => {
    club();
    await openThrough(TRIAL_ENDS);
    const id = month(1).id;
    const real = fake.finalizeInvoice.bind(fake);
    let once = true;
    fake.finalizeInvoice = async (inv: string) => {
      if (once) {
        once = false;
        throw new Error("Stripe is down");
      }
      return real(inv);
    };
    expect(await closeMonth(id, CLOSE_M1)).toMatchObject({ error: expect.stringMatching(/Stripe is down/) });
    h.state.months.get(id)!.updatedAt = new Date(0);
    expect(await closeMonth(id, CLOSE_M1)).toMatchObject({ outcome: "paid", amountPence: 749 });
    expect(invoices()).toHaveLength(1);
    expect(invoices()[0].items).toHaveLength(1);
  });

  it("the count changed between the crash and the retry (a late score): the STORED amount is charged, never a second figure", async () => {
    club();
    await openThrough(TRIAL_ENDS);
    const id = month(1).id;
    h.state.failNextMonthWriteWith = "stripeInvoiceId";
    await closeMonth(id, CLOSE_M1);
    // The cancelled week now looks played.
    const cancelled = h.state.matches.get(ORG)!.find((m) => m.status === "CANCELLED")!;
    Object.assign(cancelled, { status: "COMPLETED", confirmedCount: 5 });
    h.state.months.get(id)!.updatedAt = new Date(0);
    expect(await closeMonth(id, CLOSE_M1)).toMatchObject({ outcome: "paid", amountPence: 749 });
    expect(invoices()[0].totalPence).toBe(749);
  });

  it("L4: the club renamed between a crash and the retry: the SAME invoice, no idempotency error (no name in the request)", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "cancelled", "played"]);
    await openThrough(TRIAL_ENDS);
    const id = month(1).id;
    h.state.failNextMonthWriteWith = "stripeInvoiceId";
    await closeMonth(id, CLOSE_M1);
    h.state.orgs.get(ORG)!.name = "Card Sevens Renamed";
    fake.findMonthInvoices = async () => []; // search not caught up yet: only the key protects
    h.state.months.get(id)!.updatedAt = new Date(0);
    expect(await closeMonth(id, CLOSE_M1)).toMatchObject({ outcome: "paid", amountPence: 749 });
    expect(invoices()).toHaveLength(1);
  });

  it("M4: a Tax Rate that is not inclusive (or not 20%, or archived): refused BEFORE any invoice is made, flagged critical", async () => {
    process.env.STRIPE_CLUB_TAX_RATE_ID = "txr_exclusive_vat";
    club();
    await openThrough(TRIAL_ENDS);
    expect(await closeMonth(month(1).id, CLOSE_M1)).toMatchObject({ error: expect.stringMatching(/tax rate/i) });
    expect(invoices()).toHaveLength(0);
    expect(h.state.ops).toContainEqual(expect.objectContaining({ severity: "critical" }));
  });

  it("M4: amount_due is not the amount (a customer credit balance, a stray item): NOT finalised and nothing taken, flagged critical", async () => {
    club();
    fake.putCustomerBalance("cus_sevens", 100);
    await openThrough(TRIAL_ENDS);
    expect(await closeMonth(month(1).id, CLOSE_M1)).toMatchObject({ error: expect.stringMatching(/amount due/i) });
    expect(invoices()[0]).toMatchObject({ status: "draft", payAttempts: [] });
    expect(h.state.ops).toContainEqual(expect.objectContaining({ severity: "critical" }));
  });
});

// ── Stop paying ──────────────────────────────────────────────────────────

describe("Stop paying at the month end (4.2)", () => {
  it("the last month is charged for its games as usual, THEN the club is paused (cancelled)", async () => {
    club({}, { cancelAtPeriodEnd: true });
    weeks(NOV_TUESDAYS, ["played", "played", "played", "cancelled"]);
    await openThrough(TRIAL_ENDS);
    expect(h.state.billings.get(ORG)!.currentPeriodEnd).toEqual(M1_END);
    const r = await closeMonth(month(1).id, CLOSE_M1);
    expect(r).toMatchObject({ outcome: "paid", amountPence: 749, stopped: true });
    expect(h.state.stateCalls).toEqual(["billing-stopped"]);
    expect(h.state.orgs.get(ORG)!.billingStatus).toBe("paused");
    expect(h.state.billings.get(ORG)!.pausedReason).toBe("cancelled");
  });

  it("L2: the last month's charge DECLINED: the club is NOT paused yet; it pauses (cancelled) once that invoice is paid", async () => {
    club({}, { cancelAtPeriodEnd: true });
    fake.setPayOutcome("pm_colin", "decline");
    weeks(NOV_TUESDAYS, ["played", "played", "played", "cancelled"]);
    await openThrough(TRIAL_ENDS);
    const r = await closeMonth(month(1).id, CLOSE_M1);
    expect(r).toMatchObject({ outcome: "invoiced" });
    expect(r).not.toMatchObject({ stopped: true });
    expect(h.state.stateCalls).toEqual([]);
    const inv = (await fake.retrieveInvoice(month(1).stripeInvoiceId!))!;
    await applyMonthInvoice({ orgId: ORG, monthId: month(1).id, invoice: { ...inv, status: "paid" }, kind: "paid", now: CLOSE_M2 });
    expect(await applyStopIfDue(ORG, CLOSE_M2)).toBe(true);
    expect(h.state.orgs.get(ORG)!.billingStatus).toBe("paused");
    expect(h.state.billings.get(ORG)!.pausedReason).toBe("cancelled");
  });

  it("a stop that is for a LATER month does not pause the club at this close", async () => {
    club({}, { cancelAtPeriodEnd: true });
    await openDueMonths(ORG, TRIAL_ENDS);
    h.state.billings.get(ORG)!.cancelAtPeriodEnd = false;
    await openDueMonths(ORG, new Date("2026-12-01T01:00:00Z"));
    h.state.billings.get(ORG)!.cancelAtPeriodEnd = true;
    expect(h.state.billings.get(ORG)!.currentPeriodEnd).toEqual(M2_END);
    expect(await closeMonth(month(1).id, CLOSE_M1)).not.toMatchObject({ stopped: true });
    expect(h.state.stateCalls).toEqual([]);
  });
});

// ── Free, suspend, void ──────────────────────────────────────────────────

describe("Free and suspend (2A.6)", () => {
  it("waiveOpenMonths: every OPEN month waived with its reason; closed ones untouched", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await openDueMonths(ORG, TRIAL_ENDS);
    await openDueMonths(ORG, new Date("2026-12-01T01:00:00Z"));
    await closeMonth(month(1).id, CLOSE_M1);
    expect(await waiveOpenMonths(ORG, "suspended", CLOSE_M1)).toBe(1);
    expect(month(1).status).toBe("paid");
    expect(month(2)).toMatchObject({ status: "waived", reason: "suspended", amountPence: null });
  });

  it("voidUnpaidMonthInvoices (Free): every unpaid club fee invoice is voided and its month marked void; a paid one is left", async () => {
    club();
    fake.setPayOutcome("pm_colin", "decline");
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await openThrough(TRIAL_ENDS);
    await closeMonth(month(1).id, CLOSE_M1);
    await applyMonthInvoice({ orgId: ORG, monthId: month(1).id, invoice: (await fake.retrieveInvoice(month(1).stripeInvoiceId!))!, kind: "failed", now: CLOSE_M1 });
    expect(month(1).status).toBe("failed");
    expect(await voidUnpaidMonthInvoices(ORG, CLOSE_M1)).toEqual({ voided: 1, alreadyPaid: 0, failed: 0 });
    expect(month(1)).toMatchObject({ status: "void", reason: "free-plan" });
    expect(invoices()[0].status).toBe("void");
  });

  it("a payment that got through before the void: left paid, flagged for the owner (refund by hand if it should be)", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await openThrough(TRIAL_ENDS);
    fake.setPayOutcome("pm_colin", "decline");
    await closeMonth(month(1).id, CLOSE_M1);
    // Stripe's own retry took it meanwhile; our row still says invoiced.
    fake.setPayOutcome("pm_colin", "succeed");
    await fake.payInvoice(month(1).stripeInvoiceId!, { paymentMethodId: "pm_colin" });
    expect(await voidUnpaidMonthInvoices(ORG, CLOSE_M1)).toEqual({ voided: 0, alreadyPaid: 1, failed: 0 });
    expect(h.state.ops).toContainEqual(expect.objectContaining({ title: expect.stringMatching(/paid/i) }));
  });

  it("M2: a month stuck CLOSING with its invoice already made (a crash) is voided too when the club goes Free, by the action and by the sweep", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await openThrough(TRIAL_ENDS);
    const real = fake.finalizeInvoice.bind(fake);
    fake.finalizeInvoice = async () => {
      throw new Error("Stripe is down");
    };
    await closeMonth(month(1).id, CLOSE_M1);
    fake.finalizeInvoice = real;
    expect(month(1)).toMatchObject({ status: "closing", stripeInvoiceId: expect.stringMatching(/^in_fake_/) });
    Object.assign(h.state.orgs.get(ORG)!, { billingPlan: "free", billingStatus: "exempt" });
    expect(await voidUnpaidMonthInvoices(ORG, CLOSE_M1)).toEqual({ voided: 1, alreadyPaid: 0, failed: 0 });
    expect(month(1).status).toBe("void");
    expect(invoices()).toHaveLength(0); // the draft was deleted
    // And the close, retried later, charges nothing.
    h.state.months.get(month(1).id)!.updatedAt = new Date(0);
    expect(await closeMonth(month(1).id, CLOSE_M1)).toEqual({ skipped: "already-closed", monthId: month(1).id });
  });

  it("M2: the sweep includes a stuck CLOSING month with an invoice", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await openThrough(TRIAL_ENDS);
    fake.finalizeInvoice = async () => {
      throw new Error("Stripe is down");
    };
    await closeMonth(month(1).id, CLOSE_M1);
    Object.assign(h.state.orgs.get(ORG)!, { billingPlan: "free", billingStatus: "exempt" });
    expect(await sweepUnwantedMonthInvoices(CLOSE_M1)).toEqual({ voided: 1, failed: 0 });
    expect(month(1).status).toBe("void");
  });

  it("M2: the club turns Free in the seconds between the re-check and the payment: the invoice is voided, NOTHING is taken, recorded", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await openThrough(TRIAL_ENDS);
    const real = fake.finalizeInvoice.bind(fake);
    fake.finalizeInvoice = async (id: string) => {
      const r = await real(id);
      Object.assign(h.state.orgs.get(ORG)!, { billingPlan: "free", billingStatus: "exempt" });
      return r;
    };
    expect(await closeMonth(month(1).id, CLOSE_M1)).toMatchObject({ outcome: "void", reason: "free-plan" });
    expect(month(1).status).toBe("void");
    expect(fake.state().calls.filter((c) => c.method === "payInvoice")).toHaveLength(0);
    expect(Object.values(fake.state().invoices)[0]).toMatchObject({ status: "void" });
    expect(h.state.ops).toContainEqual(expect.objectContaining({ title: expect.stringMatching(/stopped being billed/i) }));
  });

  it("sweepUnwantedMonthInvoices: an exempt (Free) club's unpaid invoice is voided by the hourly run, whatever the flag says", async () => {
    club();
    fake.setPayOutcome("pm_colin", "decline");
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await openThrough(TRIAL_ENDS);
    await closeMonth(month(1).id, CLOSE_M1);
    Object.assign(h.state.orgs.get(ORG)!, { billingPlan: "free", billingStatus: "exempt" });
    delete process.env.BILLING_ENABLED;
    expect(await sweepUnwantedMonthInvoices(CLOSE_M1)).toEqual({ voided: 1, failed: 0 });
    expect(month(1).status).toBe("void");
    // A billed club's unpaid invoice is left alone.
    club({}, {}, "org_other");
    process.env.BILLING_ENABLED = "1";
    h.state.matches.set("org_other", h.state.matches.get(ORG)!);
    await openDueMonths("org_other", TRIAL_ENDS);
    await closeMonth(month(1, "org_other").id, CLOSE_M1);
    expect(await sweepUnwantedMonthInvoices(CLOSE_M1)).toEqual({ voided: 0, failed: 0 });
  });
});

// ── The webhook's writes ─────────────────────────────────────────────────

describe("applyMonthInvoice: the webhook's mapping onto the month (idempotent, out of order)", () => {
  async function invoicedMonth() {
    club();
    fake.setPayOutcome("pm_colin", "decline");
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await openThrough(TRIAL_ENDS);
    await closeMonth(month(1).id, CLOSE_M1);
    return (await fake.retrieveInvoice(month(1).stripeInvoiceId!))!;
  }

  it("failed, then paid: failed, then paid (with the time); a re-delivery changes nothing", async () => {
    const inv = await invoicedMonth();
    const id = month(1).id;
    expect(await applyMonthInvoice({ orgId: ORG, monthId: id, invoice: inv, kind: "failed", now: CLOSE_M1 })).toBe("changed");
    expect(month(1).status).toBe("failed");
    expect(await unpaidMonthIds(ORG)).toEqual([id]);
    const paidAt = new Date(CLOSE_M1.getTime() + HOUR);
    expect(await applyMonthInvoice({ orgId: ORG, monthId: id, invoice: { ...inv, status: "paid" }, kind: "paid", now: paidAt })).toBe("changed");
    expect(month(1)).toMatchObject({ status: "paid", paidAt });
    expect(await applyMonthInvoice({ orgId: ORG, monthId: id, invoice: { ...inv, status: "paid" }, kind: "paid", now: paidAt })).toBe("unchanged");
    expect(await unpaidMonthIds(ORG)).toEqual([]);
  });

  it("a stale 'failed' arriving AFTER 'paid' never undoes the payment", async () => {
    const inv = await invoicedMonth();
    const id = month(1).id;
    await applyMonthInvoice({ orgId: ORG, monthId: id, invoice: { ...inv, status: "paid" }, kind: "paid", now: CLOSE_M1 });
    expect(await applyMonthInvoice({ orgId: ORG, monthId: id, invoice: inv, kind: "failed", now: CLOSE_M1 })).toBe("unchanged");
    expect(month(1).status).toBe("paid");
  });

  it("paid while our close is still 'closing' (the webhook was faster): paid, and the close's last write leaves it", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await openThrough(TRIAL_ENDS);
    const m = month(1);
    h.state.months.get(m.id)!.status = "closing";
    expect(
      await applyMonthInvoice({ orgId: ORG, monthId: m.id, invoice: { id: "in_x", status: "paid", hostedInvoiceUrl: null }, kind: "paid", now: CLOSE_M1 }),
    ).toBe("changed");
    expect(month(1)).toMatchObject({ status: "paid", stripeInvoiceId: "in_x" });
  });

  it("M3: paid AFTER the month was made void (Stripe collected an uncollectible invoice): recorded paid, never lost, flagged for the owner", async () => {
    const inv = await invoicedMonth();
    const id = month(1).id;
    await applyMonthInvoice({ orgId: ORG, monthId: id, invoice: { ...inv, status: "uncollectible" }, kind: "void", now: CLOSE_M1 });
    expect(month(1).status).toBe("void");
    expect(await applyMonthInvoice({ orgId: ORG, monthId: id, invoice: { ...inv, status: "paid" }, kind: "paid", now: CLOSE_M2 })).toBe("changed");
    expect(month(1)).toMatchObject({ status: "paid", paidAt: CLOSE_M2 });
    expect(h.state.ops).toContainEqual(expect.objectContaining({ title: expect.stringMatching(/paid after/i) }));
  });

  it("an invoice that is NOT the month's own (a second invoice for one month): never applied, flagged critical", async () => {
    const inv = await invoicedMonth();
    expect(
      await applyMonthInvoice({ orgId: ORG, monthId: month(1).id, invoice: { ...inv, id: "in_other", status: "paid" }, kind: "paid", now: CLOSE_M1 }),
    ).toBe("mismatch");
    expect(month(1).stripeInvoiceId).toBe(inv.id);
    expect(h.state.ops).toContainEqual(expect.objectContaining({ severity: "critical" }));
  });

  it("another club's month id: not found", async () => {
    const inv = await invoicedMonth();
    expect(await applyMonthInvoice({ orgId: "org_x", monthId: month(1).id, invoice: inv, kind: "paid", now: CLOSE_M1 })).toBe("not-found");
  });

  it("voided (or marked uncollectible) in Stripe: the month is void; a paid month never is", async () => {
    const inv = await invoicedMonth();
    expect(await applyMonthInvoice({ orgId: ORG, monthId: month(1).id, invoice: { ...inv, status: "void" }, kind: "void", now: CLOSE_M1 })).toBe("changed");
    expect(month(1).status).toBe("void");
  });

  it("L1: payUnpaidMonths never pays for a club on Free, exempt or suspended", async () => {
    const inv = await invoicedMonth();
    await applyMonthInvoice({ orgId: ORG, monthId: month(1).id, invoice: inv, kind: "failed", now: CLOSE_M1 });
    Object.assign(h.state.orgs.get(ORG)!, { billingPlan: "free", billingStatus: "exempt" });
    expect(await payUnpaidMonths(ORG, "pm_pat")).toBe(0);
    Object.assign(h.state.orgs.get(ORG)!, { billingPlan: "standard", billingStatus: "subscribed", approvalStatus: "suspended" });
    expect(await payUnpaidMonths(ORG, "pm_pat")).toBe(0);
    expect(fake.state().calls.filter((c) => c.method === "payInvoice" && (c.args as { paymentMethodId: string }).paymentMethodId === "pm_pat")).toHaveLength(0);
  });

  it("payUnpaidMonths: a new card pays every unpaid month's open invoice at once; nothing with the flag off", async () => {
    const inv = await invoicedMonth();
    await applyMonthInvoice({ orgId: ORG, monthId: month(1).id, invoice: inv, kind: "failed", now: CLOSE_M1 });
    delete process.env.BILLING_ENABLED;
    expect(await payUnpaidMonths(ORG, "pm_pat")).toBe(0);
    expect(invoices()[0].status).toBe("open");
    process.env.BILLING_ENABLED = "1";
    expect(await payUnpaidMonths(ORG, "pm_pat")).toBe(1);
    expect(invoices()[0].status).toBe("paid");
    expect(invoices()[0].payAttempts.at(-1)).toEqual({ paymentMethodId: "pm_pat", outcome: "succeed" });
  });
});

// ── H1: not-billable spells and billing off ───────────────────────────────

describe("H1 (P2 review): months while not billable, or while billing was off, are never opened or charged", () => {
  const FEB_TUESDAYS = ["2027-02-02", "2027-02-09", "2027-02-16", "2027-02-23"];
  const JAN_TUESDAYS = ["2027-01-05", "2027-01-12", "2027-01-19", "2027-01-26"];
  const CLOSE_M3 = new Date("2027-02-01T10:00:00Z");
  const CLOSE_M4 = new Date("2027-03-01T10:00:00Z");
  const allPlayed = () => {
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    weeks(DEC_TUESDAYS, ["played", "played", "played", "played", "played"]);
    weeks(JAN_TUESDAYS, ["played", "played", "played", "played"]);
    weeks(FEB_TUESDAYS, ["played", "played", "played", "played"]);
  };
  const spell = (type: string, at: Date) => h.state.events.push({ id: `${type}_${at.getTime()}`, type, orgId: ORG, receivedAt: at });

  it("Free for three months, then Standard: months 2 and 3 never exist; month 4 charges only the games after billing came back", async () => {
    club();
    allPlayed();
    await openDueMonths(ORG, TRIAL_ENDS);
    // Free on 10 Nov (setBillingState writes mt.unbilled; onPlanChanged waives).
    const freeAt = new Date("2026-11-10T12:00:00Z");
    Object.assign(h.state.orgs.get(ORG)!, { billingPlan: "free", billingStatus: "exempt" });
    spell("mt.unbilled", freeAt);
    await waiveOpenMonths(ORG, "free-plan", freeAt);
    // Every hourly run while Free opens nothing.
    for (const at of ["2026-12-01T01:00:00Z", "2027-01-01T01:00:00Z", "2027-02-01T01:00:00Z"]) {
      expect((await openDueMonths(ORG, new Date(at))).opened).toEqual([]);
      expect(await closeNextDueMonth(ORG, new Date(at.replace("01:00", "11:00")))).toEqual({ skipped: "none" });
    }
    // Standard again on Sun 14 Feb (billed again: mt.billed).
    const backAt = new Date("2027-02-14T12:00:00Z");
    Object.assign(h.state.orgs.get(ORG)!, { billingPlan: "standard", billingStatus: "subscribed" });
    spell("mt.billed", backAt);
    expect((await openDueMonths(ORG, backAt)).opened).toEqual([4]);
    expect(monthsOf().map((m) => [m.index, m.status])).toEqual([
      [1, "waived"],
      [4, "open"],
    ]);
    // 2 and 9 Feb were inside the Free spell: scheduled, not played.
    expect(await closeNextDueMonth(ORG, CLOSE_M4)).toMatchObject({ outcome: "paid", index: 4, amountPence: 499 });
    expect(month(4)).toMatchObject({ scheduled: 4, played: 2 });
    expect(invoices()).toHaveLength(1);
  });

  it("a suspension: nothing opens while suspended; billable again (self-healed marker), only the current month, games before it not charged", async () => {
    club();
    allPlayed();
    await openDueMonths(ORG, TRIAL_ENDS);
    const suspendedAt = new Date("2026-11-20T12:00:00Z");
    h.state.orgs.get(ORG)!.approvalStatus = "suspended";
    await recordSuspended(ORG, suspendedAt);
    await waiveOpenMonths(ORG, "suspended", suspendedAt);
    expect((await openDueMonths(ORG, new Date("2026-12-15T12:00:00Z"))).opened).toEqual([]);
    // Back (by hand) on 20 Jan: the open spell is closed at that moment.
    const backAt = new Date("2027-01-20T12:00:00Z");
    h.state.orgs.get(ORG)!.approvalStatus = "approved";
    expect((await openDueMonths(ORG, backAt)).opened).toEqual([3]);
    expect(h.state.events.map((e) => e.type)).toEqual(["mt.suspended", "mt.unsuspended"]);
    // Only 26 Jan is after billing came back (5, 12 and 19 Jan were inside the spell).
    expect(await closeNextDueMonth(ORG, CLOSE_M3)).toMatchObject({ outcome: "paid", index: 3, amountPence: 249 });
    expect(month(3)).toMatchObject({ scheduled: 4, played: 1 });
  });

  it("P3 (P2 review LOW 2): suspended, then set Free and back to Standard WHILE still suspended: the suspension's spell stays open until it is lifted", async () => {
    club();
    allPlayed();
    await openDueMonths(ORG, TRIAL_ENDS);
    const suspendedAt = new Date("2026-11-20T12:00:00Z");
    h.state.orgs.get(ORG)!.approvalStatus = "suspended";
    await recordSuspended(ORG, suspendedAt);
    await waiveOpenMonths(ORG, "suspended", suspendedAt);
    // Free on 25 Nov and Standard again on 1 Dec (setBillingState's own
    // pair), all while still suspended.
    Object.assign(h.state.orgs.get(ORG)!, { billingPlan: "free", billingStatus: "exempt" });
    spell("mt.unbilled", new Date("2026-11-25T12:00:00Z"));
    Object.assign(h.state.orgs.get(ORG)!, { billingPlan: "standard", billingStatus: "subscribed" });
    spell("mt.billed", new Date("2026-12-01T12:00:00Z"));
    expect((await openDueMonths(ORG, new Date("2026-12-15T12:00:00Z"))).opened).toEqual([]);
    // Lifted on 20 Jan: only then does the suspension's spell end.
    const backAt = new Date("2027-01-20T12:00:00Z");
    h.state.orgs.get(ORG)!.approvalStatus = "approved";
    expect((await openDueMonths(ORG, backAt)).opened).toEqual([3]);
    expect(h.state.events.map((e) => e.type)).toEqual(["mt.suspended", "mt.unbilled", "mt.billed", "mt.unsuspended"]);
    // 5, 12 and 19 Jan were still inside the suspension: not played.
    expect(await closeNextDueMonth(ORG, CLOSE_M3)).toMatchObject({ outcome: "paid", index: 3, amountPence: 249 });
    expect(month(3)).toMatchObject({ scheduled: 4, played: 1 });
  });

  it("BILLING_ENABLED off for two months: no catch-up; the month open when it went off charges only the games before", async () => {
    club();
    allPlayed();
    await openDueMonths(ORG, TRIAL_ENDS);
    // The hourly run sees the flag off on 20 Nov (a GLOBAL marker).
    delete process.env.BILLING_ENABLED;
    await recordBillingFlagState(false, new Date("2026-11-20T12:00:00Z"));
    await recordBillingFlagState(false, new Date("2026-11-20T13:00:00Z")); // once, not every hour
    expect(await openDueMonths(ORG, new Date("2026-12-15T12:00:00Z"))).toEqual({ opened: [], skipped: "off" });
    // Back on 3 Feb.
    process.env.BILLING_ENABLED = "1";
    const onAt = new Date("2027-02-03T09:00:00Z");
    await recordBillingFlagState(true, onAt);
    expect(h.state.events.map((e) => [e.type, e.orgId])).toEqual([
      ["mt.billing-off", null],
      ["mt.billing-on", null],
    ]);
    expect((await openDueMonths(ORG, onAt)).opened).toEqual([4]);
    expect(monthsOf().map((m) => m.index)).toEqual([1, 4]);
    // Month 1 closes now: 3, 10 and 17 Nov played before billing went off; 24 Nov was inside it.
    expect(await closeNextDueMonth(ORG, new Date("2027-02-03T11:00:00Z"))).toMatchObject({ outcome: "paid", index: 1, amountPence: 749 });
    // Month 4: 2 Feb was inside the off spell.
    expect(await closeNextDueMonth(ORG, CLOSE_M4)).toMatchObject({ outcome: "paid", index: 4, amountPence: 749 });
    expect(month(4)).toMatchObject({ scheduled: 4, played: 3 });
  });
});

