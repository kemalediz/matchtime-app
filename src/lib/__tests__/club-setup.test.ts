/**
 * "Approved but setting up" (go-live plan 2.2 point 4, slice S1): the
 * database half. db is mocked. No network, no model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findMany: vi.fn(), findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { isClubSettingUpById, settingUpClubsReason } from "../club-setup";

const live = { approvalStatus: "approved", setupStage: "live" };
const held = { approvalStatus: "approved", setupStage: "setting-up" };

beforeEach(() => vi.clearAllMocks());

describe("settingUpClubsReason: the dm-reply rail", () => {
  const ENV = process.env.BILLING_ENABLED;
  afterEach(() => {
    if (ENV === undefined) delete process.env.BILLING_ENABLED;
    else process.env.BILLING_ENABLED = ENV;
  });

  it("a sender with no clubs is not caught, and no query is made", async () => {
    expect(await settingUpClubsReason([])).toBeNull();
    expect(dbMock.organisation.findMany).not.toHaveBeenCalled();
  });

  it("a member of a live club (every existing club) is not caught", async () => {
    dbMock.organisation.findMany.mockResolvedValue([live]);
    expect(await settingUpClubsReason(["sutton"])).toBeNull();
  });

  it("a sender whose only served club is setting up is caught", async () => {
    dbMock.organisation.findMany.mockResolvedValue([held]);
    expect(await settingUpClubsReason(["riverside"])).toBe("club-setting-up");
  });

  it("a sender in a live club AND a setting-up one is not caught", async () => {
    dbMock.organisation.findMany.mockResolvedValue([held, live]);
    expect(await settingUpClubsReason(["riverside", "sutton"])).toBeNull();
  });

  it("asks for the sender's APPROVED clubs only, in one query", async () => {
    delete process.env.BILLING_ENABLED;
    dbMock.organisation.findMany.mockResolvedValue([]);
    expect(await settingUpClubsReason(["a", "b"])).toBeNull();
    expect(dbMock.organisation.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.organisation.findMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ["a", "b"] }, approvalStatus: "approved" },
      select: { approvalStatus: true, setupStage: true },
    });
  });

  it("billing on: a paused club beside a setting-up one does not count as served", async () => {
    process.env.BILLING_ENABLED = "1";
    dbMock.organisation.findMany.mockResolvedValue([held]);
    expect(await settingUpClubsReason(["paused", "riverside"])).toBe("club-setting-up");
    expect(dbMock.organisation.findMany.mock.calls[0][0].where).toMatchObject({
      approvalStatus: "approved",
      billingStatus: { not: "paused" },
    });
  });
});

describe("isClubSettingUpById", () => {
  it("true for a setting-up club, false for a live one and for no club", async () => {
    dbMock.organisation.findFirst.mockResolvedValueOnce(held);
    expect(await isClubSettingUpById("riverside")).toBe(true);
    dbMock.organisation.findFirst.mockResolvedValueOnce(live);
    expect(await isClubSettingUpById("sutton")).toBe(false);
    dbMock.organisation.findFirst.mockResolvedValueOnce(null);
    expect(await isClubSettingUpById("nobody")).toBe(false);
  });
});
