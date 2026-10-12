/**
 * Club approval, slice 1: the pure rules and the silent-group loader.
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections 3, 4.3, 12.
 *
 * db is mocked. No network, no model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findMany: vi.fn(), count: vi.fn() },
  clubConnect: { findMany: vi.fn() },
  unsolicitedGroup: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import {
  APPROVAL_STATUSES,
  APPROVED_CLUB_WHERE,
  computeSilentGroups,
  isClubApproved,
  isClubOperational,
  isLegacySetupTriggerEnabled,
  isSelfJoinEnabled,
  isSilentGroup,
  loadSilentGroupIds,
  inGroupSetupRefusal,
  onlyUnapprovedClubs,
} from "../club-approval";

const SUTTON_GROUP = "120363000000000001@g.us";

describe("approval states", () => {
  it("has exactly the five states the CHECK constraint allows", () => {
    expect([...APPROVAL_STATUSES]).toEqual(["draft", "pending", "approved", "rejected", "suspended"]);
  });

  it("the Prisma fragment for an approved club is one field", () => {
    expect(APPROVED_CLUB_WHERE).toEqual({ approvalStatus: "approved" });
  });

  it("only 'approved' is approved", () => {
    expect(isClubApproved({ approvalStatus: "approved" })).toBe(true);
    for (const s of ["draft", "pending", "rejected", "suspended", "", "APPROVED", undefined]) {
      expect(isClubApproved({ approvalStatus: s as string })).toBe(false);
    }
  });
});

describe("isClubOperational: approved and not dormant", () => {
  it("Sutton FC's shape (default approved, live) is operational", () => {
    expect(isClubOperational({ approvalStatus: "approved", dormantAt: null, billingStatus: "exempt" })).toBe(true);
  });

  it("a dormant approved club is not", () => {
    expect(isClubOperational({ approvalStatus: "approved", dormantAt: new Date("2026-06-18"), billingStatus: "exempt" })).toBe(false);
  });

  it("no unapproved club is, whatever its dormancy", () => {
    for (const s of ["draft", "pending", "rejected", "suspended"]) {
      expect(isClubOperational({ approvalStatus: s, dormantAt: null, billingStatus: "exempt" })).toBe(false);
    }
  });
});

describe("flags", () => {
  it("self-join is OFF unless explicitly switched on", () => {
    expect(isSelfJoinEnabled(undefined)).toBe(false);
    expect(isSelfJoinEnabled("")).toBe(false);
    expect(isSelfJoinEnabled("0")).toBe(false);
    expect(isSelfJoinEnabled("false")).toBe(false);
    for (const v of ["1", "true", "on", "yes", " TRUE "]) expect(isSelfJoinEnabled(v)).toBe(true);
  });

  it("the legacy '@MatchTime setup' trigger is on exactly when self-join is off (decision 4)", () => {
    expect(isLegacySetupTriggerEnabled(undefined)).toBe(true);
    expect(isLegacySetupTriggerEnabled("1")).toBe(false);
  });
});

describe("computeSilentGroups", () => {
  it("collects unapproved clubs' groups, their connect groups and unsolicited groups, once each", () => {
    const out = computeSilentGroups({
      unapprovedOrgGroups: ["g-suspended"],
      unapprovedConnectGroups: ["g-pending", "g-pending"],
      unsolicitedGroups: ["g-stranger"],
      approvedOrgGroups: [SUTTON_GROUP],
    });
    expect(out.sort()).toEqual(["g-pending", "g-stranger", "g-suspended"]);
  });

  it("an approved club's group is NEVER silent, even when a stale row names it", () => {
    const out = computeSilentGroups({
      unapprovedOrgGroups: [SUTTON_GROUP],
      unapprovedConnectGroups: [SUTTON_GROUP],
      unsolicitedGroups: [SUTTON_GROUP],
      approvedOrgGroups: [SUTTON_GROUP],
    });
    expect(out).toEqual([]);
  });

  it("slice 2a: a linked admin group is never silent, and a candidate still waiting for its code is", () => {
    const out = computeSilentGroups({
      unapprovedOrgGroups: [],
      unapprovedConnectGroups: [],
      // The candidate row of a linked group was closed at link time; a
      // stale open one must still not silence it.
      unsolicitedGroups: ["g-hq-linked", "g-hq-candidate"],
      approvedOrgGroups: [SUTTON_GROUP],
      adminGroups: ["g-hq-linked"],
    });
    expect(out).toEqual(["g-hq-candidate"]);
  });

  it("go-live S1: a club that is approved but still SETTING UP has a silent group", () => {
    const out = computeSilentGroups({
      unapprovedOrgGroups: [],
      unapprovedConnectGroups: [],
      unsolicitedGroups: [],
      approvedOrgGroups: [SUTTON_GROUP],
      settingUpOrgGroups: ["g-setting-up", null, ""],
    });
    expect(out).toEqual(["g-setting-up"]);
  });

  it("go-live S1: a live club's group is never silenced by a stale setting-up entry, and an admin group never is", () => {
    const out = computeSilentGroups({
      unapprovedOrgGroups: [],
      unapprovedConnectGroups: [],
      unsolicitedGroups: [],
      approvedOrgGroups: [SUTTON_GROUP],
      adminGroups: ["g-hq"],
      settingUpOrgGroups: [SUTTON_GROUP, "g-hq"],
    });
    expect(out).toEqual([]);
  });

  it("DOCUMENTS CURRENT BEHAVIOUR (not a decision): a setting-up club's players' group that is ALSO some club's admin group is NOT silent", () => {
    // The admin-group rule wins. The Pi is then told this group is an admin
    // group (loadAdminGroups), so it forwards each message to the
    // admin-group route and posts that route's replies there. No code path
    // creates this state today (linkAdminGroup refuses a club's own group,
    // and the group add refuses a linked admin group); a later slice
    // decides what should happen if data ever holds it.
    const out = computeSilentGroups({
      unapprovedOrgGroups: [],
      unapprovedConnectGroups: [],
      unsolicitedGroups: [],
      approvedOrgGroups: [SUTTON_GROUP],
      adminGroups: ["g-players-and-hq"],
      settingUpOrgGroups: ["g-players-and-hq"],
    });
    expect(out).toEqual([]);
  });

  it("blank ids are dropped", () => {
    expect(
      computeSilentGroups({
        unapprovedOrgGroups: [null, ""],
        unapprovedConnectGroups: [null],
        unsolicitedGroups: [""],
        approvedOrgGroups: [],
      }),
    ).toEqual([]);
  });
});

describe("loadSilentGroupIds (db)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.organisation.findMany.mockImplementation((args: { where: { approvalStatus: unknown } }) =>
      Promise.resolve(
        args.where.approvalStatus === "approved"
          ? [{ whatsappGroupId: SUTTON_GROUP }]
          : [{ whatsappGroupId: "g-suspended" }],
      ),
    );
    dbMock.clubConnect.findMany.mockResolvedValue([{ groupId: "g-pending" }]);
    dbMock.unsolicitedGroup.findMany.mockResolvedValue([{ groupId: "g-stranger" }]);
  });

  it("reads the three sources and subtracts approved clubs' groups", async () => {
    expect((await loadSilentGroupIds()).sort()).toEqual(["g-pending", "g-stranger", "g-suspended"]);
  });

  it("asks for unapproved connects by the ORG's status and for unsolicited groups not yet left", async () => {
    await loadSilentGroupIds();
    const connectWhere = dbMock.clubConnect.findMany.mock.calls[0][0].where;
    expect(connectWhere.groupId).toEqual({ not: null });
    expect(connectWhere.org).toEqual({ approvalStatus: { not: "approved" } });
    expect(dbMock.unsolicitedGroup.findMany.mock.calls[0][0].where).toEqual({ leftAt: null });
  });

  it("go-live S1: an approved club that is setting up is silent, not protected as 'approved'", async () => {
    dbMock.organisation.findMany.mockImplementation((args: { where: { approvalStatus: unknown } }) =>
      Promise.resolve(
        args.where.approvalStatus === "approved"
          ? [
              { whatsappGroupId: SUTTON_GROUP, approvalStatus: "approved", setupStage: "live" },
              { whatsappGroupId: "g-setting-up", approvalStatus: "approved", setupStage: "setting-up" },
            ]
          : [{ whatsappGroupId: "g-suspended" }],
      ),
    );
    // A stale unsolicited row naming the setting-up club's group must not matter either way.
    dbMock.unsolicitedGroup.findMany.mockResolvedValue([{ groupId: "g-stranger" }, { groupId: "g-setting-up" }]);
    const silent = await loadSilentGroupIds();
    expect(silent.sort()).toEqual(["g-pending", "g-setting-up", "g-stranger", "g-suspended"]);
    expect(silent).not.toContain(SUTTON_GROUP);
    expect(await isSilentGroup("g-setting-up")).toBe(true);
  });

  it("go-live S1: the approved clubs' query is today's WHERE; the stage is only selected", async () => {
    await loadSilentGroupIds();
    const approvedCall = dbMock.organisation.findMany.mock.calls.find((c) => c[0].where.approvalStatus === "approved")!;
    expect(approvedCall[0].where).toEqual({ approvalStatus: "approved", whatsappGroupId: { not: null } });
    expect(approvedCall[0].select).toEqual({ whatsappGroupId: true, approvalStatus: true, setupStage: true });
    // Still five queries with billing off: no extra read for the new state.
    expect(dbMock.organisation.findMany.mock.calls.length + dbMock.clubConnect.findMany.mock.calls.length + dbMock.unsolicitedGroup.findMany.mock.calls.length).toBe(5);
  });

  it("isSilentGroup answers for one group", async () => {
    expect(await isSilentGroup("g-pending")).toBe(true);
    expect(await isSilentGroup(SUTTON_GROUP)).toBe(false);
    expect(await isSilentGroup("g-unknown")).toBe(false);
  });
});

describe("inGroupSetupRefusal: may the in-group setup run for this group?", () => {
  const ENV = process.env.SELF_JOIN_ENABLED;
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SELF_JOIN_ENABLED;
    dbMock.organisation.findMany.mockImplementation((args: { where: { approvalStatus: unknown } }) =>
      Promise.resolve(args.where.approvalStatus === "approved" ? [{ whatsappGroupId: SUTTON_GROUP }] : []),
    );
    dbMock.clubConnect.findMany.mockResolvedValue([{ groupId: "g-pending" }]);
    dbMock.unsolicitedGroup.findMany.mockResolvedValue([{ groupId: "g-stranger" }]);
  });
  afterEach(() => {
    if (ENV === undefined) delete process.env.SELF_JOIN_ENABLED;
    else process.env.SELF_JOIN_ENABLED = ENV;
  });

  it("an ordinary unknown group may, while self-join is off (today's behaviour)", async () => {
    expect(await inGroupSetupRefusal("g-new")).toBeNull();
  });

  it("a silent group may not", async () => {
    expect(await inGroupSetupRefusal("g-pending")).toBe("silent-group");
    expect(await inGroupSetupRefusal("g-stranger")).toBe("silent-group");
  });

  it("with self-join on, no group may (decision 4), without even reading the database", async () => {
    process.env.SELF_JOIN_ENABLED = "1";
    expect(await inGroupSetupRefusal("g-new")).toBe("self-join-mode");
    expect(dbMock.clubConnect.findMany).not.toHaveBeenCalled();
  });
});

describe("onlyUnapprovedClubs: a DM sender whose every club is waiting (plan 4.3 layer 6)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a sender with no clubs at all is NOT caught (unchanged handling)", async () => {
    expect(await onlyUnapprovedClubs([])).toBe(false);
    expect(dbMock.organisation.count).not.toHaveBeenCalled();
  });

  it("a Sutton FC member (an approved club) is not caught", async () => {
    dbMock.organisation.count.mockResolvedValue(1);
    expect(await onlyUnapprovedClubs(["sutton"])).toBe(false);
    expect(dbMock.organisation.count.mock.calls[0][0].where).toEqual({
      id: { in: ["sutton"] },
      approvalStatus: "approved",
    });
  });

  it("a sender whose only clubs are unapproved is caught", async () => {
    dbMock.organisation.count.mockResolvedValue(0);
    expect(await onlyUnapprovedClubs(["pending-club"])).toBe(true);
  });
});
