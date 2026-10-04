/**
 * CLUB FEE BILLING, slice B2: the platform owner's plan control, "Start
 * free month", the billing page's guard and the tip's loader.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.2, 4.5, 7.2, 8.3,
 * and the B2 note in section 13 (Free: exempt FIRST, then the plan, in ONE
 * transaction, because Organisation_billingFreeExempt_check refuses a Free
 * plan on a club that is not exempt; leaving Free the other way round).
 *
 * db is mocked with a small in-memory club whose writes enforce the same
 * CHECK constraints as Postgres (prisma/sql/org-billing-check.sql), so an
 * ordering mistake throws here exactly as it would in production.
 *
 * No network, no model, nothing messaged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Club = {
  billingStatus: string;
  billingPlan: string;
  billingPricePence: number | null;
  approvedAt: Date | null;
  billing: {
    trialEndsAt: Date;
    graceEndsAt: Date | null;
    pausedReason: string | null;
    stripePaymentMethodId?: string | null;
    cardHolderUserId?: string | null;
    cancelAtPeriodEnd?: boolean;
  } | null;
  /** The money collector (the billing contact when a member with a phone). */
  paymentHolderId?: string | null;
};

const h = vi.hoisted(() => {
  const state: { club: Club | null; log: string[]; inTx: number } = { club: null, log: [], inTx: 0 };
  const m = {
    organisation: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    clubBilling: { create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    membership: { findMany: vi.fn(), findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    botJob: { updateMany: vi.fn() },
    match: { findMany: vi.fn(), updateMany: vi.fn() },
    sentNotification: { createMany: vi.fn() },
    organiserPickRound: { updateMany: vi.fn() },
    benchSlotOffer: { updateMany: vi.fn() },
    platformJob: { create: vi.fn() },
    billingNotice: { createMany: vi.fn() },
    billingEvent: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { state, m };
});
vi.mock("@/lib/db", () => ({ db: h.m }));

import {
  BillingAccessDenied,
  loadBillingAccess,
  loadClubFeeTip,
  requireClubBillingAccess,
  setClubPlan,
  startTrial,
} from "../club-billing";

const m = h.m;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-10T12:00:00Z");
const APPROVED_AT = new Date("2026-10-01T09:00:00Z");

const ENV = process.env.BILLING_ENABLED;
afterEach(() => {
  if (ENV === undefined) delete process.env.BILLING_ENABLED;
  else process.env.BILLING_ENABLED = ENV;
});

/** The CHECK constraints of org-billing-check.sql, on the in-memory row. */
function checkConstraints(c: Club) {
  if (!["exempt", "trial", "grace", "subscribed", "past_due", "paused"].includes(c.billingStatus)) throw new Error("billingStatus_check");
  if (!["standard", "free", "custom"].includes(c.billingPlan)) throw new Error("billingPlan_check");
  const priced = c.billingPricePence !== null && c.billingPricePence >= 100 && c.billingPricePence <= 999;
  if ((c.billingPlan === "custom") !== priced) throw new Error("billingPricePence_check");
  if (c.billingPlan === "free" && c.billingStatus !== "exempt") throw new Error("Organisation_billingFreeExempt_check");
  if (c.approvedAt === null && c.billingStatus !== "exempt") throw new Error("billingPreSelfJoinExempt_check");
}

function setClub(over: Partial<Club> = {}) {
  h.state.club = {
    billingStatus: "trial",
    billingPlan: "standard",
    billingPricePence: null,
    approvedAt: APPROVED_AT,
    billing: { trialEndsAt: new Date(APPROVED_AT.getTime() + 30 * DAY), graceEndsAt: null, pausedReason: null },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.log = [];
  h.state.inTx = 0;
  process.env.BILLING_ENABLED = "1";
  setClub();
  m.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    const c = h.state.club;
    if (sql.includes('FROM "Organisation"')) {
      h.state.log.push("lock-org");
      return c ? [{ billingStatus: c.billingStatus, billingPlan: c.billingPlan, approvedAt: c.approvedAt }] : [];
    }
    if (sql.includes('FROM "ClubBilling"')) return c?.billing ? [{ ...c.billing }] : [];
    throw new Error(`unexpected raw SQL: ${sql}`);
  });
  m.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    h.state.inTx++;
    // All or nothing: on a throw, restore the row as it was.
    const before = h.state.club ? structuredClone(h.state.club) : null;
    try {
      return await fn(m);
    } catch (err) {
      h.state.club = before;
      throw err;
    } finally {
      h.state.inTx--;
    }
  });
  m.organisation.updateMany.mockImplementation(async (a: { where: { billingStatus: string }; data: { billingStatus: string } }) => {
    const c = h.state.club;
    if (!c || c.billingStatus !== a.where.billingStatus) return { count: 0 };
    h.state.log.push(`status:${a.data.billingStatus}${h.state.inTx ? "" : ":NO-TX"}`);
    c.billingStatus = a.data.billingStatus;
    checkConstraints(c);
    return { count: 1 };
  });
  m.organisation.update.mockImplementation(async (a: { data: { billingPlan: string; billingPricePence: number | null } }) => {
    const c = h.state.club!;
    h.state.log.push(`plan:${a.data.billingPlan}${h.state.inTx ? "" : ":NO-TX"}`);
    c.billingPlan = a.data.billingPlan;
    c.billingPricePence = a.data.billingPricePence;
    checkConstraints(c);
    return {};
  });
  m.clubBilling.create.mockImplementation(async (a: { data: { trialEndsAt: Date } }) => {
    h.state.club!.billing = { trialEndsAt: a.data.trialEndsAt, graceEndsAt: null, pausedReason: null };
    return {};
  });
  m.clubBilling.updateMany.mockImplementation(async (a: { data: Record<string, unknown> }) => {
    const c = h.state.club;
    if (c?.billing && "stripePaymentMethodId" in a.data) Object.assign(c.billing, a.data);
    return { count: 1 };
  });
  m.clubBilling.findUnique.mockImplementation(async () => (h.state.club?.billing ? { ...h.state.club.billing } : null));
  m.botJob.updateMany.mockResolvedValue({ count: 0 });
  m.match.findMany.mockResolvedValue([]);
  m.match.updateMany.mockResolvedValue({ count: 0 });
  m.sentNotification.createMany.mockResolvedValue({ count: 0 });
  m.organiserPickRound.updateMany.mockResolvedValue({ count: 0 });
  m.benchSlotOffer.updateMany.mockResolvedValue({ count: 0 });
  m.organisation.findUnique.mockImplementation(async () => {
    const c = h.state.club;
    return c
      ? {
          billingStatus: c.billingStatus,
          billingPlan: c.billingPlan,
          approvedAt: c.approvedAt,
          clubBilling: c.billing,
          paymentHolderId: c.paymentHolderId ?? "u_colin",
          memberships: [
            { userId: "u_owner", role: "OWNER", leftAt: null, user: { phoneNumber: "+447700900001", name: "Olly" } },
            { userId: "u_colin", role: "PLAYER", leftAt: null, user: { phoneNumber: "+447700900002", name: "Colin" } },
            { userId: "u_pat", role: "PLAYER", leftAt: null, user: { phoneNumber: "+447700900003", name: "Pat" } },
          ],
        }
      : null;
  });
});

