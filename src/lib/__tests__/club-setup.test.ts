/**
 * "Approved but setting up" (go-live plan 2.2, slice S1): the database
 * half. db is mocked. No network, no model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  membership: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { closeUnfinishedSetupLearning, settingUpClubsReason } from "../club-setup";

const live = { org: { approvalStatus: "approved", setupStage: "live" } };
const held = { org: { approvalStatus: "approved", setupStage: "setting-up" } };

beforeEach(() => vi.clearAllMocks());

describe("settingUpClubsReason: the dm-reply rail", () => {
  const ENV = process.env.BILLING_ENABLED;
  afterEach(() => {
    if (ENV === undefined) delete process.env.BILLING_ENABLED;
    else process.env.BILLING_ENABLED = ENV;
  });

  it("a member of a live club (every existing club) is not caught", async () => {
    dbMock.membership.findMany.mockResolvedValue([live]);
    expect(await settingUpClubsReason("u-pat")).toBeNull();
  });

  it("a sender with no served club at all is not caught (that is the approval rail's)", async () => {
    dbMock.membership.findMany.mockResolvedValue([]);
    expect(await settingUpClubsReason("u-nobody")).toBeNull();
  });

  it("a sender whose only served club is setting up is caught", async () => {
    dbMock.membership.findMany.mockResolvedValue([held]);
    expect(await settingUpClubsReason("u-hana")).toBe("club-setting-up");
  });

  it("a sender in a live club AND a setting-up one is not caught", async () => {
    dbMock.membership.findMany.mockResolvedValue([held, live]);
    expect(await settingUpClubsReason("u-bo")).toBeNull();
  });

  it("review fix 2: asks for CURRENT memberships only, so a live club the person LEFT does not shield them", async () => {
    delete process.env.BILLING_ENABLED;
    // What the database returns for someone who left Sutton FC and is now
    // only in a setting-up club: the left membership is not in the rows.
    dbMock.membership.findMany.mockResolvedValue([held]);
    expect(await settingUpClubsReason("u-left")).toBe("club-setting-up");
    expect(dbMock.membership.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.membership.findMany.mock.calls[0][0]).toEqual({
      where: { userId: "u-left", leftAt: null, org: { approvalStatus: "approved" } },
      select: { org: { select: { approvalStatus: true, setupStage: true } } },
    });
  });

  it("billing on: a paused club beside a setting-up one does not count as served", async () => {
    process.env.BILLING_ENABLED = "1";
    dbMock.membership.findMany.mockResolvedValue([held]);
    expect(await settingUpClubsReason("u-hana")).toBe("club-setting-up");
    expect(dbMock.membership.findMany.mock.calls[0][0].where.org).toEqual({
      approvalStatus: "approved",
      billingStatus: { not: "paused" },
    });
  });
});

describe("closeUnfinishedSetupLearning: for the go-live transaction (not called from anywhere yet)", () => {
  const NOW = new Date("2026-10-12T10:05:00Z");
  const tx = { $queryRaw: vi.fn(), $executeRaw: vi.fn() };
  const sqlOf = (call: unknown[]) => (call[0] as string[]).join("?");

  beforeEach(() => {
    tx.$queryRaw.mockReset();
    tx.$executeRaw.mockReset();
  });

  it("an unfinished row (running or deferred) gets a FINAL status, so no later sweep can claim it", async () => {
    tx.$queryRaw.mockResolvedValue([{ inserted: false }]);
    expect(await closeUnfinishedSetupLearning("org-1", tx, NOW)).toBe("closed");
    const sql = sqlOf(tx.$queryRaw.mock.calls[0]);
    expect(sql).toContain(`INSERT INTO "ClubSetupLearning"`);
    expect(sql).toContain(`ON CONFLICT ("orgId") DO UPDATE`);
    expect(sql).toContain(`'skipped'`);
    expect(sql).toContain(`'went-live'`);
    // Only an unfinished row is touched; a final one is left as it is.
    expect(sql).toContain(`WHERE "ClubSetupLearning"."status" IN ('running', 'deferred')`);
  });

  it("ONE statement and no caught error: a unique violation would abort the caller's transaction", async () => {
    tx.$queryRaw.mockResolvedValue([{ inserted: true }]);
    await closeUnfinishedSetupLearning("org-1", tx, NOW);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("no row yet: one is created already final, so the club can never be read", async () => {
    tx.$queryRaw.mockResolvedValue([{ inserted: true }]);
    expect(await closeUnfinishedSetupLearning("org-1", tx, NOW)).toBe("created-closed");
  });

  it("a row that is already final is left exactly as it is, and its chat is not touched", async () => {
    tx.$queryRaw.mockResolvedValue([]);
    expect(await closeUnfinishedSetupLearning("org-1", tx, NOW)).toBe("already-final");
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("the stored chat is deleted with it: a closed reading never needs it", async () => {
    tx.$queryRaw.mockResolvedValue([{ inserted: false }]);
    await closeUnfinishedSetupLearning("org-1", tx, NOW);
    const sql = sqlOf(tx.$executeRaw.mock.calls[0]);
    expect(sql).toContain(`"capturedHistory" = NULL`);
    expect(sql).toContain(`"orgId" = ?`);
    expect(tx.$executeRaw.mock.calls[0][1]).toBe("org-1");
  });

  it("a database error is thrown, so the go-live transaction rolls back", async () => {
    tx.$queryRaw.mockRejectedValue(new Error("connection reset"));
    await expect(closeUnfinishedSetupLearning("org-1", tx, NOW)).rejects.toThrow("connection reset");
  });
});
