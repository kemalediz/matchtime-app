/**
 * The owner's source codes page numbers (visits 2026-11-03, the funnel
 * 2026-11-04): per code, and for the ways in without a code (plain /play, a
 * friend's link), the four steps of the sign-up counted in the chosen
 * period (opened, started, sent, confirmed), so the step people stop at
 * shows. Next to them, all time, the sign-ups the code brought (from the
 * profiles, as before). Counts only.
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
const FROM = "2026-10-29";

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
    { code: "fb-sutton", step: "opened", _sum: { count: 40 } },
    { code: "fb-sutton", step: "started", _sum: { count: 12 } },
    { code: "fb-sutton", step: "sent", _sum: { count: 3 } },
    { code: "fb-sutton", step: "confirmed", _sum: { count: 1 } },
    { code: POOL_VISIT_DIRECT, step: "opened", _sum: { count: 24 } },
    { code: POOL_VISIT_DIRECT, step: "started", _sum: { count: 6 } },
    { code: POOL_VISIT_REFERRAL, step: "opened", _sum: { count: 9 } },
  ]);
});

const since = { where: { day: { gte: new Date(`${FROM}T00:00:00Z`) } } };

describe("listPoolCampaigns", () => {
  it("each code: the four steps in the period, and its sign-ups all time", async () => {
    const rows = await listPoolCampaigns(FROM);
    expect(rows.map(({ code, funnel, allTime }) => ({ code, funnel, allTime }))).toEqual([
      { code: "fb-sutton", funnel: { opened: 40, started: 12, sent: 3, confirmed: 1 }, allTime: { signups: 3, confirmed: 1, waiting: 2 } },
      { code: "nd-cheam", funnel: { opened: 0, started: 0, sent: 0, confirmed: 0 }, allTime: { signups: 0, confirmed: 0, waiting: 0 } },
    ]);
    expect(rows[0].url).toBe("https://matchtime.ai/play?src=fb-sutton");
    expect(dbMock.db.poolCampaignVisit.groupBy).toHaveBeenCalledWith({ by: ["code", "step"], ...since, _sum: { count: true } });
  });
});

describe("poolWaysInWithoutCode", () => {
  it("plain /play (direct steps, web sign-ups) and a friend's link (referral steps, referral sign-ups)", async () => {
    expect(await poolWaysInWithoutCode(FROM)).toEqual({
      direct: { funnel: { opened: 24, started: 6, sent: 0, confirmed: 0 }, allTime: { signups: 5, confirmed: 4, waiting: 1 } },
      referral: { funnel: { opened: 9, started: 0, sent: 0, confirmed: 0 }, allTime: { signups: 2, confirmed: 2, waiting: 0 } },
    });
    expect(dbMock.db.poolProfile.groupBy).toHaveBeenCalledWith({ by: ["source", "status"], where: { source: { in: ["web", "referral"] } }, _count: { _all: true } });
    expect(dbMock.db.poolCampaignVisit.groupBy).toHaveBeenCalledWith({ by: ["code", "step"], ...since, _sum: { count: true } });
  });
});