describe("setClubPlan: the platform owner's plan control (8.3, B2 note)", () => {
  it("Free on a club in its free month: status to exempt FIRST, then the plan, in ONE transaction", async () => {
    const r = await setClubPlan("org1", { plan: "free", pricePence: null }, NOW);
    expect(r).toMatchObject({ ok: true, plan: "free", status: "exempt" });
    expect(h.state.log).toEqual(["lock-org", "lock-org", "status:exempt", "plan:free"]);
    expect(m.$transaction).toHaveBeenCalledTimes(1);
    expect(h.state.club).toMatchObject({ billingStatus: "exempt", billingPlan: "free", billingPricePence: null });
  });

  it("a back-to-trial (free month still running) writes no pending DM", async () => {
    setClub({ billingStatus: "exempt", billingPlan: "free" });
    await setClubPlan("org1", { plan: "standard", pricePence: null }, NOW);
    expect(m.billingNotice.createMany).not.toHaveBeenCalled();
  });

  it("round-2 N1: Free records WHEN the club became exempt, in the same transaction (the refund window)", async () => {
    await setClubPlan("org1", { plan: "free", pricePence: null }, NOW);
    expect(m.billingEvent.create).toHaveBeenCalledWith({
      data: { id: `mt_exempt_org1_${NOW.getTime()}`, type: "mt.club-exempt", orgId: "org1", receivedAt: NOW, processedAt: NOW },
    });
  });

  it("Free on a club that was already exempt records nothing", async () => {
    setClub({ billingStatus: "exempt", billing: null });
    await setClubPlan("org1", { plan: "free", pricePence: null }, NOW);
    expect(m.billingEvent.create).not.toHaveBeenCalled();
  });

  it("Free on a PAUSED club resumes it, in the same transaction", async () => {
    setClub({ billingStatus: "paused", billing: { trialEndsAt: APPROVED_AT, graceEndsAt: null, pausedReason: "no-card" } });
    const r = await setClubPlan("org1", { plan: "free", pricePence: null }, NOW);
    expect(r).toMatchObject({ ok: true, status: "exempt", resumed: true });
    expect(m.botJob.updateMany).toHaveBeenCalledTimes(1);
    expect(m.$transaction).toHaveBeenCalledTimes(1);
  });

  it("Free on an exempt club only writes the plan", async () => {
    setClub({ billingStatus: "exempt", billing: null });
    expect(await setClubPlan("org1", { plan: "free", pricePence: null }, NOW)).toMatchObject({ ok: true, status: "exempt" });
    expect(h.state.log).toEqual(["lock-org", "plan:free"]);
  });

  it("leaving Free, never trialled: the plan first, the status stays exempt (no trial starts by itself)", async () => {
    setClub({ billingStatus: "exempt", billingPlan: "free", billing: null });
    expect(await setClubPlan("org1", { plan: "standard", pricePence: null }, NOW)).toMatchObject({
      ok: true,
      plan: "standard",
      status: "exempt",
      billedAgain: null,
    });
    // The second lock is the same transaction re-reading under its own
    // lock (a no-op in Postgres) before deciding "plan-billed" does not apply.
    expect(h.state.log).toEqual(["lock-org", "plan:standard", "lock-org"]);
    expect(m.clubBilling.create).not.toHaveBeenCalled();
  });

  // Slice B3, the gap found in B2: Free and back after the free month was
  // used would leave the club exempt for ever ("Start free month" refuses a
  // second free month). Now it is billed again, in the SAME transaction,
  // plan first so the CHECK constraints hold at every statement.
  it("leaving Free after the free month was used: plan first, then GRACE with a fresh 7 days", async () => {
    const trialEndsAt = new Date(APPROVED_AT.getTime() + 30 * DAY);
    const later = new Date(trialEndsAt.getTime() + 20 * DAY);
    setClub({ billingStatus: "exempt", billingPlan: "free", billing: { trialEndsAt, graceEndsAt: null, pausedReason: null } });
    expect(await setClubPlan("org1", { plan: "standard", pricePence: null }, later)).toMatchObject({
      ok: true,
      plan: "standard",
      status: "grace",
      billedAgain: "grace",
    });
    expect(h.state.log).toEqual(["lock-org", "plan:standard", "lock-org", "status:grace"]);
    expect(m.$transaction).toHaveBeenCalledTimes(1);
    const patch = m.clubBilling.updateMany.mock.calls.at(-1)![0].data;
    expect(patch.graceEndsAt).toEqual(new Date(later.getTime() + 7 * DAY));
    expect(patch).toMatchObject({ paymentFailedAt: null, pausedAt: null, pausedReason: null });
    // Review fix 10: the "plan-billed" DM is PENDING in the same transaction.
    expect(m.billingNotice.createMany).toHaveBeenCalledWith({
      data: [{ orgId: "org1", kind: "plan-billed", cycleKey: later.toISOString() }],
      skipDuplicates: true,
    });
  });

  it("leaving Free while the original free month is still running: back to TRIAL, its end kept", async () => {
    setClub({ billingStatus: "exempt", billingPlan: "free" });
    expect(await setClubPlan("org1", { plan: "custom", pricePence: 500 }, NOW)).toMatchObject({
      ok: true,
      status: "trial",
      billedAgain: "trial",
    });
    expect(m.clubBilling.create).not.toHaveBeenCalled();
  });

  it("Standard pressed again on an exempt club with a used free month does the same (the way out of the old gap)", async () => {
    const trialEndsAt = new Date(APPROVED_AT.getTime() + 30 * DAY);
    setClub({ billingStatus: "exempt", billingPlan: "standard", billing: { trialEndsAt, graceEndsAt: null, pausedReason: null } });
    expect(await setClubPlan("org1", { plan: "standard", pricePence: null }, new Date(trialEndsAt.getTime() + DAY))).toMatchObject({
      status: "grace",
      billedAgain: "grace",
    });
  });

  // Test mode, 2026-10-05: a club with a card on file set Free and back to
  // Standard went trial, grace, then paused for "no card".
  // Test mode, 2026-10-05: a club with a card on file set Free and back to
  // Standard went trial, grace, then paused for "no card". Review M1: only
  // the CURRENT billing contact's card is billed again, and they are told.
  const TRIAL_ENDS_AT = new Date(APPROVED_AT.getTime() + 30 * DAY);
  const carded = (over: Partial<NonNullable<Club["billing"]>> = {}) => ({
    trialEndsAt: TRIAL_ENDS_AT,
    graceEndsAt: null,
    pausedReason: null,
    stripePaymentMethodId: "pm_1",
    cardHolderUserId: "u_colin",
    ...over,
  });

  it("leaving Free with the CONTACT's card on file (free month used): straight to SUBSCRIBED, a 'billed again' DM pending, no 'add a card' DM", async () => {
    const later = new Date(TRIAL_ENDS_AT.getTime() + 20 * DAY);
    setClub({ billingStatus: "exempt", billingPlan: "free", billing: carded() });
    expect(await setClubPlan("org1", { plan: "standard", pricePence: null }, later)).toMatchObject({
      ok: true,
      status: "subscribed",
      billedAgain: "subscribed",
      droppedCard: null,
    });
    expect(m.billingNotice.createMany).toHaveBeenCalledTimes(1);
    expect(m.billingNotice.createMany).toHaveBeenCalledWith({
      data: [{ orgId: "org1", kind: "billed-again", cycleKey: later.toISOString() }],
      skipDuplicates: true,
    });
    const patch = m.clubBilling.updateMany.mock.calls.map((c) => c[0].data).find((d) => "pausedReason" in d);
    expect(patch).toMatchObject({ graceEndsAt: null, paymentFailedAt: null, pausedAt: null, pausedReason: null, cancelAtPeriodEnd: false });
    expect(h.state.club!.billing!.stripePaymentMethodId).toBe("pm_1");
  });

  it("leaving Free with the contact's card inside the free month: SUBSCRIBED, the card kept", async () => {
    setClub({ billingStatus: "exempt", billingPlan: "free", billing: carded() });
    expect(await setClubPlan("org1", { plan: "standard", pricePence: null }, NOW)).toMatchObject({ status: "subscribed", billedAgain: "subscribed" });
    expect(m.clubBilling.create).not.toHaveBeenCalled();
  });

  it("review M1: the card on file is a PREVIOUS collector's: never billed; removed from the club in the same transaction, its holder told; GRACE asks the contact", async () => {
    const later = new Date(TRIAL_ENDS_AT.getTime() + 20 * DAY);
    setClub({ billingStatus: "exempt", billingPlan: "free", billing: carded({ cardHolderUserId: "u_pat" }) });
    expect(await setClubPlan("org1", { plan: "standard", pricePence: null }, later)).toMatchObject({
      status: "grace",
      billedAgain: "grace",
      droppedCard: { paymentMethodId: "pm_1", holderUserId: "u_pat" },
    });
    expect(h.state.club!.billing).toMatchObject({ stripePaymentMethodId: null, cardHolderUserId: null });
    const notices = m.billingNotice.createMany.mock.calls.map((c) => c[0].data[0]);
    expect(notices).toEqual([
      { orgId: "org1", kind: "card-dropped", cycleKey: "pm_1|u_pat" },
      { orgId: "org1", kind: "plan-billed", cycleKey: later.toISOString() },
    ]);
  });

  it("review M1: a card with no known holder is not billed either", async () => {
    setClub({ billingStatus: "exempt", billingPlan: "free", billing: carded({ cardHolderUserId: null }) });
    expect(await setClubPlan("org1", { plan: "standard", pricePence: null }, NOW)).toMatchObject({ status: "trial", droppedCard: { paymentMethodId: "pm_1", holderUserId: null } });
  });

  it("flag off: leaving Free never drops or bills a card", async () => {
    delete process.env.BILLING_ENABLED;
    setClub({ billingStatus: "exempt", billingPlan: "free", billing: carded({ cardHolderUserId: "u_pat" }) });
    expect(await setClubPlan("org1", { plan: "standard", pricePence: null }, NOW)).toMatchObject({ status: "exempt", droppedCard: null });
    expect(h.state.club!.billing!.stripePaymentMethodId).toBe("pm_1");
  });

  it("a club that had STOPPED paying, set Free and back: paused (cancelled) again, never charged without Keep paying", async () => {
    const later = new Date(TRIAL_ENDS_AT.getTime() + 40 * DAY);
    setClub({ billingStatus: "paused", billing: carded({ pausedReason: "cancelled", cancelAtPeriodEnd: true }) });
    await setClubPlan("org1", { plan: "free", pricePence: null }, later);
    // The stop is remembered through the Free spell (the pause reason is cleared).
    const freePatch = m.clubBilling.updateMany.mock.calls.map((c) => c[0].data).find((d) => "pausedReason" in d);
    expect(freePatch).toMatchObject({ pausedReason: null, cancelAtPeriodEnd: true });
    h.state.club!.billing = { ...h.state.club!.billing!, pausedReason: null, cancelAtPeriodEnd: true };
    expect(await setClubPlan("org1", { plan: "standard", pricePence: null }, new Date(later.getTime() + DAY))).toMatchObject({
      status: "paused",
      billedAgain: "paused",
    });
    expect(m.billingNotice.createMany).not.toHaveBeenCalled();
  });

  it("review M1: a club paused because MatchTime was REMOVED from its group, set Free and back: still paused (removed)", async () => {
    const later = new Date(TRIAL_ENDS_AT.getTime() + 40 * DAY);
    setClub({ billingStatus: "paused", billing: carded({ pausedReason: "removed" }) });
    await setClubPlan("org1", { plan: "free", pricePence: null }, later);
    // The removal is remembered through the Free spell.
    const freePatch = m.clubBilling.updateMany.mock.calls.map((c) => c[0].data).find((d) => "pausedReason" in d);
    expect(freePatch).toMatchObject({ pausedReason: "removed", pausedAt: null });
    h.state.club!.billing = { ...h.state.club!.billing!, pausedReason: "removed" };
    expect(await setClubPlan("org1", { plan: "standard", pricePence: null }, new Date(later.getTime() + DAY))).toMatchObject({
      status: "paused",
      billedAgain: "paused",
    });
    expect(m.billingNotice.createMany).not.toHaveBeenCalled();
  });

  it("flag off: leaving Free bills nobody", async () => {
    delete process.env.BILLING_ENABLED;
    const trialEndsAt = new Date(APPROVED_AT.getTime() + 30 * DAY);
    setClub({ billingStatus: "exempt", billingPlan: "free", billing: { trialEndsAt, graceEndsAt: null, pausedReason: null } });
    expect(await setClubPlan("org1", { plan: "standard", pricePence: null }, new Date(trialEndsAt.getTime() + DAY))).toMatchObject({
      status: "exempt",
      billedAgain: null,
    });
  });

  it("Custom GBP 5 on a club in trial: plan and price, the state untouched", async () => {
    expect(await setClubPlan("org1", { plan: "custom", pricePence: 500 }, NOW)).toMatchObject({
      ok: true,
      plan: "custom",
      pricePence: 500,
      status: "trial",
    });
    expect(h.state.club).toMatchObject({ billingPlan: "custom", billingPricePence: 500, billingStatus: "trial" });
  });

  it("Custom back to Standard clears the price", async () => {
    setClub({ billingPlan: "custom", billingPricePence: 500 });
    await setClubPlan("org1", { plan: "standard", pricePence: null }, NOW);
    expect(h.state.club).toMatchObject({ billingPlan: "standard", billingPricePence: null });
  });

  it("Sutton FC's shape (approvedAt NULL) is refused and nothing is written", async () => {
    setClub({ approvedAt: null, billingStatus: "exempt", billing: null });
    expect(await setClubPlan("org1", { plan: "free", pricePence: null }, NOW)).toEqual({ ok: false, reason: "not-self-join" });
    expect(m.organisation.update).not.toHaveBeenCalled();
    expect(m.organisation.updateMany).not.toHaveBeenCalled();
  });

  it("an unknown club is not-found", async () => {
    h.state.club = null;
    expect(await setClubPlan("org1", { plan: "standard", pricePence: null }, NOW)).toEqual({ ok: false, reason: "not-found" });
  });

  it("all or nothing: a failing plan write leaves the status as it was", async () => {
    m.organisation.update.mockRejectedValueOnce(new Error("boom"));
    await expect(setClubPlan("org1", { plan: "free", pricePence: null }, NOW)).rejects.toThrow("boom");
    expect(h.state.club?.billingStatus).toBe("trial");
  });

  it("works with the flag off too (it only ever makes a club less billed)", async () => {
    delete process.env.BILLING_ENABLED;
    expect(await setClubPlan("org1", { plan: "free", pricePence: null }, NOW)).toMatchObject({ ok: true, status: "exempt" });
  });
});

