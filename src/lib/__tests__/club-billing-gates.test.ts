/**
 * CLUB FEE BILLING, slice B1: the quiet gate (plan section 4.3).
 *
 * Every gate is tested three ways:
 *   - flag OFF: a club whose column says "paused" passes exactly like an
 *     approved club, and every query is exactly today's (byte for byte:
 *     the same `where` objects, the same number of queries);
 *   - flag ON, paused: the gate refuses;
 *   - flag ON, exempt (Sutton FC's shape, the column default) and every
 *     other billed state: the gate passes.
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
  APPROVED_CLUB_WHERE,
  SERVING_CLUB_WHERE,
  computeSilentGroups,
  isClubOperational,
  loadSilentGroupIds,
  nonServingClubsReason,
  onlyUnapprovedClubs,
  servingClubWhere,
} from "../club-approval";
import { fixtureSkipReason, partitionGeneratable, type FixtureCandidate } from "../org-lifecycle";
import { BILLING_STATUSES } from "../club-billing-rules";

const ENV = process.env.BILLING_ENABLED;
const on = () => {
  process.env.BILLING_ENABLED = "1";
};
const off = () => {
  delete process.env.BILLING_ENABLED;
};
afterEach(() => {
  if (ENV === undefined) delete process.env.BILLING_ENABLED;
  else process.env.BILLING_ENABLED = ENV;
});

const SUTTON_GROUP = "120363000000000001@g.us";
const PAUSED_GROUP = "120363000000000099@g.us";

describe("SERVING_CLUB_WHERE / servingClubWhere()", () => {
  it("the fragment is approved AND not billing-paused", () => {
    expect(SERVING_CLUB_WHERE).toEqual({ approvalStatus: "approved", billingStatus: { not: "paused" } });
  });
  it("flag off: exactly APPROVED_CLUB_WHERE (the query is unchanged)", () => {
    off();
    expect(servingClubWhere()).toEqual(APPROVED_CLUB_WHERE);
    expect(servingClubWhere()).toEqual({ approvalStatus: "approved" });
    process.env.BILLING_ENABLED = "0";
    expect(servingClubWhere()).toEqual({ approvalStatus: "approved" });
  });
  it("flag on: SERVING_CLUB_WHERE", () => {
    on();
    expect(servingClubWhere()).toEqual(SERVING_CLUB_WHERE);
  });
});

describe("isClubOperational: approved, not dormant, not billing-paused", () => {
  const live = { approvalStatus: "approved", dormantAt: null };
  it("flag off: a paused club is operational exactly like an approved one", () => {
    off();
    expect(isClubOperational({ ...live, billingStatus: "paused" })).toBe(true);
  });
  it("flag on: a paused club is not operational", () => {
    on();
    expect(isClubOperational({ ...live, billingStatus: "paused" })).toBe(false);
  });
  it("flag on: Sutton FC's shape (exempt) and every other state are operational", () => {
    on();
    for (const s of BILLING_STATUSES.filter((x) => x !== "paused")) {
      expect(isClubOperational({ ...live, billingStatus: s })).toBe(true);
    }
  });
  it("approval and dormancy still win, flag on or off", () => {
    for (const set of [on, off]) {
      set();
      expect(isClubOperational({ approvalStatus: "pending", dormantAt: null, billingStatus: "exempt" })).toBe(false);
      expect(isClubOperational({ approvalStatus: "approved", dormantAt: new Date(), billingStatus: "exempt" })).toBe(false);
    }
  });
});

describe("computeSilentGroups: a paused club's group is silent", () => {
  it("paused groups are silent", () => {
    expect(
      computeSilentGroups({
        unapprovedOrgGroups: [],
        unapprovedConnectGroups: [],
        unsolicitedGroups: [],
        approvedOrgGroups: [SUTTON_GROUP],
        pausedOrgGroups: [PAUSED_GROUP],
      }),
    ).toEqual([PAUSED_GROUP]);
  });
  it("absent pausedOrgGroups changes nothing", () => {
    expect(
      computeSilentGroups({
        unapprovedOrgGroups: [],
        unapprovedConnectGroups: [],
        unsolicitedGroups: [],
        approvedOrgGroups: [SUTTON_GROUP],
      }),
    ).toEqual([]);
  });
});

describe("loadSilentGroupIds (db)", () => {
  type Where = { approvalStatus?: unknown; billingStatus?: unknown };
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.organisation.findMany.mockImplementation((args: { where: Where }) => {
      const w = args.where;
      if (w.billingStatus === "paused") return Promise.resolve([{ whatsappGroupId: PAUSED_GROUP }]);
      if (w.approvalStatus === "approved") {
        // A query that does not exclude paused clubs sees the paused one too.
        const excludesPaused = JSON.stringify(w.billingStatus) === JSON.stringify({ not: "paused" });
        return Promise.resolve(
          excludesPaused
            ? [{ whatsappGroupId: SUTTON_GROUP }]
            : [{ whatsappGroupId: SUTTON_GROUP }, { whatsappGroupId: PAUSED_GROUP }],
        );
      }
      if (w.approvalStatus !== undefined) return Promise.resolve([]); // unapproved
      return Promise.resolve([]); // admin groups
    });
    dbMock.clubConnect.findMany.mockResolvedValue([]);
    dbMock.unsolicitedGroup.findMany.mockResolvedValue([]);
  });

  it("flag off: the same five queries as before, and the paused club's group is NOT silent", async () => {
    off();
    expect(await loadSilentGroupIds()).toEqual([]);
    expect(dbMock.organisation.findMany).toHaveBeenCalledTimes(3);
    expect(dbMock.organisation.findMany.mock.calls[0][0]).toEqual({
      where: { approvalStatus: "approved", whatsappGroupId: { not: null } },
      select: { whatsappGroupId: true },
    });
  });

  it("flag on: the paused club's group is silent; Sutton's never is", async () => {
    on();
    expect(await loadSilentGroupIds()).toEqual([PAUSED_GROUP]);
    const pausedQuery = dbMock.organisation.findMany.mock.calls.find((c) => c[0].where.billingStatus === "paused");
    expect(pausedQuery?.[0]).toEqual({
      where: { approvalStatus: "approved", billingStatus: "paused" },
      select: { whatsappGroupId: true, adminGroupId: true },
    });
  });
});

describe("dm-reply rail: nonServingClubsReason", () => {
  beforeEach(() => vi.clearAllMocks());

  it("no clubs at all: not caught, no query (unchanged)", async () => {
    on();
    expect(await nonServingClubsReason([])).toBeNull();
    expect(dbMock.organisation.count).not.toHaveBeenCalled();
  });

  it("flag off: one query, exactly today's, and a paused club's member is not caught", async () => {
    off();
    dbMock.organisation.count.mockResolvedValue(1);
    expect(await nonServingClubsReason(["paused-club"])).toBeNull();
    expect(dbMock.organisation.count).toHaveBeenCalledTimes(1);
    expect(dbMock.organisation.count.mock.calls[0][0]).toEqual({
      where: { id: { in: ["paused-club"] }, approvalStatus: "approved" },
    });
  });

  it("flag off: only unapproved clubs is still 'club-not-approved'", async () => {
    off();
    dbMock.organisation.count.mockResolvedValue(0);
    expect(await nonServingClubsReason(["pending"])).toBe("club-not-approved");
  });

  it("flag on: a member of only a paused club is caught as 'club-billing-paused'", async () => {
    on();
    dbMock.organisation.count.mockImplementation((args: { where: { billingStatus?: unknown } }) =>
      Promise.resolve(args.where.billingStatus ? 0 : 1),
    );
    expect(await nonServingClubsReason(["paused-club"])).toBe("club-billing-paused");
  });

  it("flag on: a member of a serving club (Sutton, exempt) is not caught", async () => {
    on();
    dbMock.organisation.count.mockResolvedValue(1);
    expect(await nonServingClubsReason(["sutton"])).toBeNull();
  });

  it("onlyUnapprovedClubs keeps its meaning (approval only), flag on or off", async () => {
    on();
    dbMock.organisation.count.mockResolvedValue(1);
    expect(await onlyUnapprovedClubs(["paused-club"])).toBe(false);
    expect(dbMock.organisation.count.mock.calls[0][0].where).toEqual({ id: { in: ["paused-club"] }, approvalStatus: "approved" });
  });
});

describe("fixtureSkipReason: 'org-billing-paused'", () => {
  const cand = (billingStatus: string, over: Partial<FixtureCandidate["org"]> = {}): FixtureCandidate => ({
    isActive: true,
    org: { dormantAt: null, approvalStatus: "approved", billingStatus, ...over },
  });

  it("flag off: a paused club still gets its fixture", () => {
    off();
    expect(fixtureSkipReason(cand("paused"))).toBeNull();
  });
  it("flag on: a paused club gets none", () => {
    on();
    expect(fixtureSkipReason(cand("paused"))).toBe("org-billing-paused");
  });
  it("flag on: exempt (Sutton) and every other state still get theirs", () => {
    on();
    for (const s of BILLING_STATUSES.filter((x) => x !== "paused")) expect(fixtureSkipReason(cand(s))).toBeNull();
  });
  it("dormancy and approval are reported first (the bigger fact)", () => {
    on();
    expect(fixtureSkipReason(cand("paused", { dormantAt: new Date() }))).toBe("org-dormant");
    expect(fixtureSkipReason(cand("paused", { approvalStatus: "suspended" }))).toBe("org-not-approved");
  });
  it("partitionGeneratable counts paused skips", () => {
    on();
    const p = partitionGeneratable([cand("paused"), cand("exempt")]);
    expect(p.generate).toHaveLength(1);
    expect(p.skippedBillingPausedOrgs).toBe(1);
  });
});
