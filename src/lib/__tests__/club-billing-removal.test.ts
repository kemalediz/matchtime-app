/**
 * CLUB FEE BILLING, slice B5: MatchTime removed from, and added back to, a
 * live club's group. Plan: MDs/club-fee-billing-plan-2026-10-01.md, 4.2.
 *
 * The database is one in-memory club; `setBillingState` is replaced by one
 * that applies the REAL pure `nextBillingState` to it (the one writer
 * itself is covered by club-billing.test.ts). Stripe is the fake adapter.
 * No network, no model, no DMs.
 *
 * The safety lines: Sutton FC (approvedAt NULL), an exempt club and the
 * flag off are LOGGED ONLY, with no write and no Stripe call; a pending
 * club's group is "no-club" so the route keeps today's self-join path.
 *
 * Slice P2 (games played): no subscription to end. A removal makes no
 * Stripe call but expiring open card sessions; the games played before it
 * are charged when the month closes. A re-add reads OUR rows: the card on
 * file and any unpaid month.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Club = {
  id: string;
  approvalStatus: string;
  approvedAt: Date | null;
  billingStatus: string;
  billingPlan: string;
  whatsappGroupId: string;
};
type Billing = {
  trialEndsAt: Date;
  graceEndsAt: Date | null;
  pausedAt: Date | null;
  pausedReason: string | null;
  stripeCustomerId: string | null;
  stripePaymentMethodId: string | null;
  cancelAtPeriodEnd: boolean;
  resumedAt: Date | null;
};

const h = vi.hoisted(() => {
  const state = {
    club: null as Club | null,
    billing: null as Billing | null,
    writes: 0,
    events: [] as Array<{ type: string; card?: unknown }>,
    unpaid: [] as string[],
    ops: [] as Array<{ kind: string; title: string; dedupeKey?: string | null }>,
    raceOnce: false,
  };
  const db = {
    organisation: {
      findFirst: vi.fn(async ({ where }: { where: { whatsappGroupId: string; approvalStatus: string } }) => {
        const c = state.club;
        if (!c || c.whatsappGroupId !== where.whatsappGroupId || c.approvalStatus !== where.approvalStatus) return null;
        return {
          id: c.id,
          approvedAt: c.approvedAt,
          billingStatus: c.billingStatus,
          clubBilling: state.billing
            ? {
                pausedReason: state.billing.pausedReason,
                stripeCustomerId: state.billing.stripeCustomerId,
                stripePaymentMethodId: state.billing.stripePaymentMethodId,
              }
            : null,
        };
      }),
    },
    clubBilling: {
      findUnique: vi.fn(async () => (state.billing ? { ...state.billing } : null)),
      updateMany: vi.fn(async ({ data }: { data: Partial<Billing> }) => {
        if (!state.billing) return { count: 0 };
        state.writes++;
        Object.assign(state.billing, data);
        return { count: 1 };
      }),
    },
  };
  return { state, db };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("../db", () => ({ db: h.db }));
vi.mock("../ops-alerts", () => ({
  BILLING_ALERT_KIND: "club-billing",
  recordOpsEvent: vi.fn(async (a: { kind: string; title: string; dedupeKey?: string | null }) => {
    h.state.ops.push(a);
    return true;
  }),
}));
vi.mock("../club-billing-months", () => ({ unpaidMonthIds: vi.fn(async () => h.state.unpaid) }));
vi.mock("../club-billing", async () => {
  const rules = await import("../club-billing-rules");
  return {
    setBillingState: vi.fn(async (_orgId: string, event: { type: string }, now: Date) => {
      h.state.events.push(event);
      const c = h.state.club!;
      const b = h.state.billing;
      if (h.state.raceOnce) {
        // Another writer got there first: the club is already paused (removed).
        h.state.raceOnce = false;
        c.billingStatus = "paused";
        if (b) b.pausedReason = "removed";
        return { ok: false, reason: "no-change" };
      }
      const t = rules.nextBillingState(
        {
          approvedAt: c.approvedAt,
          billingStatus: c.billingStatus,
          billingPlan: c.billingPlan,
          billing: b ? { trialEndsAt: b.trialEndsAt, graceEndsAt: b.graceEndsAt, pausedReason: b.pausedReason } : null,
        },
        event as never,
        now,
        { BILLING_ENABLED: "1" },
      );
      if (!t) return { ok: false, reason: "no-change" };
      const from = c.billingStatus;
      c.billingStatus = t.to;
      h.state.writes++;
      if (b) {
        if (t.to === "paused") Object.assign(b, { pausedAt: now, pausedReason: t.pausedReason });
        else if (from === "paused") Object.assign(b, { pausedAt: null, pausedReason: null });
        if (t.resumes) b.resumedAt = now;
      }
      return { ok: true, from, to: t.to, resumed: t.resumes };
    }),
  };
});

import { handleBillingReAdd, handleBillingRemoval, removalAnswer } from "../club-billing-removal";
import { setBillingStripeForTests } from "../stripe-billing";
import { createFakeBillingStripe, type FakeBillingStripe } from "../stripe-billing-fake";

const DAY = 24 * 60 * 60 * 1000;
const GROUP = "120363900000000201@g.us";
const APPROVED_AT = new Date("2026-10-01T09:00:00Z");
const TRIAL_ENDS = new Date(APPROVED_AT.getTime() + 30 * DAY);
const IN_TRIAL = new Date("2026-10-10T12:00:00Z");
const AFTER_TRIAL = new Date(TRIAL_ENDS.getTime() + 20 * DAY);
const ON = { flagOn: true, now: IN_TRIAL };

let stripe: FakeBillingStripe;

function seed(club: Partial<Club> = {}, billing: Partial<Billing> | null = {}) {
  h.state.club = {
    id: "org_b5",
    approvalStatus: "approved",
    approvedAt: APPROVED_AT,
    billingStatus: "trial",
    billingPlan: "standard",
    whatsappGroupId: GROUP,
    ...club,
  };
  h.state.billing =
    billing === null
      ? null
      : {
          trialEndsAt: TRIAL_ENDS,
          graceEndsAt: null,
          pausedAt: null,
          pausedReason: null,
          stripeCustomerId: null,
          stripePaymentMethodId: null,
          cancelAtPeriodEnd: false,
          resumedAt: null,
          ...billing,
        };
}

/** A Customer and a card on file (slice P2: no subscription). */
function withCard() {
  return { stripeCustomerId: "cus_b5", stripePaymentMethodId: "pm_b5" };
}