describe("startTrial: Start free month (8.3, decision 2)", () => {
  it("an exempt self-join club with no free month yet starts one from now", async () => {
    setClub({ billingStatus: "exempt", billing: null });
    const r = await startTrial("org1", NOW);
    expect(r).toEqual({ ok: true, trialEndsAt: new Date(NOW.getTime() + 30 * DAY) });
    expect(h.state.club?.billingStatus).toBe("trial");
    expect(m.clubBilling.create).toHaveBeenCalledWith({ data: expect.objectContaining({ orgId: "org1", trialStartedAt: NOW }) });
  });

  it("refusals, each with its reason, writing nothing", async () => {
    const cases: Array<[Partial<Club>, string, boolean?]> = [
      [{ billingStatus: "trial" }, "not-exempt"],
      [{ billingStatus: "exempt" }, "had-free-month"],
      [{ billingStatus: "exempt", billing: null, billingPlan: "free" }, "plan-free"],
      [{ billingStatus: "exempt", billing: null, approvedAt: null }, "not-self-join"],
      [{ billingStatus: "exempt", billing: null }, "flag-off", true],
    ];
    for (const [over, reason, flagOff] of cases) {
      vi.clearAllMocks();
      setClub(over);
      if (flagOff) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = "1";
      expect(await startTrial("org1", NOW)).toEqual({ ok: false, reason });
      expect(m.organisation.updateMany).not.toHaveBeenCalled();
      expect(m.clubBilling.create).not.toHaveBeenCalled();
    }
  });
});

