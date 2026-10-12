/**
 * What the go-live pages show about a club that is setting up (slice S5):
 * the pure status, and the two loaders. db is mocked. No network, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn(), findMany: vi.fn() },
  clubConnect: { findFirst: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { loadClubSetupView, loadSetupStatuses, parseLiveBy, setupStatusOf, SETUP_STATUS_SELECT } from "../club-setup";

const APPROVED = new Date("2026-10-12T09:00:00Z");
const ASKED = new Date("2026-10-12T09:05:00Z");
const LIVE = new Date("2026-10-12T11:00:00Z");

const held = {
  id: "o1",
  approvalStatus: "approved",
  setupStage: "setting-up",
  approvedAt: APPROVED,
  whatsappGroupId: "1203@g.us",
  liveAt: null,
  liveBy: null,
  setupAskedAt: null,
  setupRemovedAt: null,
  billingStatus: "exempt",
  clubBilling: null,
};

beforeEach(() => vi.clearAllMocks());

describe("setupStatusOf", () => {
  it("a club that is setting up: since the approval, setup message not sent, still in its group", () => {
    expect(setupStatusOf(held, { billingOn: true })).toEqual({
      settingUp: true,
      since: APPROVED,
      setupMessageSentAt: null,
      removedFromGroup: false,
      liveAt: null,
      liveBy: null,
    });
  });

  it("the setup message has been sent", () => {
    expect(setupStatusOf({ ...held, setupAskedAt: ASKED }, { billingOn: true }).setupMessageSentAt).toEqual(ASKED);
  });

  it("removed from the group: the stamp, no group at all, or paused for a removal (the same three as go-live's refusal)", () => {
    expect(setupStatusOf({ ...held, setupRemovedAt: ASKED }, { billingOn: false }).removedFromGroup).toBe(true);
    expect(setupStatusOf({ ...held, whatsappGroupId: null }, { billingOn: false }).removedFromGroup).toBe(true);
    const paused = { ...held, billingStatus: "paused", clubBilling: { pausedReason: "removed" } };
    expect(setupStatusOf(paused, { billingOn: true }).removedFromGroup).toBe(true);
    // Billing off: the pause is not looked at, as in `goLiveClub`.
    expect(setupStatusOf(paused, { billingOn: false }).removedFromGroup).toBe(false);
    // Paused for the fee is not a removal.
    const unpaid = { ...held, billingStatus: "paused", clubBilling: { pausedReason: "unpaid" } };
    expect(setupStatusOf(unpaid, { billingOn: true }).removedFromGroup).toBe(false);
  });

  it("a live club that never passed through the hold (every club today): nothing to show", () => {
    const sutton = { ...held, setupStage: "live", approvedAt: null, whatsappGroupId: null };
    expect(setupStatusOf(sutton, { billingOn: true })).toEqual({
      settingUp: false,
      since: null,
      setupMessageSentAt: null,
      removedFromGroup: false,
      liveAt: null,
      liveBy: null,
    });
  });

  it("a club that went live: when, and who", () => {
    const wentLive = { ...held, setupStage: "live", liveAt: LIVE, liveBy: "u-hana" };
    expect(setupStatusOf(wentLive, { billingOn: true })).toMatchObject({
      settingUp: false,
      liveAt: LIVE,
      liveBy: { kind: "user", userId: "u-hana" },
    });
  });

  it("a suspended club is not setting up, whatever its stage", () => {
    expect(setupStatusOf({ ...held, approvalStatus: "suspended" }, { billingOn: true }).settingUp).toBe(false);
  });
});

describe("parseLiveBy", () => {
  it("a club's own owner or admin, the MatchTime owner, and nobody", () => {
    expect(parseLiveBy("u-hana")).toEqual({ kind: "user", userId: "u-hana" });
    expect(parseLiveBy("owner:u-kemal")).toEqual({ kind: "matchtime" });
    expect(parseLiveBy(null)).toBeNull();
    expect(parseLiveBy("")).toBeNull();
  });
});

describe("loadClubSetupView", () => {
  it("no such club: null", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(null);
    expect(await loadClubSetupView("nope")).toBeNull();
  });

  it("setting up: the status, with the group's own name", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(held);
    dbMock.clubConnect.findFirst.mockResolvedValue({ groupSubject: " Harbour Tuesday 6s " });
    expect(await loadClubSetupView("o1", { billingEnabled: true })).toEqual({
      settingUp: true,
      since: APPROVED,
      setupMessageSentAt: null,
      removedFromGroup: false,
      liveAt: null,
      liveBy: null,
      group: "Harbour Tuesday 6s",
      wentLiveBy: null,
    });
    expect(dbMock.organisation.findUnique).toHaveBeenCalledWith({ where: { id: "o1" }, select: SETUP_STATUS_SELECT });
    expect(dbMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("went live by one of its own admins: their NAME, and nothing else about them", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...held, setupStage: "live", liveAt: LIVE, liveBy: "u-hana" });
    dbMock.clubConnect.findFirst.mockResolvedValue(null);
    dbMock.user.findUnique.mockResolvedValue({ name: "Hana Harbour" });
    const view = await loadClubSetupView("o1", { billingEnabled: true });
    expect(view).toMatchObject({ settingUp: false, group: null, wentLiveBy: { matchTime: false, name: "Hana Harbour" } });
    // A name only: never a phone number or an email.
    expect(dbMock.user.findUnique).toHaveBeenCalledWith({ where: { id: "u-hana" }, select: { name: true } });
  });

  it("went live by the MatchTime owner: said as MatchTime, the owner is not looked up or named", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...held, setupStage: "live", liveAt: LIVE, liveBy: "owner:u-kemal" });
    dbMock.clubConnect.findFirst.mockResolvedValue(null);
    const view = await loadClubSetupView("o1", { billingEnabled: true });
    expect(view?.wentLiveBy).toEqual({ matchTime: true, name: null });
    expect(dbMock.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("loadSetupStatuses", () => {
  it("no ids: no query", async () => {
    expect((await loadSetupStatuses([])).size).toBe(0);
    expect(dbMock.organisation.findMany).not.toHaveBeenCalled();
  });

  it("one query for every club asked about, keyed by club", async () => {
    dbMock.organisation.findMany.mockResolvedValue([held, { ...held, id: "o2", setupStage: "live" }]);
    const map = await loadSetupStatuses(["o1", "o2"], { billingEnabled: true });
    expect(dbMock.organisation.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.organisation.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["o1", "o2"] } });
    expect(map.get("o1")?.settingUp).toBe(true);
    expect(map.get("o2")?.settingUp).toBe(false);
  });
});