const stripeCalls = () => stripe.state().calls.map((c) => c.method);

beforeEach(() => {
  vi.clearAllMocks();
  h.state.writes = 0;
  h.state.events = [];
  h.state.ops = [];
  h.state.raceOnce = false;
  h.state.unpaid = [];
  stripe = createFakeBillingStripe();
  setBillingStripeForTests(stripe);
});
afterEach(() => setBillingStripeForTests(null));

describe("removed: never billed, or the flag off, is LOGGED ONLY", () => {
  it("Sutton FC (approvedAt NULL, exempt): logged, nothing written, nothing to Stripe", async () => {
    seed({ approvedAt: null, billingStatus: "exempt" }, null);
    expect(await handleBillingRemoval(GROUP, ON)).toEqual({ kind: "logged", orgId: "org_b5", why: "exempt-club" });
    expect(h.state.writes).toBe(0);
    expect(h.state.events).toEqual([]);
    expect(stripe.state().calls).toEqual([]);
  });

  it("even a corrupted pre-self-join row that says 'subscribed' is never paused", async () => {
    seed({ approvedAt: null, billingStatus: "subscribed" }, withCard());
    expect((await handleBillingRemoval(GROUP, ON)).kind).toBe("logged");
    expect(h.state.club!.billingStatus).toBe("subscribed");
    expect(stripeCalls()).toEqual([]);
  });

  it("a self-join club that is exempt (never trialled, or plan Free): logged only", async () => {
    seed({ billingStatus: "exempt" }, null);
    expect(await handleBillingRemoval(GROUP, ON)).toEqual({ kind: "logged", orgId: "org_b5", why: "not-billed" });
    expect(h.state.writes).toBe(0);
  });

  for (const status of ["trial", "grace", "subscribed", "past_due"]) {
    it(`BILLING_ENABLED off: a club in ${status} is logged only, nothing written, nothing to Stripe`, async () => {
      seed({ billingStatus: status }, withCard());
      expect(await handleBillingRemoval(GROUP, { flagOn: false, now: IN_TRIAL })).toEqual({ kind: "logged", orgId: "org_b5", why: "flag-off" });
      expect(h.state.club!.billingStatus).toBe(status);
      expect(h.state.writes).toBe(0);
      expect(stripeCalls()).toEqual([]);
    });
  }

  it("a group no approved club owns (pending, suspended, unsolicited): no-club, so the route keeps today's path", async () => {
    seed({ approvalStatus: "pending", approvedAt: null, billingStatus: "exempt" }, null);
    expect(await handleBillingRemoval(GROUP, ON)).toEqual({ kind: "no-club" });
    seed({ approvalStatus: "suspended", billingStatus: "subscribed" }, withCard());
    expect(await handleBillingRemoval(GROUP, ON)).toEqual({ kind: "no-club" });
    expect(await handleBillingRemoval("someone-else@g.us", ON)).toEqual({ kind: "no-club" });
    expect(h.state.writes).toBe(0);
    expect(stripeCalls()).toEqual([]);
  });
});