// ── The billing page's guard ────────────────────────────────────────────

type Member = { userId: string; role: string; leftAt: Date | null; user: { phoneNumber: string | null; name: string | null } };

function world(opts: {
  status?: string;
  paymentHolderId?: string | null;
  members: Member[];
  cardHolderUserId?: string | null;
  superadmins?: string[];
}) {
  m.organisation.findUnique.mockResolvedValue({
    id: "org1",
    name: "Riverside FC",
    language: "en",
    billingStatus: opts.status ?? "trial",
    billingPlan: "standard",
    billingPricePence: null,
    paymentHolderId: opts.paymentHolderId ?? null,
    memberships: opts.members,
    clubBilling:
      opts.status === "exempt"
        ? null
        : {
            trialEndsAt: new Date(APPROVED_AT.getTime() + 30 * DAY),
            graceEndsAt: null,
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
            cardBrand: null,
            cardLast4: null,
            cardHolderUserId: opts.cardHolderUserId ?? null,
          },
  });
  m.user.findUnique.mockImplementation(async (a: { where: { id: string } }) => ({
    isSuperadmin: (opts.superadmins ?? []).includes(a.where.id),
    name: a.where.id,
  }));
}

const OWNER: Member = { userId: "owner", role: "OWNER", leftAt: null, user: { phoneNumber: "+447700900001", name: "Olly Owner" } };
const ADMIN: Member = { userId: "admin", role: "ADMIN", leftAt: null, user: { phoneNumber: "+447700900002", name: "Ada Admin" } };
const COLLECTOR: Member = { userId: "colin", role: "PLAYER", leftAt: null, user: { phoneNumber: "+447700900003", name: "Colin" } };
const PLAYER: Member = { userId: "pat", role: "PLAYER", leftAt: null, user: { phoneNumber: "+447700900004", name: "Pat" } };
const OLD_HOLDER: Member = { userId: "elvin", role: "PLAYER", leftAt: null, user: { phoneNumber: "+447700900005", name: "Elvin" } };
const FORMER: Member = { userId: "gone", role: "ADMIN", leftAt: new Date("2026-09-01"), user: { phoneNumber: "+447700900006", name: "Gone" } };
const ALL = [OWNER, ADMIN, COLLECTOR, PLAYER, OLD_HOLDER, FORMER];

