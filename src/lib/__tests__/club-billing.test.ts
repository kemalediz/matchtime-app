/**
 * CLUB FEE BILLING, slice B1: the one writer (`setBillingState`) and
 * `resumeClub`. Plan: MDs/club-fee-billing-plan-2026-10-01.md, 4.2 and 4.4.
 *
 * db is mocked with a small in-memory "database" whose `$transaction`
 * holds a mutex for its whole life, standing in for Postgres's row lock
 * (`SELECT ... FOR UPDATE`): a second transaction on the same club waits
 * until the first commits, then reads what it wrote. Reads made OUTSIDE a
 * transaction (`db.organisation.findUnique`) do not wait, which is exactly
 * the race the review found.
 *
 * No network, no model, nothing messaged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  billingStatus: string;
  billingPlan: string;
  approvedAt: Date | null;
  billing: { trialEndsAt: Date; graceEndsAt: Date | null; pausedReason: string | null } | null;
};

const h = vi.hoisted(() => {
  const state: { row: Row | null; lockHeld: Promise<void> | null } = { row: null, lockHeld: null };
  let chain: Promise<void> = Promise.resolve();
  const m = {
    organisation: { findUnique: vi.fn(), updateMany: vi.fn() },
    clubBilling: { create: vi.fn(), updateMany: vi.fn() },
    botJob: { updateMany: vi.fn() },
    match: { findMany: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    sentNotification: { createMany: vi.fn() },
    organiserPickRound: { updateMany: vi.fn() },
    benchSlotOffer: { updateMany: vi.fn() },
    platformJob: { create: vi.fn() },
    billingNotice: { createMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  /** Run `fn` holding the club's "row lock" (a FIFO mutex). */
  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = chain;
    let release!: () => void;
    chain = new Promise<void>((r) => (release = r));
    await prev;
    if (state.lockHeld) await state.lockHeld;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  return { state, m, withLock };
});
vi.mock("@/lib/db", () => ({ db: h.m }));

import { isMatchClubBillingPaused, resumeClub, setBillingState } from "../club-billing";

const dbMock = h.m;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-15T12:00:00Z");
const APPROVED_AT = new Date("2026-10-01T09:00:00Z");
const TRIAL_ENDS = new Date(APPROVED_AT.getTime() + 30 * DAY);

const ENV = process.env.BILLING_ENABLED;
afterEach(() => {
  if (ENV === undefined) delete process.env.BILLING_ENABLED;
  else process.env.BILLING_ENABLED = ENV;
});

function setRow(over: Partial<Row> = {}) {
  h.state.row = {
    billingStatus: "trial",
    billingPlan: "standard",
    approvedAt: APPROVED_AT,
    billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: null, pausedReason: null },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.lockHeld = null;
  setRow();
  const sqlOf = (strings: TemplateStringsArray) => strings.join("?");
  dbMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = sqlOf(strings);
    const r = h.state.row;
    if (sql.includes('FROM "Organisation"')) {
      return r ? [{ billingStatus: r.billingStatus, billingPlan: r.billingPlan, approvedAt: r.approvedAt }] : [];
    }
    if (sql.includes('FROM "ClubBilling"')) return r?.billing ? [{ ...r.billing }] : [];
    throw new Error(`unexpected raw SQL: ${sql}`);
  });
  // Reads outside a transaction see the current state without waiting.
  dbMock.organisation.findUnique.mockImplementation(async () =>
    h.state.row
      ? {
          billingStatus: h.state.row.billingStatus,
          billingPlan: h.state.row.billingPlan,
          approvedAt: h.state.row.approvedAt,
          clubBilling: h.state.row.billing,
        }
      : null,
  );
  dbMock.organisation.updateMany.mockImplementation(
    async (a: { where: { billingStatus: string }; data: { billingStatus: string } }) => {
      if (!h.state.row || h.state.row.billingStatus !== a.where.billingStatus) return { count: 0 };
      h.state.row.billingStatus = a.data.billingStatus;
      return { count: 1 };
    },
  );
  dbMock.clubBilling.updateMany.mockImplementation(async (a: { data: Record<string, unknown> }) => {
    const b = h.state.row?.billing;
    if (b) {
      if ("graceEndsAt" in a.data) b.graceEndsAt = a.data.graceEndsAt as Date | null;
      if ("pausedReason" in a.data) b.pausedReason = a.data.pausedReason as string | null;
    }
    return { count: 1 };
  });
  dbMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => h.withLock(async () => fn(dbMock)));
  dbMock.clubBilling.create.mockResolvedValue({});
  dbMock.botJob.updateMany.mockResolvedValue({ count: 0 });
  dbMock.match.findMany.mockResolvedValue([]);
  dbMock.match.updateMany.mockResolvedValue({ count: 0 });
  dbMock.sentNotification.createMany.mockResolvedValue({ count: 0 });
  dbMock.organiserPickRound.updateMany.mockResolvedValue({ count: 0 });
  dbMock.benchSlotOffer.updateMany.mockResolvedValue({ count: 0 });
});

