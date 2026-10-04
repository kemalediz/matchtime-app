/**
 * CLUB FEE BILLING, slice P3: the hourly cron opens and closes billing
 * months, retries failed ones, and sends the month DMs.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 2A, 5.3, 6, 7.3.
 *
 * REAL: the scheduler (`runBillingCron`), the month writer
 * (club-billing-months.ts), the month DMs (club-billing-dms.ts), the
 * spells, the cycle rules and `countClubMonth`. The database is a small
 * in-memory world; `setBillingState` applies the REAL pure
 * `nextBillingState`; `queueBillingDm` keeps the REAL claim rule (one row
 * per club, kind and cycle). Stripe is the fake adapter. No network, no
 * model, no production data; DMs are recorded, never sent.
 *
 * Fixture club: the free month ended Sun 1 Nov 2026 14:00 London, so
 * month 1 is 1 Nov to 30 Nov (Tuesdays 3, 10, 17, 24) and is closed at
 * 10:00 London on Tue 1 Dec. A player, Cole, is the money collector; Owen
 * owns the club. The club plays Tuesdays at 19:00.
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
  pausedAt: Date | null;
  pausedReason: string | null;
  paymentFailedAt: Date | null;
};
type Member = { userId: string; role: string; leftAt: Date | null; name: string | null; phoneNumber: string | null };
type Org = {
  id: string;
  name: string;
  language: string;
  approvalStatus: string;
  approvedAt: Date | null;
  billingStatus: string;
  billingPlan: string;
  billingPricePence: number | null;
  featureAttendance: boolean;
  paymentHolderId: string | null;
  members: Member[];
};
type Notice = { orgId: string; kind: string; cycleKey: string; platformJobId: string | null; createdAt: Date };

const h = vi.hoisted(() => {
  const state = {
    orgs: new Map<string, Org>(),
    billings: new Map<string, Billing>(),
    months: new Map<string, Month>(),
    matches: new Map<string, CycleMatch[]>(),
    events: [] as Array<{ id: string; type: string; orgId: string | null; receivedAt: Date }>,
    notices: new Map<string, Notice>(),
    dms: [] as Array<{ orgId: string; kind: string; cycleKey: string; userId: string; text: string }>,
    ops: [] as Array<{ title: string; dedupeKey?: string | null }>,
    synced: [] as Array<{ monthId: string; invoiceId: string }>,
    seq: 0,
    jobSeq: 0,
  };
  const key = (orgId: string, kind: string, cycleKey: string) => `${orgId}|${kind}|${cycleKey}`;

  /** A tiny Prisma `where` matcher: equality, Dates, in, not, lt, lte, gt, gte, OR. */
  const match = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === "OR") return (v as Array<Record<string, unknown>>).some((w) => match(row, w));
      const cur = row[k];
      if (v instanceof Date) return cur instanceof Date && cur.getTime() === v.getTime();
      if (v && typeof v === "object") {
        const o = v as { in?: unknown[]; not?: unknown; lt?: Date | number; lte?: Date | number; gt?: Date | number; gte?: Date | number };
        const n = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
        if (o.in) return o.in.includes(cur);
        if ("not" in o) return cur !== o.not;
        if (cur === null || cur === undefined) return false;
        if (o.lt !== undefined) return n(cur) < n(o.lt);
        if (o.lte !== undefined) return n(cur) <= n(o.lte);
        if (o.gt !== undefined) return n(cur) > n(o.gt);
        if (o.gte !== undefined) return n(cur) >= n(o.gte);
        return false;
      }
      return cur === v;
    });

  const orgView = (o: Org) => {
    const b = state.billings.get(o.id);
    return {
      ...o,
      memberships: o.members.map((m) => ({ userId: m.userId, role: m.role, leftAt: m.leftAt, user: { name: m.name, phoneNumber: m.phoneNumber } })),
      clubBilling: b ? { ...b } : null,
    };
  };
  const sortIdx = <T extends { index: number }>(rows: T[], dir?: "asc" | "desc") => rows.sort((a, b) => (dir === "desc" ? b.index - a.index : a.index - b.index));

  const db = {
    organisation: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const o = state.orgs.get(where.id);
        return o ? orgView(o) : null;
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        for (const o of state.orgs.values()) {
          const m = o.members.find((x) => x.userId === where.id);
          if (m) return { id: m.userId, name: m.name, phoneNumber: m.phoneNumber };
        }
        return null;
      }),
    },
    clubBilling: {
      findMany: vi.fn(async () =>
        [...state.billings.values()]
          .filter((b) => state.orgs.get(b.orgId)?.approvalStatus === "approved")
          .map((b) => {
            const o = state.orgs.get(b.orgId)!;
            return { orgId: b.orgId, org: { approvalStatus: o.approvalStatus, approvedAt: o.approvedAt, billingStatus: o.billingStatus } };
          }),
      ),
      findUnique: vi.fn(async ({ where }: { where: { orgId: string } }) => {
        const b = state.billings.get(where.orgId);
        return b ? { ...b } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Billing> }) => {
        const b = state.billings.get(where.orgId as string);
        if (!b || !match(b as unknown as Record<string, unknown>, where)) return { count: 0 };
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
        const rows = sortIdx([...state.months.values()].filter((m) => match(m as unknown as Record<string, unknown>, where)), orderBy?.index);
        return rows[0] ? { ...rows[0] } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        sortIdx([...state.months.values()].filter((m) => match(m as unknown as Record<string, unknown>, where))).map((m) => ({ ...m })),
      ),
      createMany: vi.fn(async ({ data }: { data: Array<Partial<Month>> }) => {
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
        let count = 0;
        for (const m of state.months.values()) {
          if (!match(m as unknown as Record<string, unknown>, where)) continue;
          Object.assign(m, data, data.updatedAt ? {} : { updatedAt: new Date() });
          count++;
        }
        return { count };
      }),
    },
    billingEvent: {
      findFirst: vi.fn(async ({ where }: { where: { orgId: string | null; type: { in: string[] } } }) => {
        const rows = state.events
          .filter((e) => e.orgId === where.orgId && where.type.in.includes(e.type))
          .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
        return rows[0] ?? null;
      }),
      findMany: vi.fn(async ({ where }: { where: { orgId: string; type: string } }) =>
        state.events.filter((e) => e.orgId === where.orgId && e.type === where.type).map((e) => ({ id: e.id })),
      ),
      create: vi.fn(async ({ data }: { data: { id: string; type: string; orgId: string | null; receivedAt: Date } }) => {
        if (state.events.some((e) => e.id === data.id)) throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        state.events.push({ id: data.id, type: data.type, orgId: data.orgId, receivedAt: data.receivedAt });
        return data;
      }),
    },
    billingNotice: {
      findFirst: vi.fn(async ({ where }: { where: { orgId: string; kind: string; cycleKey: string } }) =>
        state.notices.get(key(where.orgId, where.kind, where.cycleKey)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { orgId: string; platformJobId?: null; kind?: { in: string[] } } }) =>
        [...state.notices.values()].filter(
          (n) => n.orgId === where.orgId && (where.platformJobId !== null || n.platformJobId === null) && (!where.kind?.in || where.kind.in.includes(n.kind)),
        ),
      ),
      createMany: vi.fn(async ({ data }: { data: Array<{ orgId: string; kind: string; cycleKey: string; platformJobId?: string | null; createdAt?: Date }> }) => {
        let count = 0;
        for (const d of data) {
          const k = key(d.orgId, d.kind, d.cycleKey);
          if (state.notices.has(k)) continue;
          state.notices.set(k, { orgId: d.orgId, kind: d.kind, cycleKey: d.cycleKey, platformJobId: d.platformJobId ?? null, createdAt: d.createdAt ?? new Date() });
          count++;
        }
        return { count };
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  return { state, db, key };
});