describe("requireClubBillingAccess: the access matrix (4.5)", () => {
  it("the money collector who is a PLAYER is the contact", async () => {
    world({ paymentHolderId: "colin", members: ALL });
    expect((await requireClubBillingAccess("colin", "org1")).role).toBe("contact");
  });

  it("no collector: the owner is the contact", async () => {
    world({ members: ALL });
    expect((await requireClubBillingAccess("owner", "org1")).role).toBe("contact");
  });

  it("with a collector, the owner reads only", async () => {
    world({ paymentHolderId: "colin", members: ALL });
    expect((await requireClubBillingAccess("owner", "org1")).role).toBe("viewer");
    expect((await requireClubBillingAccess("admin", "org1")).role).toBe("viewer");
  });

  it("an old card holder gets the remove-my-card view", async () => {
    world({ paymentHolderId: "colin", members: ALL, cardHolderUserId: "elvin", status: "subscribed" });
    expect((await requireClubBillingAccess("elvin", "org1")).role).toBe("card-holder");
  });

  it("the platform superadmin who is not a member reads only", async () => {
    world({ paymentHolderId: "colin", members: ALL, superadmins: ["kemal"] });
    expect((await requireClubBillingAccess("kemal", "org1")).role).toBe("viewer");
  });

  it("refused: a plain player, a non-member, a former admin", async () => {
    world({ paymentHolderId: "colin", members: ALL });
    for (const who of ["pat", "stranger", "gone"]) {
      await expect(requireClubBillingAccess(who, "org1")).rejects.toBeInstanceOf(BillingAccessDenied);
    }
  });

  it("a collector who LEFT the club is no longer the contact: the owner is, and the old collector is refused", async () => {
    world({ paymentHolderId: "gone", members: ALL });
    expect((await requireClubBillingAccess("owner", "org1")).role).toBe("contact");
    await expect(requireClubBillingAccess("gone", "org1")).rejects.toBeInstanceOf(BillingAccessDenied);
  });

  it("an unknown club is refused", async () => {
    m.organisation.findUnique.mockResolvedValue(null);
    await expect(requireClubBillingAccess("owner", "nope")).rejects.toBeInstanceOf(BillingAccessDenied);
  });

  it("an exempt club: nobody may act on billing, the owner included (only the page's exempt label)", async () => {
    world({ status: "exempt", paymentHolderId: "colin", members: ALL });
    for (const who of ["owner", "colin", "admin"]) {
      await expect(requireClubBillingAccess(who, "org1")).rejects.toBeInstanceOf(BillingAccessDenied);
    }
    expect((await loadBillingAccess("owner", "org1"))?.role).toBe("exempt-owner");
    expect(await loadBillingAccess("colin", "org1")).toBeNull();
  });

  it("flag off: everyone refused, the contact included", async () => {
    delete process.env.BILLING_ENABLED;
    world({ paymentHolderId: "colin", members: ALL });
    await expect(requireClubBillingAccess("colin", "org1")).rejects.toBeInstanceOf(BillingAccessDenied);
    expect(await loadBillingAccess("owner", "org1")).toBeNull();
  });

  it("the web's flag can be passed explicitly (the test cookie seam)", async () => {
    delete process.env.BILLING_ENABLED;
    world({ paymentHolderId: "colin", members: ALL });
    expect((await loadBillingAccess("colin", "org1", { flagOn: true }))?.role).toBe("contact");
  });
});

