/**
 * What the go-live pages show about a club that is setting up (slice S5):
 * the pure status, and the two loaders. db is mocked. No network, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn(), findMany: vi.fn() },
  clubConnect: { findFirst: vi.fn() },
  user: { findUnique: vi.fn() },
  platformJob: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import {
  loadClubSetupView,
  loadSetupStatuses,
  parseLiveBy,
  setupMessageState,
  setupStatusOf,
  SETUP_STATUS_SELECT,
} from "../club-setup";

const APPROVED = new Date("2026-10-12T09:00:00Z");
const ASKED = new Date("2026-10-12T09:05:00Z");
const LIVE = new Date("2026-10-12T11:00:00Z");
const NOW = new Date("2026-10-12T12:00:00Z");
const TOMORROW = new Date("2026-10-13T08:00:00Z");

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

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.platformJob.findMany.mockResolvedValue([]);
});

describe("setupStatusOf", () => {
  it("a club that is setting up: since the approval, setup message not sent, still in its group", () => {
    expect(setupStatusOf(held, { billingOn: true })).toEqual({
      settingUp: true,
      since: APPROVED,
      setupMessageSentAt: null,
      removedFromGroup: false,
      removedAt: null,
      liveAt: null,
      liveBy: null,
    });
  });

  it("the setup message's stamp is carried", () => {
    expect(setupStatusOf({ ...held, setupAskedAt: ASKED }, { billingOn: true }).setupMessageSentAt).toEqual(ASKED);
  });

  it("removed from the group: the stamp, no group at all, or paused for a removal (the same three as go-live's refusal)", () => {
    expect(setupStatusOf({ ...held, setupRemovedAt: ASKED }, { billingOn: false }).removedFromGroup).toBe(true);
    // WHEN it was removed is carried for the owner's page, from the stamp only.
    expect(setupStatusOf({ ...held, setupRemovedAt: ASKED }, { billingOn: false }).removedAt).toEqual(ASKED);
    expect(setupStatusOf({ ...held, whatsappGroupId: null }, { billingOn: false }).removedAt).toBeNull();
    // A club that has gone live shows no removal, whatever a stale stamp says.
    expect(setupStatusOf({ ...held, setupStage: "live", setupRemovedAt: ASKED }, { billingOn: false })).toMatchObject({ removedFromGroup: false, removedAt: null });
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
      removedAt: null,
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

describe("setupMessageState: what the owner's page may say about the setup message (review fix 6)", () => {
  it("never claimed: nothing is queued", () => {
    expect(setupMessageState(null, null, NOW)).toEqual({ kind: "none", at: null });
  });

  it("the stamp is the DM's DUE time: queued for tomorrow is 'queued', never 'sent'", () => {
    expect(setupMessageState(TOMORROW, { status: "queued", sentAt: null }, NOW)).toEqual({ kind: "queued", at: TOMORROW });
    // Due in the past and still in the queue: it is waiting, not sent.
    expect(setupMessageState(ASKED, { status: "queued", sentAt: null }, NOW)).toEqual({ kind: "waiting", at: ASKED });
    expect(setupMessageState(ASKED, { status: "claimed", sentAt: null }, NOW)).toEqual({ kind: "waiting", at: ASKED });
  });

  it("'sent' only when the job says so, with the time it really went", () => {
    expect(setupMessageState(ASKED, { status: "sent", sentAt: LIVE }, NOW)).toEqual({ kind: "sent", at: LIVE });
    expect(setupMessageState(ASKED, { status: "sent", sentAt: null }, NOW)).toEqual({ kind: "sent", at: null });
  });

  it("failed or cancelled, handed over but unconfirmed, and claimed with no job at all", () => {
    expect(setupMessageState(ASKED, { status: "failed", sentAt: null }, NOW)).toEqual({ kind: "failed", at: null });
    expect(setupMessageState(ASKED, { status: "unconfirmed", sentAt: null }, NOW)).toEqual({ kind: "unconfirmed", at: null });
    expect(setupMessageState(ASKED, null, NOW)).toEqual({ kind: "no-job", at: ASKED });
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
      removedFromGroup: false,
      group: "Harbour Tuesday 6s",
    });
    expect(dbMock.organisation.findUnique).toHaveBeenCalledWith({ where: { id: "o1" }, select: SETUP_STATUS_SELECT });
  });

  it("review fix 7: a club that is NOT setting up costs one query, and nobody is looked up", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...held, setupStage: "live", liveAt: LIVE, liveBy: "u-hana" });
    expect(await loadClubSetupView("o1", { billingEnabled: true })).toEqual({
      settingUp: false,
      removedFromGroup: false,
      group: null,
    });
    expect(dbMock.clubConnect.findFirst).not.toHaveBeenCalled();
    expect(dbMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("review fix 5: the view carries no user id, whoever took the club live", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...held, setupStage: "live", liveAt: LIVE, liveBy: "owner:u-kemal" });
    const view = await loadClubSetupView("o1", { billingEnabled: true });
    expect(JSON.stringify(view)).not.toContain("u-kemal");
    expect(Object.keys(view!).sort()).toEqual(["group", "removedFromGroup", "settingUp"]);
  });
});

describe("loadSetupStatuses", () => {
  it("no ids: no query", async () => {
    expect((await loadSetupStatuses([])).size).toBe(0);
    expect(dbMock.organisation.findMany).not.toHaveBeenCalled();
    expect(dbMock.platformJob.findMany).not.toHaveBeenCalled();
  });

  it("one query for the clubs and one for their setup messages, keyed by club", async () => {
    dbMock.organisation.findMany.mockResolvedValue([
      { ...held, setupAskedAt: TOMORROW },
      { ...held, id: "o2", setupStage: "live" },
      { ...held, id: "o3" },
    ]);
    dbMock.platformJob.findMany.mockResolvedValue([{ refId: "o1:setup-ask", status: "queued", sentAt: null }]);
    const map = await loadSetupStatuses(["o1", "o2", "o3"], { billingEnabled: true, now: NOW });
    expect(dbMock.organisation.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.organisation.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["o1", "o2", "o3"] } });
    expect(dbMock.platformJob.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.platformJob.findMany.mock.calls[0][0].where).toEqual({
      purpose: "setup-ask",
      refId: { in: ["o1:setup-ask", "o3:setup-ask"] },
    });
    expect(map.get("o1")).toMatchObject({ settingUp: true, setupMessage: { kind: "queued", at: TOMORROW } });
    expect(map.get("o2")).toMatchObject({ settingUp: false, setupMessage: { kind: "none", at: null } });
    expect(map.get("o3")).toMatchObject({ settingUp: true, setupMessage: { kind: "none", at: null } });
  });

  it("no club setting up: the setup messages are not queried", async () => {
    dbMock.organisation.findMany.mockResolvedValue([{ ...held, setupStage: "live" }]);
    await loadSetupStatuses(["o1"], { billingEnabled: true, now: NOW });
    expect(dbMock.platformJob.findMany).not.toHaveBeenCalled();
  });
});
