/**
 * THE FREE PERIOD STARTS AT GO-LIVE (owner decision 2, 2026-10-12): the one
 * writer. The pure rules are in free-period-from-go-live.test.ts; the real
 * database and the real go-live transaction are in
 * e2e/helpers/free-period-go-live-lib-tests.ts.
 *
 * db is one in-memory club whose `$transaction` holds a mutex for its
 * whole life, standing in for the row lock, as in club-billing.test.ts.
 *
 * The line that matters: a club's free period is started exactly ONCE,
 * whichever of approval and go-live gets there first, and never while the
 * club is still setting up.
 *
 * No network, no model, nothing messaged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  billingStatus: string;
  billingPlan: string;
  approvalStatus: string;
  setupStage: string;
  approvedAt: Date | null;
  liveAt: Date | null;
  billing: { trialStartedAt: Date; trialEndsAt: Date; graceEndsAt: Date | null; pausedReason: string | null } | null;
};

const h = vi.hoisted(() => {
  const state: { row: Row | null } = { row: null };
  let chain: Promise<void> = Promise.resolve();
  const m = {
    organisation: { findUnique: vi.fn(), updateMany: vi.fn() },
    clubBilling: { create: vi.fn(), updateMany: vi.fn() },
    billingEvent: { create: vi.fn() },
    billingNotice: { createMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = chain;
    let release!: () => void;
    chain = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  return { state, m, withLock };
});
vi.mock("@/lib/db", () => ({ db: h.m }));

import { setBillingState, startFreePeriodAtGoLiveTx, startTrial } from "../club-billing";

const dbMock = h.m;
// Approved Thu 1 Oct 2026, 10:00 London; live Tue 20 Oct 2026, 19:30 London.
const APPROVED = new Date("2026-10-01T09:00:00Z");
const LIVE = new Date("2026-10-20T18:30:00Z");
const FREE_UNTIL = new Date("2027-01-20T19:30:00Z"); // three months on

const ENV = process.env.BILLING_ENABLED;
afterEach(() => {
  if (ENV === undefined) delete process.env.BILLING_ENABLED;
  else process.env.BILLING_ENABLED = ENV;
});

function setRow(over: Partial<Row> = {}) {
  h.state.row = {
    billingStatus: "exempt",
    billingPlan: "standard",
    approvalStatus: "approved",
    setupStage: "live",
    approvedAt: APPROVED,
    liveAt: LIVE,
    billing: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BILLING_ENABLED = "1";
  setRow();
  dbMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    const r = h.state.row;
    if (sql.includes('FROM "Organisation"')) {
      return r ? [{ billingStatus: r.billingStatus, billingPlan: r.billingPlan, approvedAt: r.approvedAt, liveAt: r.liveAt }] : [];
    }
    if (sql.includes('FROM "ClubBilling"')) return r?.billing ? [{ ...r.billing }] : [];
    throw new Error(`unexpected raw SQL: ${sql}`);
  });
  dbMock.organisation.findUnique.mockImplementation(async () =>
    h.state.row
      ? {
          billingStatus: h.state.row.billingStatus,
          billingPlan: h.state.row.billingPlan,
          approvalStatus: h.state.row.approvalStatus,
          setupStage: h.state.row.setupStage,
          approvedAt: h.state.row.approvedAt,
          liveAt: h.state.row.liveAt,
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
  dbMock.clubBilling.create.mockImplementation(async (a: { data: { trialStartedAt: Date; trialEndsAt: Date } }) => {
    if (h.state.row!.billing) throw new Error("ClubBilling already exists (unique orgId)");
    h.state.row!.billing = { trialStartedAt: a.data.trialStartedAt, trialEndsAt: a.data.trialEndsAt, graceEndsAt: null, pausedReason: null };
    return {};
  });
  dbMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => h.withLock(async () => fn(dbMock)));
});

describe("went-live: a held club's free period starts at go-live", () => {
  it("approved 1 October, live 20 October: free from 20 October until 20 January (London)", async () => {
    expect(await setBillingState("org", { type: "went-live" }, LIVE)).toEqual({ ok: true, from: "exempt", to: "trial", resumed: false });
    expect(dbMock.clubBilling.create).toHaveBeenCalledTimes(1);
    expect(dbMock.clubBilling.create).toHaveBeenCalledWith({ data: { orgId: "org", trialStartedAt: LIVE, trialEndsAt: FREE_UNTIL } });
  });

  it("the start is the stored go-live moment, not the clock of whoever applies the event", async () => {
    await setBillingState("org", { type: "went-live" }, new Date(LIVE.getTime() + 90_000));
    expect(dbMock.clubBilling.create).toHaveBeenCalledWith({ data: { orgId: "org", trialStartedAt: LIVE, trialEndsAt: FREE_UNTIL } });
  });

  it("decided under the club's row lock, like every billing event", async () => {
    await setBillingState("org", { type: "went-live" }, LIVE);
    const sqls = dbMock.$queryRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?"));
    // The club: FOR NO KEY UPDATE (never FOR UPDATE: see club-setup.ts, the lock order).
    expect(sqls.some((s) => s.includes('FROM "Organisation"') && /FOR NO KEY UPDATE/.test(s))).toBe(true);
    expect(sqls.some((s) => s.includes('FROM "Organisation"') && /FOR UPDATE/.test(s))).toBe(false);
    expect(sqls.some((s) => s.includes('FROM "ClubBilling"') && /FOR UPDATE/.test(s))).toBe(true);
  });

  it("flag off, plan Free, or a club with no go-live stamp: nothing starts, nothing is written", async () => {
    delete process.env.BILLING_ENABLED;
    expect(await setBillingState("org", { type: "went-live" }, LIVE)).toEqual({ ok: false, reason: "no-change" });
    process.env.BILLING_ENABLED = "1";
    setRow({ billingPlan: "free" });
    expect(await setBillingState("org", { type: "went-live" }, LIVE)).toEqual({ ok: false, reason: "no-change" });
    setRow({ liveAt: null });
    expect(await setBillingState("org", { type: "went-live" }, LIVE)).toEqual({ ok: false, reason: "no-change" });
    expect(dbMock.clubBilling.create).not.toHaveBeenCalled();
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
  });
});

describe("started exactly once", () => {
  it("a second start is a no-op, whichever event tries, and the end date is never moved", async () => {
    await setBillingState("org", { type: "went-live" }, LIVE);
    const later = new Date(LIVE.getTime() + 5 * 24 * 60 * 60 * 1000);
    for (const type of ["went-live", "approved", "start-trial"] as const) {
      expect(await setBillingState("org", { type }, later), type).toEqual({ ok: false, reason: "no-change" });
    }
    expect(dbMock.clubBilling.create).toHaveBeenCalledTimes(1);
    expect(h.state.row?.billing).toMatchObject({ trialStartedAt: LIVE, trialEndsAt: FREE_UNTIL });
  });

  it("approval and go-live at the same instant: one free period, from go-live, whichever is applied first", async () => {
    const [a, b] = await Promise.all([
      setBillingState("org", { type: "approved" }, LIVE),
      setBillingState("org", { type: "went-live" }, LIVE),
    ]);
    // The club has a go-live stamp, so only its go-live may start it.
    expect(a).toEqual({ ok: false, reason: "no-change" });
    expect(b).toMatchObject({ ok: true, to: "trial" });
    expect(dbMock.clubBilling.create).toHaveBeenCalledTimes(1);
    expect(h.state.row?.billing).toMatchObject({ trialStartedAt: LIVE, trialEndsAt: FREE_UNTIL });
  });

  it("the latent trap: a late approval event for a club that went live long ago with no free period starts nothing", async () => {
    const muchLater = new Date("2027-03-01T12:00:00Z");
    expect(await setBillingState("org", { type: "approved" }, muchLater)).toEqual({ ok: false, reason: "no-change" });
    expect(dbMock.clubBilling.create).not.toHaveBeenCalled();
    expect(h.state.row?.billingStatus).toBe("exempt");
  });

  it("the billing move is logged only once the transaction has committed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      let committed = false;
      dbMock.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => {
        const r = await fn(dbMock);
        expect(log.mock.calls.filter((c) => String(c[0]).includes("-> trial"))).toEqual([]);
        committed = true;
        return r;
      });
      await setBillingState("org", { type: "went-live" }, LIVE);
      expect(committed).toBe(true);
      expect(log.mock.calls.some((c) => String(c[0]).includes("exempt -> trial on went-live"))).toBe(true);
      // On the caller's own transaction nothing is logged here at all: the
      // caller logs after ITS commit.
      log.mockClear();
      setRow();
      await startFreePeriodAtGoLiveTx(dbMock as never, "org", LIVE);
      expect(log.mock.calls.filter((c) => String(c[0]).includes("-> trial"))).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it("approval got there first for a club that was never held: go-live adds nothing", async () => {
    setRow({ liveAt: null });
    expect(await setBillingState("org", { type: "approved" }, APPROVED)).toMatchObject({ ok: true, to: "trial" });
    h.state.row!.liveAt = LIVE; // cannot happen for a never-held club; the writer must not care
    expect(await setBillingState("org", { type: "went-live" }, LIVE)).toEqual({ ok: false, reason: "no-change" });
    expect(dbMock.clubBilling.create).toHaveBeenCalledTimes(1);
    expect(h.state.row?.billing?.trialStartedAt).toEqual(APPROVED);
  });
});

describe("a club that is still setting up has no free period", () => {
  beforeEach(() => setRow({ setupStage: "setting-up", liveAt: null }));

  it("the approval's own call starts nothing (true before and after the held approval stops making it)", async () => {
    expect(await setBillingState("org", { type: "approved" }, APPROVED)).toEqual({ ok: false, reason: "no-change" });
    expect(dbMock.clubBilling.create).not.toHaveBeenCalled();
    expect(h.state.row?.billingStatus).toBe("exempt");
  });

  it("the owner's Start free period is refused, with the reason", async () => {
    expect(await startTrial("org", new Date("2026-10-05T12:00:00Z"))).toEqual({ ok: false, reason: "setting-up" });
    expect(await setBillingState("org", { type: "start-trial" }, new Date("2026-10-05T12:00:00Z"))).toEqual({ ok: false, reason: "no-change" });
    expect(dbMock.clubBilling.create).not.toHaveBeenCalled();
  });

  it("a removal from its group pauses nothing, even if it somehow had a billing row", async () => {
    h.state.row!.billingStatus = "trial";
    h.state.row!.billing = { trialStartedAt: APPROVED, trialEndsAt: new Date("2026-12-01T10:00:00Z"), graceEndsAt: null, pausedReason: null };
    expect(await setBillingState("org", { type: "removed-from-group" }, new Date("2026-10-05T12:00:00Z"))).toEqual({ ok: false, reason: "no-change" });
    expect(h.state.row?.billingStatus).toBe("trial");
    expect(dbMock.billingEvent.create).not.toHaveBeenCalled();
  });

  it("then it goes live, and the approval that never started one is not missed: free from go-live", async () => {
    await setBillingState("org", { type: "approved" }, APPROVED);
    h.state.row!.setupStage = "live";
    h.state.row!.liveAt = LIVE;
    expect(await setBillingState("org", { type: "went-live" }, LIVE)).toMatchObject({ ok: true, to: "trial" });
    expect(h.state.row?.billing).toMatchObject({ trialStartedAt: LIVE, trialEndsAt: FREE_UNTIL });
  });
});

describe("a club that was never held keeps today's dates exactly", () => {
  it("approved 1 October with no go-live stamp: free from the approval until 1 January", async () => {
    setRow({ liveAt: null });
    expect(await setBillingState("org", { type: "approved" }, new Date("2026-10-01T09:00:02Z"))).toMatchObject({ ok: true, to: "trial" });
    expect(dbMock.clubBilling.create).toHaveBeenCalledWith({
      data: { orgId: "org", trialStartedAt: APPROVED, trialEndsAt: new Date("2027-01-01T10:00:00Z") },
    });
  });

  it("the owner's Start free period still starts NOW, held or not", async () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const r = await startTrial("org", now);
    expect(r).toEqual({ ok: true, trialEndsAt: new Date("2027-02-03T12:00:00Z") });
    expect(dbMock.clubBilling.create).toHaveBeenCalledWith({ data: { orgId: "org", trialStartedAt: now, trialEndsAt: new Date("2027-02-03T12:00:00Z") } });
  });
});

describe("startFreePeriodAtGoLiveTx: the go-live transaction's one call", () => {
  it("starts the free period on the caller's transaction client and says so", async () => {
    expect(await startFreePeriodAtGoLiveTx(dbMock as never, "org", LIVE)).toEqual({ started: true });
    // No transaction of its own: it is part of the caller's.
    expect(dbMock.$transaction).not.toHaveBeenCalled();
    expect(h.state.row?.billingStatus).toBe("trial");
  });

  it("nothing to start (already started, flag off, plan Free) is not an error: the club still goes live", async () => {
    await startFreePeriodAtGoLiveTx(dbMock as never, "org", LIVE);
    expect(await startFreePeriodAtGoLiveTx(dbMock as never, "org", LIVE)).toEqual({ started: false });
    delete process.env.BILLING_ENABLED;
    setRow();
    expect(await startFreePeriodAtGoLiveTx(dbMock as never, "org", LIVE)).toEqual({ started: false });
  });

  it("a club that is not there, or a write that lost its compare-and-set, THROWS: the go-live rolls back with it", async () => {
    h.state.row = null;
    await expect(startFreePeriodAtGoLiveTx(dbMock as never, "gone", LIVE)).rejects.toThrow(/free period/);
    setRow();
    dbMock.organisation.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(startFreePeriodAtGoLiveTx(dbMock as never, "org", LIVE)).rejects.toThrow(/free period/);
  });

  it("a database error is thrown as it is", async () => {
    dbMock.clubBilling.create.mockRejectedValueOnce(new Error("connection lost"));
    await expect(startFreePeriodAtGoLiveTx(dbMock as never, "org", LIVE)).rejects.toThrow("connection lost");
  });
});