describe("loadClubFeeTip", () => {
  it("reads the active weekly games, their sport and the latest match fee", async () => {
    m.organisation.findUnique.mockResolvedValue({
      billingStatus: "trial",
      billingPlan: "standard",
      billingPricePence: null,
      sports: [{ playersPerTeam: 7 }],
      activities: [
        { dayOfWeek: 2, time: "20:00", feePerPlayer: null, feeSplitTotal: false, sport: { playersPerTeam: 7 }, matches: [{ feePerPlayer: 7 }] },
      ],
    });
    expect(await loadClubFeeTip("org1")).toMatchObject({ players: 14, sharePence: 20, feePence: 700, feeSource: "latest-match" });
    const arg = m.organisation.findUnique.mock.calls[0][0];
    expect(arg.select.activities.where).toEqual({ isActive: true });
  });

  it("no tip for an exempt or Free club, or an unknown one", async () => {
    m.organisation.findUnique.mockResolvedValue({
      billingStatus: "exempt",
      billingPlan: "standard",
      billingPricePence: null,
      sports: [],
      activities: [],
    });
    expect(await loadClubFeeTip("org1")).toBeNull();
    m.organisation.findUnique.mockResolvedValue(null);
    expect(await loadClubFeeTip("org1")).toBeNull();
  });
});