vi.mock("../db", () => ({ db: h.db }));
vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("../admin-link", () => ({
  buildAdminLink: vi.fn(async (a: { userId: string; nextPath: string }) => `https://mt.test/r/${a.userId}${a.nextPath}`),
}));
vi.mock("../ops-alerts", () => ({
  BILLING_ALERT_KIND: "club-billing",
  recordOpsEvent: vi.fn(async (a: { title: string; dedupeKey?: string | null }) => {
    h.state.ops.push(a);
    return true;
  }),
}));
vi.mock("../admin-channel", () => ({
  loadAdminChannel: vi.fn(async () => null),
  sendAdminNotice: vi.fn(async () => ({ channel: "dm", queued: 0 })),
}));
vi.mock("../club-billing-month-loader", async () => {
  const rules = await vi.importActual<typeof import("../club-billing-cycle-rules")>("../club-billing-cycle-rules");
  return {
    loadClubMonthInput: vi.fn(async (_client: unknown, orgId: string, month: { startsAt: Date; endsAt: Date }): Promise<CountClubMonthInput | null> => {
      const org = h.state.orgs.get(orgId);
      if (!org) return null;
      const spans = rules.notChargedSpansFrom(
        h.state.events.filter((e) => (e.orgId === orgId || e.orgId === null) && e.receivedAt < month.endsAt).map((e) => ({ type: e.type, at: e.receivedAt })),
      );
      return {
        startsAt: month.startsAt,
        endsAt: month.endsAt,
        activities: [{ id: "act_tue", dayOfWeek: 2, time: "19:00", venue: "Pitch", isActive: true, createdAt: new Date("2026-01-01T00:00:00Z") }],
        matches: (h.state.matches.get(orgId) ?? []).filter((m) => m.date >= month.startsAt && m.date < month.endsAt),
        pauseSpans: spans,
        tracksAttendance: org.featureAttendance,
      };
    }),
  };
});
vi.mock("../club-billing", async () => {
  const rules = await vi.importActual<typeof import("../club-billing-rules")>("../club-billing-rules");
  return {
    CLAIM_STALE_MS: 10 * 60 * 1000,
    loadClubFeeTip: vi.fn(async () => null),
    setBillingState: vi.fn(async (orgId: string, event: { type: string }, now: Date) => {
      const o = h.state.orgs.get(orgId)!;
      const b = h.state.billings.get(orgId) ?? null;
      const t = rules.nextBillingState(
        { approvedAt: o.approvedAt, billingStatus: o.billingStatus, billingPlan: o.billingPlan, billing: b },
        event as never,
        now,
      );
      if (!t) return { ok: false, reason: "no-change" };
      const from = o.billingStatus;
      o.billingStatus = t.to;
      if (b) {
        if (t.to === "paused") Object.assign(b, { pausedAt: now, pausedReason: t.pausedReason });
        else if (from === "paused") Object.assign(b, { pausedAt: null, pausedReason: null });
        if (t.to === "subscribed") Object.assign(b, { graceEndsAt: null, paymentFailedAt: null });
        if (t.graceEndsAt) b.graceEndsAt = t.graceEndsAt;
        if (t.paymentFailedAt) b.paymentFailedAt = t.paymentFailedAt;
      }
      return { ok: true, from, to: t.to, resumed: t.resumes };
    }),
    queueBillingDm: vi.fn(async (a: { orgId: string; kind: string; cycleKey: string; userId: string; text: (u: { name: string | null }) => string }) => {
      const k = h.key(a.orgId, a.kind, a.cycleKey);
      const row = h.state.notices.get(k);
      if (row && row.platformJobId !== null) return "already";
      const user = h.state.orgs.get(a.orgId)!.members.find((m) => m.userId === a.userId);
      if (!user?.phoneNumber) {
        h.state.notices.set(k, { orgId: a.orgId, kind: a.kind, cycleKey: a.cycleKey, platformJobId: "skipped:no-phone", createdAt: new Date() });
        return "no-phone";
      }
      h.state.notices.set(k, { orgId: a.orgId, kind: a.kind, cycleKey: a.cycleKey, platformJobId: `job_${++h.state.jobSeq}`, createdAt: new Date() });
      h.state.dms.push({ orgId: a.orgId, kind: a.kind, cycleKey: a.cycleKey, userId: a.userId, text: a.text({ name: user.name }) });
      return "queued";
    }),
  };
});
vi.mock("../club-billing-stripe", async () => {
  const months = await import("../club-billing-months");
  return {
    flushPendingBillingNotices: vi.fn(async () => 0),
    // As the webhook would: the month paid, the club back to subscribed.
    syncPaidMonthInvoice: vi.fn(async (a: { orgId: string; monthId: string; invoiceId: string; now: Date }) => {
      h.state.synced.push({ monthId: a.monthId, invoiceId: a.invoiceId });
      await months.applyMonthInvoice({ orgId: a.orgId, monthId: a.monthId, invoice: { id: a.invoiceId, status: "paid" } as never, kind: "paid", now: a.now });
      const o = h.state.orgs.get(a.orgId)!;
      if (o.billingStatus === "past_due") o.billingStatus = "subscribed";
      return { action: "month-paid", orgId: a.orgId };
    }),
  };
});

