/**
 * CLUB FEE BILLING, slice B1: the one writer (`setBillingState`) and
 * `resumeClub`. Plan: MDs/club-fee-billing-plan-2026-10-01.md, 4.2 and 4.4.
 *
 * db is mocked. No network, no model, nothing messaged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const m = {
    organisation: { findUnique: vi.fn(), updateMany: vi.fn() },
    clubBilling: { create: vi.fn(), updateMany: vi.fn() },
    botJob: { updateMany: vi.fn() },
    match: { findMany: vi.fn(), updateMany: vi.fn() },
    sentNotification: { createMany: vi.fn() },
    platformJob: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  m.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(m));
  return m;
});
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { resumeClub, setBillingState } from "../club-billing";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-15T12:00:00Z");
const APPROVED_AT = new Date("2026-10-01T09:00:00Z");
const TRIAL_ENDS = new Date(APPROVED_AT.getTime() + 30 * DAY);

const ENV = process.env.BILLING_ENABLED;
afterEach(() => {
  if (ENV === undefined) delete process.env.BILLING_ENABLED;
  else process.env.BILLING_ENABLED = ENV;
});

function orgRow(over: Record<string, unknown> = {}) {
  return {
    billingStatus: "trial",
    billingPlan: "standard",
    approvedAt: APPROVED_AT,
    clubBilling: { trialEndsAt: TRIAL_ENDS, graceEndsAt: null, pausedReason: null },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(dbMock));
  dbMock.organisation.updateMany.mockResolvedValue({ count: 1 });
  dbMock.clubBilling.updateMany.mockResolvedValue({ count: 1 });
  dbMock.clubBilling.create.mockResolvedValue({});
  dbMock.botJob.updateMany.mockResolvedValue({ count: 0 });
  dbMock.match.findMany.mockResolvedValue([]);
  dbMock.match.updateMany.mockResolvedValue({ count: 0 });
  dbMock.sentNotification.createMany.mockResolvedValue({ count: 0 });
});

describe("setBillingState: the one writer", () => {
  it("an unknown club is not-found and writes nothing", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(null);
    expect(await setBillingState("nope", { type: "card-added" }, NOW)).toEqual({ ok: false, reason: "not-found" });
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
  });

  it("an event that does not apply is no-change and writes nothing", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(orgRow({ billingStatus: "subscribed" }));
    expect(await setBillingState("org", { type: "trial-ended" }, NOW)).toEqual({ ok: false, reason: "no-change" });
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });

  it("Sutton FC (approvedAt NULL) is never moved, flag on, even by an approval or 'Start free month'", async () => {
    process.env.BILLING_ENABLED = "1";
    dbMock.organisation.findUnique.mockResolvedValue(orgRow({ billingStatus: "exempt", approvedAt: null, clubBilling: null }));
    for (const type of ["approved", "start-trial"] as const) {
      expect(await setBillingState("sutton", { type }, NOW)).toEqual({ ok: false, reason: "no-change" });
    }
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
    expect(dbMock.clubBilling.create).not.toHaveBeenCalled();
  });

  it("Sutton FC (exempt) is never moved, flag on, whatever the event", async () => {
    process.env.BILLING_ENABLED = "1";
    dbMock.organisation.findUnique.mockResolvedValue(orgRow({ billingStatus: "exempt", approvedAt: null, clubBilling: null }));
    for (const type of ["card-added", "trial-ended", "grace-ended", "payment-failed", "removed-from-group"] as const) {
      expect(await setBillingState("sutton", { type }, new Date("2030-01-01"))).toEqual({ ok: false, reason: "no-change" });
    }
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
  });

  it("compare-and-set on the current status", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(orgRow({ billingStatus: "trial" }));
    const r = await setBillingState("org", { type: "card-added" }, NOW);
    expect(r).toEqual({ ok: true, from: "trial", to: "subscribed", resumed: false });
    expect(dbMock.organisation.updateMany).toHaveBeenCalledWith({
      where: { id: "org", billingStatus: "trial" },
      data: { billingStatus: "subscribed" },
    });
  });

  it("a webhook and the cron at once: one wins, the other is 'raced' and writes nothing else", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(orgRow({ billingStatus: "trial" }));
    dbMock.organisation.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const [a, b] = await Promise.all([
      setBillingState("org", { type: "card-added" }, NOW),
      setBillingState("org", { type: "trial-ended" }, NOW),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, reason: "raced" });
    // Only the winner touched the billing row.
    expect(dbMock.clubBilling.updateMany).toHaveBeenCalledTimes(1);
  });

  it("approval with the flag on starts the free month from approvedAt", async () => {
    process.env.BILLING_ENABLED = "1";
    dbMock.organisation.findUnique.mockResolvedValue(orgRow({ billingStatus: "exempt", clubBilling: null }));
    expect(await setBillingState("org", { type: "approved" }, NOW)).toMatchObject({ ok: true, to: "trial" });
    expect(dbMock.clubBilling.create).toHaveBeenCalledWith({
      data: { orgId: "org", trialStartedAt: APPROVED_AT, trialEndsAt: TRIAL_ENDS },
    });
  });

  it("approval with the flag OFF starts nothing", async () => {
    delete process.env.BILLING_ENABLED;
    dbMock.organisation.findUnique.mockResolvedValue(orgRow({ billingStatus: "exempt", clubBilling: null }));
    expect(await setBillingState("org", { type: "approved" }, NOW)).toEqual({ ok: false, reason: "no-change" });
    expect(dbMock.clubBilling.create).not.toHaveBeenCalled();
  });

  it("trialEndsAt is never reset: re-approval of a club that had its month changes nothing", async () => {
    process.env.BILLING_ENABLED = "1";
    dbMock.organisation.findUnique.mockResolvedValue(orgRow({ billingStatus: "exempt" }));
    expect(await setBillingState("org", { type: "approved" }, NOW)).toEqual({ ok: false, reason: "no-change" });
    expect(dbMock.clubBilling.create).not.toHaveBeenCalled();
    for (const s of ["trial", "grace", "subscribed", "paused"]) {
      dbMock.organisation.findUnique.mockResolvedValue(orgRow({ billingStatus: s }));
      expect(await setBillingState("org", { type: "approved" }, NOW)).toEqual({ ok: false, reason: "no-change" });
    }
    // No write ever touches trialEndsAt outside the create.
    for (const call of dbMock.clubBilling.updateMany.mock.calls) expect(call[0].data).not.toHaveProperty("trialEndsAt");
  });

  it("to paused: stamps pausedAt and the reason, never the mute switch", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(
      orgRow({ billingStatus: "grace", clubBilling: { trialEndsAt: TRIAL_ENDS, graceEndsAt: NOW, pausedReason: null } }),
    );
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
    dbMock.organisation.findUnique.mockResolvedValue(orgRow());
    await setBillingState("org", { type: "trial-ended" }, TRIAL_ENDS);
    expect(dbMock.clubBilling.updateMany.mock.calls[0][0].data).toEqual({
      graceEndsAt: new Date(TRIAL_ENDS.getTime() + 7 * DAY),
    });
  });

  it("payment failed stores the failure and seven days of grace; paid clears them", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(orgRow({ billingStatus: "subscribed" }));
    await setBillingState("org", { type: "payment-failed" }, NOW);
    expect(dbMock.clubBilling.updateMany.mock.calls[0][0].data).toEqual({
      graceEndsAt: new Date(NOW.getTime() + 7 * DAY),
      paymentFailedAt: NOW,
    });
    dbMock.organisation.findUnique.mockResolvedValue(orgRow({ billingStatus: "past_due" }));
    await setBillingState("org", { type: "invoice-paid" }, NOW);
    expect(dbMock.clubBilling.updateMany.mock.calls[1][0].data).toEqual({ graceEndsAt: null, paymentFailedAt: null });
  });

  it("out of paused: clears the pause and runs resumeClub", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(
      orgRow({ billingStatus: "paused", clubBilling: { trialEndsAt: TRIAL_ENDS, graceEndsAt: NOW, pausedReason: "no-card" } }),
    );
    expect(await setBillingState("org", { type: "card-added" }, NOW)).toEqual({
      ok: true,
      from: "paused",
      to: "subscribed",
      resumed: true,
    });
    expect(dbMock.clubBilling.updateMany.mock.calls[0][0].data).toEqual({
      pausedAt: null,
      pausedReason: null,
      graceEndsAt: null,
      paymentFailedAt: null,
    });
    // resumeClub ran: resumedAt stamped and stale work dropped.
    expect(dbMock.clubBilling.updateMany).toHaveBeenCalledWith({ where: { orgId: "org" }, data: { resumedAt: NOW } });
    expect(dbMock.botJob.updateMany).toHaveBeenCalled();
  });

  it("nothing in setBillingState or resumeClub messages anyone", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(
      orgRow({ billingStatus: "paused", clubBilling: { trialEndsAt: TRIAL_ENDS, graceEndsAt: NOW, pausedReason: "no-card" } }),
    );
    await setBillingState("org", { type: "card-added" }, NOW);
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });
});

describe("resumeClub (4.4)", () => {
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

  it("completes matches that kicked off during the pause quietly: no post-match flow, no score ask", async () => {
    dbMock.match.findMany.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
    dbMock.match.updateMany.mockResolvedValue({ count: 2 });
    const r = await resumeClub("org", NOW);
    expect(dbMock.match.findMany).toHaveBeenCalledWith({
      where: {
        activity: { orgId: "org" },
        status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
        date: { lte: NOW },
      },
      select: { id: true },
    });
    expect(dbMock.match.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["m1", "m2"] }, status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
      data: { status: "COMPLETED", postMatchEndFlow: false },
    });
    expect(dbMock.sentNotification.createMany).toHaveBeenCalledWith({
      data: [
        { key: "m1:ask-score", kind: "billing-resume-skip", matchId: "m1" },
        { key: "m2:ask-score", kind: "billing-resume-skip", matchId: "m2" },
      ],
      skipDuplicates: true,
    });
    expect(r.quietlyCompletedMatches).toBe(2);
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