describe("setBillingState: the one writer", () => {
  it("an unknown club is not-found and writes nothing", async () => {
    h.state.row = null;
    expect(await setBillingState("nope", { type: "card-added" }, NOW)).toEqual({ ok: false, reason: "not-found" });
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
  });

  it("reads the club INSIDE the transaction, under a row lock on Organisation and ClubBilling", async () => {
    await setBillingState("org", { type: "card-added" }, NOW);
    expect(dbMock.organisation.findUnique).not.toHaveBeenCalled();
    const sqls = dbMock.$queryRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?"));
    expect(sqls.some((s) => s.includes('FROM "Organisation"') && /FOR UPDATE/.test(s))).toBe(true);
    expect(sqls.some((s) => s.includes('FROM "ClubBilling"') && /FOR UPDATE/.test(s))).toBe(true);
  });

  it("an event that does not apply is no-change and writes nothing", async () => {
    setRow({ billingStatus: "subscribed" });
    expect(await setBillingState("org", { type: "trial-ended" }, NOW)).toEqual({ ok: false, reason: "no-change" });
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
  });

  it("Sutton FC (approvedAt NULL) is never moved, flag on, even by an approval or 'Start free month'", async () => {
    process.env.BILLING_ENABLED = "1";
    setRow({ billingStatus: "exempt", approvedAt: null, billing: null });
    for (const type of ["approved", "start-trial", "card-added", "removed-from-group"] as const) {
      expect(await setBillingState("sutton", { type }, new Date("2030-01-01"))).toEqual({ ok: false, reason: "no-change" });
    }
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
    expect(dbMock.clubBilling.create).not.toHaveBeenCalled();
  });

  it("compare-and-set on the current status", async () => {
    const r = await setBillingState("org", { type: "card-added" }, NOW);
    expect(r).toEqual({ ok: true, from: "trial", to: "subscribed", resumed: false });
    expect(dbMock.organisation.updateMany).toHaveBeenCalledWith({
      where: { id: "org", billingStatus: "trial" },
      data: { billingStatus: "subscribed" },
    });
  });

  it("a webhook and the cron at once: the second waits for the first, then re-decides on fresh state", async () => {
    // card-added and trial-ended race on a club in trial past its end.
    const [a, b] = await Promise.all([
      setBillingState("org", { type: "card-added" }, NOW),
      setBillingState("org", { type: "trial-ended" }, NOW),
    ]);
    expect(a).toEqual({ ok: true, from: "trial", to: "subscribed", resumed: false });
    // The cron saw "subscribed" (not the stale "trial"), so it did nothing.
    expect(b).toEqual({ ok: false, reason: "no-change" });
    expect(h.state.row?.billingStatus).toBe("subscribed");
  });

  it("past_due -> subscribed -> past_due interleave: a grace-ended decided on the OLD grace end never pauses", async () => {
    const oldGrace = new Date(NOW.getTime() - DAY);
    setRow({ billingStatus: "past_due", billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: oldGrace, pausedReason: null } });
    // Another transaction holds the club while the cron's grace-ended arrives.
    let releaseOthers!: () => void;
    h.state.lockHeld = new Promise<void>((r) => (releaseOthers = r));
    const cron = setBillingState("org", { type: "grace-ended" }, NOW);
    await new Promise((r) => setTimeout(r, 5));
    // Meanwhile: invoice.paid (past_due -> subscribed), then a new
    // invoice.payment_failed (subscribed -> past_due, a NEW grace end).
    h.state.row!.billingStatus = "subscribed";
    h.state.row!.billing!.graceEndsAt = null;
    h.state.row!.billingStatus = "past_due";
    h.state.row!.billing!.graceEndsAt = new Date(NOW.getTime() + 7 * DAY);
    releaseOthers();
    expect(await cron).toEqual({ ok: false, reason: "no-change" });
    expect(h.state.row?.billingStatus).toBe("past_due");
  });

  it("approval with the flag on starts the free month from approvedAt", async () => {
    process.env.BILLING_ENABLED = "1";
    setRow({ billingStatus: "exempt", billing: null });
    expect(await setBillingState("org", { type: "approved" }, NOW)).toMatchObject({ ok: true, to: "trial" });
    expect(dbMock.clubBilling.create).toHaveBeenCalledWith({
      data: { orgId: "org", trialStartedAt: APPROVED_AT, trialEndsAt: TRIAL_ENDS },
    });
  });

  it("approval with the flag OFF starts nothing", async () => {
    delete process.env.BILLING_ENABLED;
    setRow({ billingStatus: "exempt", billing: null });
    expect(await setBillingState("org", { type: "approved" }, NOW)).toEqual({ ok: false, reason: "no-change" });
    expect(dbMock.clubBilling.create).not.toHaveBeenCalled();
  });

  it("trialEndsAt is never reset: re-approval of a club that had its month changes nothing", async () => {
    process.env.BILLING_ENABLED = "1";
    setRow({ billingStatus: "exempt" });
    expect(await setBillingState("org", { type: "approved" }, NOW)).toEqual({ ok: false, reason: "no-change" });
    for (const s of ["trial", "grace", "subscribed", "paused"]) {
      setRow({ billingStatus: s });
      expect(await setBillingState("org", { type: "approved" }, NOW)).toEqual({ ok: false, reason: "no-change" });
    }
    expect(dbMock.clubBilling.create).not.toHaveBeenCalled();
  });

  it("to paused: stamps pausedAt and the reason, never the mute switch", async () => {
    setRow({ billingStatus: "grace", billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: NOW, pausedReason: null } });
    expect(await setBillingState("org", { type: "grace-ended" }, NOW)).toMatchObject({ ok: true, to: "paused" });
    expect(dbMock.clubBilling.updateMany).toHaveBeenCalledWith({
      where: { orgId: "org" },
      data: { pausedAt: NOW, pausedReason: "no-card" },
    });
    for (const call of dbMock.organisation.updateMany.mock.calls) {
      expect(call[0].data).not.toHaveProperty("whatsappBotEnabled");
    }
  });

  it("trial to grace stores the grace end", async () => {
    await setBillingState("org", { type: "trial-ended" }, TRIAL_ENDS);
    expect(dbMock.clubBilling.updateMany.mock.calls[0][0].data).toEqual({
      graceEndsAt: new Date(TRIAL_ENDS.getTime() + 7 * DAY),
    });
  });

  it("payment failed stores the failure and seven days of grace; paid clears them", async () => {
    setRow({ billingStatus: "subscribed" });
    await setBillingState("org", { type: "payment-failed" }, NOW);
    expect(dbMock.clubBilling.updateMany.mock.calls[0][0].data).toEqual({
      graceEndsAt: new Date(NOW.getTime() + 7 * DAY),
      paymentFailedAt: NOW,
    });
    await setBillingState("org", { type: "invoice-paid" }, NOW);
    expect(dbMock.clubBilling.updateMany.mock.calls[1][0].data).toEqual({ graceEndsAt: null, paymentFailedAt: null });
  });

  it("out of paused: the status change and the whole resume happen in ONE transaction", async () => {
    setRow({ billingStatus: "paused", billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: NOW, pausedReason: "no-card" } });
    expect(await setBillingState("org", { type: "card-added" }, NOW)).toEqual({
      ok: true,
      from: "paused",
      to: "subscribed",
      resumed: true,
    });
    expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
    expect(dbMock.clubBilling.updateMany).toHaveBeenCalledWith({ where: { orgId: "org" }, data: { resumedAt: NOW } });
    expect(dbMock.botJob.updateMany).toHaveBeenCalled();
  });

  it("all or nothing: if the resume work throws, the status change is not reported and the error surfaces", async () => {
    setRow({ billingStatus: "paused", billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: NOW, pausedReason: "no-card" } });
    dbMock.botJob.updateMany.mockRejectedValueOnce(new Error("db down"));
    // The mock cannot roll back, but the real transaction does: what
    // matters is that the failure propagates out of the SAME transaction
    // callback (so Postgres rolls the status back) and is not swallowed.
    await expect(setBillingState("org", { type: "card-added" }, NOW)).rejects.toThrow("db down");
    expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it("review fix 10: noticeOnResume writes a PENDING notice in the SAME transaction as the resume", async () => {
    setRow({ billingStatus: "paused", billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: NOW, pausedReason: "payment-failed" } });
    await setBillingState("org", { type: "invoice-paid" }, NOW, { noticeOnResume: "resumed" });
    expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
    expect(dbMock.billingNotice.createMany).toHaveBeenCalledWith({
      data: [{ orgId: "org", kind: "resumed", cycleKey: NOW.toISOString() }],
      skipDuplicates: true,
    });
  });

  it("no resume, no pending notice", async () => {
    setRow({ billingStatus: "past_due", billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: NOW, pausedReason: null } });
    await setBillingState("org", { type: "invoice-paid" }, NOW, { noticeOnResume: "resumed" });
    expect(dbMock.billingNotice.createMany).not.toHaveBeenCalled();
  });

  it("nothing in setBillingState or resumeClub messages anyone", async () => {
    setRow({ billingStatus: "paused", billing: { trialEndsAt: TRIAL_ENDS, graceEndsAt: NOW, pausedReason: "no-card" } });
    await setBillingState("org", { type: "card-added" }, NOW);
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });
});