import { setBillingStripeForTests } from "../stripe-billing";
import { createFakeBillingStripe, type FakeBillingStripe, type FakeInvoice } from "../stripe-billing-fake";
import { applyMonthInvoice } from "../club-billing-months";
import { sendMonthCharged } from "../club-billing-dms";
import { runBillingCron } from "../club-billing-scheduler";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const ORG = "org_cron";
const TRIAL_ENDS = new Date("2026-11-01T14:00:00Z");
const M1_END = new Date("2026-12-01T00:00:00Z");
/** 10:00 London on Tue 1 Dec (GMT): the first daytime run 6+ hours after month 1 ends. */
const CLOSE_M1 = new Date("2026-12-01T10:00:00Z");
const NOV_TUESDAYS = ["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24"];
const DEC_TUESDAYS = ["2026-12-01", "2026-12-08", "2026-12-15", "2026-12-22", "2026-12-29"];

const OWEN: Member = { userId: "u_owen", role: "OWNER", leftAt: null, name: "Owen", phoneNumber: "+447700900001" };
const COLE: Member = { userId: "u_cole", role: "PLAYER", leftAt: null, name: "Cole", phoneNumber: "+447700900003" };

let fake: FakeBillingStripe;
const ENV_KEYS = ["BILLING_ENABLED", "STRIPE_CLUB_PRODUCT_ID", "STRIPE_CLUB_TAX_RATE_ID", "BILLING_CRON_RETRIES", "NEXTAUTH_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

function club(over: Partial<Org> = {}, billing: Partial<Billing> = {}, orgId = ORG) {
  h.state.orgs.set(orgId, {
    id: orgId,
    name: "Cron Rovers",
    language: "en",
    approvalStatus: "approved",
    approvedAt: new Date("2026-10-02T14:00:00Z"),
    billingStatus: "subscribed",
    billingPlan: "standard",
    billingPricePence: null,
    featureAttendance: true,
    paymentHolderId: "u_cole",
    members: [OWEN, COLE].map((m) => ({ ...m })),
    ...over,
  });
  h.state.billings.set(orgId, {
    orgId,
    trialEndsAt: TRIAL_ENDS,
    graceEndsAt: null,
    stripeCustomerId: "cus_rovers",
    stripePaymentMethodId: "pm_cole",
    cardHolderUserId: "u_cole",
    cardLast4: "4242",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    pausedAt: null,
    pausedReason: null,
    paymentFailedAt: null,
    ...billing,
  });
}

type Week = "played" | "cancelled" | "nobody";
function weeks(days: string[], plan: Week[], orgId = ORG) {
  const list = h.state.matches.get(orgId) ?? [];
  days.forEach((d, i) => {
    const w = plan[i];
    if (!w) return;
    list.push({
      id: `m_${orgId}_${d}`,
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

const monthsOf = (orgId = ORG) => [...h.state.months.values()].filter((m) => m.orgId === orgId).sort((a, b) => a.index - b.index);
const month = (index: number, orgId = ORG) => monthsOf(orgId).find((m) => m.index === index)!;
const invoices = () => Object.values(fake.state().invoices).filter((i): i is FakeInvoice => "items" in i && i.status !== "deleted");
const payCalls = () => fake.state().calls.filter((c) => c.method === "payInvoice");
const dmsOf = (kind?: string) => h.state.dms.filter((d) => !kind || d.kind === kind);
const at = (iso: string) => new Date(iso);

/** Run the cron every hour from `from` up to and including `to`. */
async function hourly(from: Date, to: Date) {
  for (let t = from.getTime(); t <= to.getTime(); t += HOUR) await runBillingCron(new Date(t));
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.BILLING_ENABLED = "1";
  process.env.STRIPE_CLUB_PRODUCT_ID = "prod_club";
  process.env.STRIPE_CLUB_TAX_RATE_ID = "txr_vat_inclusive";
  process.env.NEXTAUTH_URL = "https://mt.test";
  // These tests prove the cron's OWN retries, which are off by default
  // (Stripe's retries are the one mechanism by default, 2026-10-05).
  process.env.BILLING_CRON_RETRIES = "1";
  for (const m of [h.state.orgs, h.state.billings, h.state.months, h.state.matches, h.state.notices]) m.clear();
  Object.assign(h.state, { events: [], dms: [], ops: [], synced: [] });
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

// ── Opening and closing on time ─────────────────────────────────────────

describe("the cron opens and closes months (plan 6)", () => {
  it("a full month: opened when the free month ends, closed and charged at 10:00 the morning after it ends, one receipt", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "played", "cancelled"]);
    // The hour before the free month ends: nothing.
    expect((await runBillingCron(new Date(TRIAL_ENDS.getTime() - HOUR))).clubs[0].opened).toBeUndefined();
    const r = await runBillingCron(TRIAL_ENDS);
    expect(r.clubs[0].opened).toEqual([1]);
    expect(month(1)).toMatchObject({ status: "open", startsAt: TRIAL_ENDS, endsAt: M1_END });
    // Every hour of November and the night after: nothing closes, nothing is charged.
    await runBillingCron(at("2026-11-30T23:00:00Z"));
    await hourly(M1_END, new Date(CLOSE_M1.getTime() - HOUR));
    expect(month(1).status).toBe("open");
    expect(invoices()).toEqual([]);
    // Month 2 opened at midnight, at night.
    expect(month(2)).toMatchObject({ status: "open", startsAt: M1_END });

    const close = await runBillingCron(CLOSE_M1);
    expect(close.clubs[0].closed).toBe("1:paid");
    expect(month(1)).toMatchObject({ status: "paid", scheduled: 4, played: 3, amountPence: 749 });
    expect(invoices()).toHaveLength(1);
    expect(dmsOf("month-charged")).toEqual([
      expect.objectContaining({
        userId: "u_cole",
        cycleKey: month(1).id,
        text:
          "Hi Cole, Cron Rovers played 3 of 4 games between 1 Nov and 30 Nov, so £7.49 was charged to your card ending 4242 " +
          `(VAT included; a full month is £9.99). Stripe has emailed you the receipt. Details: https://mt.test/r/u_cole/billing/${ORG}`,
      }),
    ]);
    // The rest of the day: nothing more.
    await hourly(new Date(CLOSE_M1.getTime() + HOUR), at("2026-12-01T19:00:00Z"));
    expect(invoices()).toHaveLength(1);
    expect(dmsOf()).toHaveLength(1);
    expect(dmsOf()[0].userId).not.toBe("u_owen");
  });

  it("two cron runs at the same moment: ONE close, ONE invoice, ONE receipt", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await runBillingCron(TRIAL_ENDS);
    await Promise.all([runBillingCron(CLOSE_M1), runBillingCron(CLOSE_M1)]);
    expect(month(1)).toMatchObject({ status: "paid", amountPence: 999 });
    expect(invoices()).toHaveLength(1);
    expect(payCalls()).toHaveLength(1);
    expect(dmsOf("month-charged")).toHaveLength(1);
  });

  it("a late cron (down from 30 Nov to 3 Dec 15:00): month 1 closes on the first run, once; month 2 opens; no catch-up of anything else", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await runBillingCron(TRIAL_ENDS);
    const r = await runBillingCron(at("2026-12-03T15:00:00Z"));
    expect(r.clubs[0]).toMatchObject({ opened: [2], closed: "1:paid" });
    expect(dmsOf("month-charged")).toHaveLength(1);
    await runBillingCron(at("2026-12-03T16:00:00Z"));
    expect(invoices()).toHaveLength(1);
    expect(monthsOf().map((m) => [m.index, m.status])).toEqual([
      [1, "paid"],
      [2, "open"],
    ]);
  });

  it("DST: a month ending at 00:00 BST on Mon 29 Mar 2027 closes at 10:00 BST (09:00 UTC), not at 09:00 BST", async () => {
    // Free month ends Fri 29 Jan 2027 12:00: month 2 runs 28 Feb (clamped) to 29 Mar 00:00 BST = 28 Mar 23:00 UTC.
    club({}, { trialEndsAt: at("2027-01-29T12:00:00Z") });
    await runBillingCron(at("2027-03-10T12:00:00Z"));
    expect(month(2)).toMatchObject({ endsAt: at("2027-03-28T23:00:00Z"), status: "open" });
    // 09:00 BST: not daytime, the close step does not even run.
    expect((await runBillingCron(at("2027-03-29T08:00:00Z"))).clubs[0].closed).toBeUndefined();
    expect(month(2).status).toBe("open");
    expect((await runBillingCron(at("2027-03-29T09:00:00Z"))).clubs[0].closed).toBe("2:no-games"); // 10:00 BST
    // No games in it at all: nothing charged, the "nothing to pay" DM with the month's own dates.
    expect(invoices()).toEqual([]);
    expect(dmsOf("month-free")[0].text).toBe(
      "Hi Cole, Cron Rovers played no games between 28 Feb and 28 Mar, so there is nothing to pay for that month. MatchTime only charges for the games you play.",
    );
  });

  it("BILLING_ENABLED off: no month opens or closes and nothing is charged, even when one is due", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await runBillingCron(TRIAL_ENDS);
    delete process.env.BILLING_ENABLED;
    const r = await runBillingCron(CLOSE_M1);
    expect(r).toMatchObject({ enabled: false, clubs: [] });
    expect(month(1).status).toBe("open");
    expect(monthsOf()).toHaveLength(1);
    expect(invoices()).toEqual([]);
    expect(dmsOf()).toEqual([]);
  });

  it("never a club that is exempt or suspended (Sutton's shape and the owner's off switch)", async () => {
    club({ billingStatus: "exempt", billingPlan: "free" });
    club({ approvalStatus: "suspended" }, {}, "org_susp");
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await runBillingCron(TRIAL_ENDS);
    await runBillingCron(CLOSE_M1);
    expect([...h.state.months.values()]).toEqual([]);
    expect(invoices()).toEqual([]);
    expect(dmsOf()).toEqual([]);
  });

  it("Stop paying: the last month is charged at its close, then the club pauses; receipt and the 'paused' DM go once each, same run", async () => {
    club({}, { cancelAtPeriodEnd: true, currentPeriodEnd: M1_END });
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await runBillingCron(TRIAL_ENDS);
    await hourly(M1_END, at("2026-12-01T12:00:00Z"));
    expect(h.state.orgs.get(ORG)!.billingStatus).toBe("paused");
    expect(h.state.billings.get(ORG)!.pausedReason).toBe("cancelled");
    // No month 2: billing stopped with month 1.
    expect(monthsOf().map((m) => m.index)).toEqual([1]);
    expect(dmsOf().map((d) => d.kind).sort()).toEqual(["month-charged", "paused"]);
    expect(dmsOf("paused")[0].text).toContain("you stopped paying for MatchTime for Cron Rovers, so it is now paused.");
  });
});

// ── The month DMs ───────────────────────────────────────────────────────

describe("the month DMs: once each, daytime only, to the billing contact", () => {
  it("'nothing to pay' only for the FIRST month in a row with no games; a played month in between starts a new row", async () => {
    club();
    weeks(DEC_TUESDAYS, ["played", "played", "played", "played", "played"]);
    // Month 1 (Nov): no games. Month 2 (Dec): all played. Month 3 (Jan), month 4 (Feb): no games.
    for (const [open, close] of [
      ["2026-11-01T14:00:00Z", "2026-12-01T10:00:00Z"],
      ["2026-12-15T12:00:00Z", "2027-01-01T10:00:00Z"],
      ["2027-01-15T12:00:00Z", "2027-02-01T10:00:00Z"],
      ["2027-02-15T12:00:00Z", "2027-03-01T10:00:00Z"],
      ["2027-03-15T12:00:00Z", "2027-04-01T09:00:00Z"],
    ]) {
      await runBillingCron(at(open));
      await runBillingCron(at(close));
      await runBillingCron(new Date(at(close).getTime() + HOUR));
    }
    expect(monthsOf().map((m) => [m.index, m.status])).toEqual([
      [1, "no-games"],
      [2, "paid"],
      [3, "no-games"],
      [4, "no-games"],
      [5, "no-games"],
      [6, "open"],
    ]);
    expect(dmsOf().map((d) => `${d.kind}:${monthsOf().find((m) => m.id === d.cycleKey)!.index}`)).toEqual([
      "month-free:1",
      "month-charged:2",
      "month-free:3",
    ]);
    expect(h.state.notices.get(h.key(ORG, "month-free", month(4).id))!.platformJobId).toBe("skipped:not-first");
    expect(h.state.notices.get(h.key(ORG, "month-free", month(5).id))!.platformJobId).toBe("skipped:not-first");
  });

  it("a month paid by the webhook AT NIGHT: no receipt then; the 10:00 run sends it, once", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    fake.setPayOutcome("pm_cole", "action"); // a bank check: the close leaves it open
    await runBillingCron(TRIAL_ENDS);
    await runBillingCron(CLOSE_M1);
    expect(month(1).status).toBe("invoiced");
    expect(dmsOf("month-charged")).toEqual([]);
    // The payer completes the bank check at 23:00; Stripe's invoice.paid arrives.
    const night = at("2026-12-01T23:00:00Z");
    const inv = invoices()[0];
    inv.status = "paid";
    await applyMonthInvoice({ orgId: ORG, monthId: month(1).id, invoice: { id: inv.id, status: "paid" } as never, kind: "paid", now: night });
    expect(await sendMonthCharged(ORG, month(1).id, night)).toBe("night");
    expect(dmsOf()).toEqual([]);
    await hourly(at("2026-12-02T00:00:00Z"), at("2026-12-02T12:00:00Z"));
    expect(dmsOf("month-charged")).toHaveLength(1);
    expect(dmsOf("month-charged")[0].text).toContain("played all 4 games between 1 Nov and 30 Nov, so £9.99 was charged");
    // A re-delivered webhook in the daytime: still one.
    expect(await sendMonthCharged(ORG, month(1).id, at("2026-12-02T13:00:00Z"))).toBe("already");
  });

  it("a month paid more than 3 days ago never gets a receipt (billing off for a while, a DM that kept failing)", async () => {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    await runBillingCron(TRIAL_ENDS);
    // The close runs, but the DM step is skipped (the contact has no phone yet).
    h.state.orgs.get(ORG)!.members.forEach((m) => (m.phoneNumber = null));
    await runBillingCron(CLOSE_M1);
    expect(month(1).status).toBe("paid");
    expect(await sendMonthCharged(ORG, month(1).id, at("2026-12-05T11:00:00Z"))).toBe("stale");
  });

  it("contact resolution: no collector, the OWNER gets it; a collector who left, the owner; nobody with a phone, no DM and an /admin/health note", async () => {
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"], "org_a");
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"], "org_b");
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"], "org_c");
    club({ paymentHolderId: null }, { cardHolderUserId: "u_owen" }, "org_a");
    club({}, {}, "org_b");
    h.state.orgs.get("org_b")!.members.find((m) => m.userId === "u_cole")!.leftAt = at("2026-11-20T00:00:00Z");
    club({ paymentHolderId: null }, {}, "org_c");
    h.state.orgs.get("org_c")!.members.forEach((m) => (m.phoneNumber = null));
    await runBillingCron(TRIAL_ENDS);
    await runBillingCron(CLOSE_M1);
    const to = (orgId: string) => dmsOf("month-charged").filter((d) => d.orgId === orgId).map((d) => d.userId);
    expect(to("org_a")).toEqual(["u_owen"]);
    expect(dmsOf("month-charged").find((d) => d.orgId === "org_a")!.text).toContain("charged to your card ending 4242");
    expect(to("org_b")).toEqual(["u_owen"]);
    // Owen is the contact, Cole's card is paying: "the card on file".
    expect(dmsOf("month-charged").find((d) => d.orgId === "org_b")!.text).toContain("charged to the card on file ending 4242");
    expect(to("org_c")).toEqual([]);
    expect(h.state.ops.some((o) => o.title === "No billing contact for a club fee message")).toBe(true);
  });
});

