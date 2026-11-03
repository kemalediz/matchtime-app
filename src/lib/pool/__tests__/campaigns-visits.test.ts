/**
 * The owner's source codes page numbers (2026-11-03): per code, visits next
 * to the sign-ups it brought, and the same for the ways in without a code
 * (plain /play, a friend's link), so "clicked and gave up" and "never
 * clicked" can be told apart. Counts only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  db: {
    poolCampaign: { findMany: vi.fn() },
    poolProfile: { groupBy: vi.fn() },
    poolCampaignVisit: { groupBy: vi.fn() },
  },
}));
vi.mock("../../db", () => dbMock);
vi.mock("../../app-url", () => ({ appBaseUrl: () => "https://matchtime.ai" }));

import { listPoolCampaigns, poolWaysInWithoutCode } from "../campaigns";
import { POOL_VISIT_DIRECT, POOL_VISIT_REFERRAL } from "../visit-rules";

const CREATED = new Date("2026-11-03T10:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.db.poolCampaign.findMany.mockResolvedValue([
    { code: "fb-sutton", source: "facebook", label: "Sutton Facebook group", active: true, createdAt: CREATED },
    { code: "nd-cheam", source: "nextdoor", label: "Cheam Nextdoor", active: true, createdAt: CREATED },
  ]);
  dbMock.db.poolProfile.groupBy.mockImplementation(async (args: { by: string[] }) =>
    args.by[0] === "sourceCode"
      ? [
          { sourceCode: "fb-sutton", status: "pending-verify", _count: { _all: 2 } },
          { sourceCode: "fb-sutton", status: "active", _count: { _all: 1 } },
        ]
      : [
          { source: "web", status: "pending-verify", _count: { _all: 1 } },
          { source: "web", status: "active", _count: { _all: 4 } },
          { source: "referral", status: "active", _count: { _all: 2 } },
        ],
  );
  dbMock.db.poolCampaignVisit.groupBy.mockResolvedValue([
    { code: "fb-sutton", _sum: { count: 40 } },
    { code: POOL_VISIT_DIRECT, _sum: { count: 764 } },
    { code: POOL_VISIT_REFERRAL, _sum: { count: 9 } },
  ]);
});

describe("listPoolCampaigns", () => {
  it("each code: visits, sign-ups started (waiting and confirmed together), confirmed, still waiting", async () => {
    const rows = await listPoolCampaigns();
    expect(rows.map(({ code, visits, started, confirmed, waiting }) => ({ code, visits, started, confirmed, waiting }))).toEqual([
      { code: "fb-sutton", visits: 40, started: 3, confirmed: 1, waiting: 2 },
      { code: "nd-cheam", visits: 0, started: 0, confirmed: 0, waiting: 0 },
    ]);
    expect(rows[0].url).toBe("https://matchtime.ai/play?src=fb-sutton");
    expect(dbMock.db.poolCampaignVisit.groupBy).toHaveBeenCalledWith({ by: ["code"], _sum: { count: true } });
  });
});

describe("poolWaysInWithoutCode", () => {
  it("plain /play (direct visits, web sign-ups) and a friend's link (referral visits, referral sign-ups)", async () => {
    expect(await poolWaysInWithoutCode()).toEqual({
      direct: { visits: 764, started: 5, confirmed: 4, waiting: 1 },
      referral: { visits: 9, started: 2, confirmed: 2, waiting: 0 },
    });
    expect(dbMock.db.poolProfile.groupBy).toHaveBeenCalledWith({ by: ["source", "status"], where: { source: { in: ["web", "referral"] } }, _count: { _all: true } });
  });
});
