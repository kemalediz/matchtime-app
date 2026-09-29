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
    expect(isClubOperational({ approvalStatus: "approved", dormantAt: null })).toBe(true);
  });

  it("a dormant approved club is not", () => {
    expect(isClubOperational({ approvalStatus: "approved", dormantAt: new Date("2026-06-18") })).toBe(false);
  });

  it("no unapproved club is, whatever its dormancy", () => {
    for (const s of ["draft", "pending", "rejected", "suspended"]) {
      expect(isClubOperational({ approvalStatus: s, dormantAt: null })).toBe(false);
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