// ── The cron's own retries (5.3) ────────────────────────────────────────

describe("retries of a failed month: days 1, 3 and 5, daytime, configurable", () => {
  /** Month 1 closed and declined at 10:00 on 1 Dec; the webhook marks it failed (past due). */
  async function declinedMonth() {
    club();
    weeks(NOV_TUESDAYS, ["played", "played", "played", "played"]);
    fake.setPayOutcome("pm_cole", "decline");
    await runBillingCron(TRIAL_ENDS);
    await runBillingCron(CLOSE_M1);
    const inv = invoices()[0];
    await applyMonthInvoice({ orgId: ORG, monthId: month(1).id, invoice: { id: inv.id, status: "open" } as never, kind: "failed", now: CLOSE_M1 });
    Object.assign(h.state.orgs.get(ORG)!, { billingStatus: "past_due" });
    Object.assign(h.state.billings.get(ORG)!, { paymentFailedAt: CLOSE_M1, graceEndsAt: new Date(CLOSE_M1.getTime() + 7 * DAY) });
    expect(payCalls()).toHaveLength(1);
    return inv;
  }

  it("day 1 and day 3 retry once each (declined); day 5 succeeds: paid, back to subscribed, ONE receipt", async () => {
    await declinedMonth();
    await hourly(at("2026-12-02T08:00:00Z"), at("2026-12-02T19:00:00Z"));
    expect(payCalls()).toHaveLength(2); // the close + day 1, at 10:00 only
    expect(payCalls()[1].args).toMatchObject({ paymentMethodId: "pm_cole" });
    await hourly(at("2026-12-03T10:00:00Z"), at("2026-12-04T09:00:00Z"));
    expect(payCalls()).toHaveLength(2); // nothing on day 2
    await hourly(at("2026-12-04T10:00:00Z"), at("2026-12-04T19:00:00Z"));
    expect(payCalls()).toHaveLength(3); // day 3
    fake.setPayOutcome("pm_cole", "succeed");
    const r = await runBillingCron(at("2026-12-06T10:00:00Z"));
    expect(r.clubs[0].retries).toEqual(["1:d5:paid"]);
    expect(payCalls()).toHaveLength(4);
    expect(h.state.synced).toHaveLength(1);
    expect(month(1).status).toBe("paid");
    expect(h.state.orgs.get(ORG)!.billingStatus).toBe("subscribed");
    expect(dmsOf("month-charged")).toHaveLength(1);
    // Nothing after day 5.
    await hourly(at("2026-12-07T10:00:00Z"), at("2026-12-07T12:00:00Z"));
    expect(payCalls()).toHaveLength(4);
  });

  it("never at night; two runs at once retry a day once", async () => {
    await declinedMonth();
    await runBillingCron(at("2026-12-02T23:00:00Z"));
    expect(payCalls()).toHaveLength(1);
    await Promise.all([runBillingCron(at("2026-12-03T10:00:00Z")), runBillingCron(at("2026-12-03T10:00:00Z"))]);
    expect(payCalls()).toHaveLength(2);
  });

  it("after an outage (no run from day 0 to day 4), only day 3 runs, then day 5", async () => {
    await declinedMonth();
    const r = await runBillingCron(at("2026-12-05T12:00:00Z"));
    expect(r.clubs[0].retries).toEqual(["1:d3:declined"]);
    await runBillingCron(at("2026-12-05T13:00:00Z"));
    expect(payCalls()).toHaveLength(2);
    expect((await runBillingCron(at("2026-12-06T10:00:00Z"))).clubs[0].retries).toEqual(["1:d5:declined"]);
  });

  it("BILLING_CRON_RETRIES=0: the cron never retries (Stripe's own retries do)", async () => {
    await declinedMonth();
    process.env.BILLING_CRON_RETRIES = "0";
    await hourly(at("2026-12-02T10:00:00Z"), at("2026-12-02T12:00:00Z"));
    await runBillingCron(at("2026-12-04T10:00:00Z"));
    await runBillingCron(at("2026-12-06T10:00:00Z"));
    expect(payCalls()).toHaveLength(1);
  });

  it("BILLING_CRON_RETRIES unset: the DEFAULT is no cron retries (Stripe's own are the one mechanism)", async () => {
    await declinedMonth();
    delete process.env.BILLING_CRON_RETRIES;
    await hourly(at("2026-12-02T10:00:00Z"), at("2026-12-02T12:00:00Z"));
    await runBillingCron(at("2026-12-04T10:00:00Z"));
    await runBillingCron(at("2026-12-06T10:00:00Z"));
    expect(payCalls()).toHaveLength(1);
  });

  it("never once the club stopped being billed (suspended) or has no card on file", async () => {
    await declinedMonth();
    h.state.billings.get(ORG)!.stripePaymentMethodId = null;
    await runBillingCron(at("2026-12-02T10:00:00Z"));
    expect(payCalls()).toHaveLength(1);
    h.state.billings.get(ORG)!.stripePaymentMethodId = "pm_cole";
    h.state.orgs.get(ORG)!.billingPlan = "free";
    h.state.orgs.get(ORG)!.billingStatus = "exempt";
    await runBillingCron(at("2026-12-04T10:00:00Z"));
    expect(payCalls()).toHaveLength(1);
  });
});