describe("removed: a billed club is paused (removed); NOTHING in Stripe but expiring open card sessions", () => {
  it("in the free month with no card and no Customer: paused (removed), no Stripe call at all", async () => {
    seed({ billingStatus: "trial" });
    expect(await handleBillingRemoval(GROUP, ON)).toEqual({ kind: "paused", orgId: "org_b5", stripe: "no-customer" });
    expect(h.state.club!.billingStatus).toBe("paused");
    expect(h.state.billing!.pausedReason).toBe("removed");
    expect(stripeCalls()).toEqual([]);
  });

  for (const status of ["trial", "grace", "subscribed", "past_due"] as const) {
    it(`${status} with a card: paused (removed); only the open card sessions expire (nothing charged, ended or refunded)`, async () => {
      seed({ billingStatus: status }, withCard());
      expect(await handleBillingRemoval(GROUP, ON)).toEqual({ kind: "paused", orgId: "org_b5", stripe: "sessions-expired" });
      expect(h.state.billing!.pausedReason).toBe("removed");
      expect(stripeCalls()).toEqual(["expireOpenCheckoutSessions"]);
      // The card stays: the games played before the removal are charged
      // when this month closes.
      expect(h.state.billing!.stripePaymentMethodId).toBe("pm_b5");
    });
  }

  it("IDEMPOTENT: a repeated removal changes nothing", async () => {
    seed({ billingStatus: "subscribed" }, withCard());
    await handleBillingRemoval(GROUP, ON);
    const writes = h.state.writes;
    const pausedAt = h.state.billing!.pausedAt;
    expect(await handleBillingRemoval(GROUP, { flagOn: true, now: new Date(IN_TRIAL.getTime() + 60_000) })).toEqual({
      kind: "already-paused",
      orgId: "org_b5",
      stripe: "sessions-expired",
    });
    expect(h.state.billing!.pausedAt).toEqual(pausedAt);
    expect(h.state.writes).toBe(writes);
  });

  it("a repeat HEALS a session expiry that failed the first time; the failure is on /admin/health, the club paused anyway", async () => {
    seed({ billingStatus: "subscribed" }, withCard());
    const real = stripe.expireOpenCheckoutSessions;
    stripe.expireOpenCheckoutSessions = vi.fn(async () => {
      throw new Error("Stripe is down");
    });
    expect(await handleBillingRemoval(GROUP, ON)).toEqual({ kind: "paused", orgId: "org_b5", stripe: "failed" });
    expect(h.state.club!.billingStatus).toBe("paused");
    expect(h.state.ops).toEqual([expect.objectContaining({ kind: "club-billing", dedupeKey: "removed-sessions-org_b5" })]);
    stripe.expireOpenCheckoutSessions = real;
    expect(await handleBillingRemoval(GROUP, ON)).toMatchObject({ kind: "already-paused", stripe: "sessions-expired" });
  });

  it("a club paused for another reason (no card) is left exactly as it is", async () => {
    seed({ billingStatus: "paused" }, { pausedReason: "no-card" });
    expect(await handleBillingRemoval(GROUP, ON)).toEqual({ kind: "logged", orgId: "org_b5", why: "paused-other" });
    expect(h.state.billing!.pausedReason).toBe("no-card");
    expect(h.state.writes).toBe(0);
  });

  it("raced by another writer that already paused it (removed): already-paused, sessions still expired", async () => {
    seed({ billingStatus: "subscribed" }, withCard());
    h.state.raceOnce = true;
    expect(await handleBillingRemoval(GROUP, ON)).toMatchObject({ kind: "already-paused", stripe: "sessions-expired" });
  });

  it("the Pi's answer word", () => {
    expect(removalAnswer({ kind: "paused", orgId: "o", stripe: "no-customer" })).toBe("paused");
    expect(removalAnswer({ kind: "already-paused", orgId: "o", stripe: "sessions-expired" })).toBe("already-paused");
    expect(removalAnswer({ kind: "logged", orgId: "o", why: "exempt-club" })).toBe("exempt");
    expect(removalAnswer({ kind: "logged", orgId: "o", why: "flag-off" })).toBe("flag-off");
  });
});