describe("resumeClub (4.4)", () => {
  it("runs in one transaction", async () => {
    await resumeClub("org", NOW);
    expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it("drops stale BotJobs (due now, created before the resume) and keeps future reminders", async () => {
    dbMock.botJob.updateMany.mockResolvedValue({ count: 2 });
    const r = await resumeClub("org", NOW);
    expect(dbMock.botJob.updateMany).toHaveBeenCalledWith({
      where: {
        orgId: "org",
        sentAt: null,
        createdAt: { lt: NOW },
        OR: [{ sendAfter: null }, { sendAfter: { lte: NOW } }],
      },
      data: { sentAt: NOW },
    });
    expect(r.droppedJobs).toBe(2);
  });

  it("quiets every match that kicked off before the resume: open ones completed, recent completed ones too", async () => {
    dbMock.match.findMany.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
    dbMock.match.updateMany.mockResolvedValue({ count: 2 });
    const r = await resumeClub("org", NOW);
    expect(dbMock.match.findMany).toHaveBeenCalledWith({
      where: {
        activity: { orgId: "org" },
        date: { lte: NOW },
        OR: [
          { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
          { status: "COMPLETED", postMatchEndFlow: true, date: { gte: new Date(NOW.getTime() - 10 * DAY) } },
        ],
      },
      select: { id: true },
    });
    expect(dbMock.match.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["m1", "m2"] }, status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED", "COMPLETED"] } },
      data: { status: "COMPLETED", postMatchEndFlow: false },
    });
    expect(dbMock.sentNotification.createMany).toHaveBeenCalledWith({
      data: [
        { key: "m1:ask-score", kind: "billing-resume-skip", matchId: "m1" },
        { key: "m2:ask-score", kind: "billing-resume-skip", matchId: "m2" },
      ],
      skipDuplicates: true,
    });
    expect(r.quietedMatches).toBe(2);
  });

  it("closes the pick rounds and bench offers of matches that kicked off, as the kickoff sweep would", async () => {
    await resumeClub("org", NOW);
    expect(dbMock.organiserPickRound.updateMany).toHaveBeenCalledWith({
      where: { orgId: "org", resolvedAt: null, match: { date: { lte: NOW } } },
      data: { resolvedAt: NOW, outcome: "closed-at-kickoff" },
    });
    expect(dbMock.benchSlotOffer.updateMany).toHaveBeenCalledWith({
      where: { resolvedAt: null, match: { activity: { orgId: "org" }, date: { lte: NOW } } },
      data: { resolvedAt: NOW, outcome: "closed-at-kickoff" },
    });
  });

  it("no stale matches: no match writes", async () => {
    await resumeClub("org", NOW);
    expect(dbMock.match.updateMany).not.toHaveBeenCalled();
    expect(dbMock.sentNotification.createMany).not.toHaveBeenCalled();
  });

  it("stamps resumedAt and never touches the mute switch", async () => {
    await resumeClub("org", NOW);
    expect(dbMock.clubBilling.updateMany).toHaveBeenCalledWith({ where: { orgId: "org" }, data: { resumedAt: NOW } });
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
  });
});

describe("isMatchClubBillingPaused (reactions and poll votes)", () => {
  it("flag off: false with no query", async () => {
    delete process.env.BILLING_ENABLED;
    expect(await isMatchClubBillingPaused("m1")).toBe(false);
    expect(dbMock.match.findUnique).not.toHaveBeenCalled();
  });
  it("flag on: true only for a paused club's match", async () => {
    process.env.BILLING_ENABLED = "1";
    dbMock.match.findUnique.mockResolvedValueOnce({ activity: { org: { billingStatus: "paused" } } });
    expect(await isMatchClubBillingPaused("m1")).toBe(true);
    dbMock.match.findUnique.mockResolvedValueOnce({ activity: { org: { billingStatus: "exempt" } } });
    expect(await isMatchClubBillingPaused("m2")).toBe(false);
    dbMock.match.findUnique.mockResolvedValueOnce(null);
    expect(await isMatchClubBillingPaused("gone")).toBe(false);
  });
});