describe("added back (read from our rows, no Stripe call)", () => {
  async function removedThen(status: string, card = false) {
    seed({ billingStatus: status }, card ? withCard() : {});
    await handleBillingRemoval(GROUP, ON);
    expect(h.state.billing!.pausedReason).toBe("removed");
    h.state.events = [];
  }

  it("in the free month, no card: back to trial with the SAME trial end, resumed", async () => {
    await removedThen("trial");
    expect(await handleBillingReAdd(GROUP, { flagOn: true, now: new Date(IN_TRIAL.getTime() + DAY) })).toEqual({
      kind: "resumed",
      orgId: "org_b5",
      to: "trial",
    });
    expect(h.state.club!.billingStatus).toBe("trial");
    expect(h.state.billing!.trialEndsAt).toEqual(TRIAL_ENDS);
    expect(h.state.billing!.resumedAt).not.toBeNull();
  });

  it("a card on file and nothing unpaid: subscribed, resumed (inside or after the free month)", async () => {
    await removedThen("subscribed", true);
    expect(await handleBillingReAdd(GROUP, { flagOn: true, now: AFTER_TRIAL })).toEqual({ kind: "resumed", orgId: "org_b5", to: "subscribed" });
    expect(h.state.events).toEqual([{ type: "re-added", card: "ok" }]);
    expect(stripeCalls()).toEqual(["expireOpenCheckoutSessions"]);
  });

  it("an UNPAID month: stays paused waiting for the payment (Update card and pay brings it back)", async () => {
    await removedThen("past_due", true);
    h.state.unpaid = ["cbm_1"];
    expect(await handleBillingReAdd(GROUP, { flagOn: true, now: AFTER_TRIAL })).toEqual({
      kind: "still-paused",
      orgId: "org_b5",
      reason: "payment-failed",
    });
    expect(h.state.billing!.pausedReason).toBe("payment-failed");
  });

  it("after the free month with no card: stays paused, now waiting for a card", async () => {
    await removedThen("grace");
    expect(await handleBillingReAdd(GROUP, { flagOn: true, now: AFTER_TRIAL })).toEqual({ kind: "still-paused", orgId: "org_b5", reason: "no-card" });
    expect(h.state.billing!.pausedReason).toBe("no-card");
  });

  it("IDEMPOTENT: a second re-add does nothing", async () => {
    await removedThen("trial");
    await handleBillingReAdd(GROUP, ON);
    expect(await handleBillingReAdd(GROUP, ON)).toEqual({ kind: "not-removed" });
  });

  it("never touches Sutton FC, an exempt club, a club paused for another reason, or anything with the flag off", async () => {
    seed({ approvedAt: null, billingStatus: "exempt" }, null);
    expect(await handleBillingReAdd(GROUP, ON)).toEqual({ kind: "not-removed" });
    seed({ billingStatus: "paused" }, { pausedReason: "no-card" });
    expect(await handleBillingReAdd(GROUP, ON)).toEqual({ kind: "not-removed" });
    seed({ billingStatus: "paused" }, { pausedReason: "removed" });
    expect(await handleBillingReAdd(GROUP, { flagOn: false, now: IN_TRIAL })).toEqual({ kind: "not-removed" });
    expect(h.state.writes).toBe(0);
    expect(stripe.state().calls).toEqual([]);
  });
});
