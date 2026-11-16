/**
 * The match page's pool panel (and so the short-squad notice) counts no
 * MatchTime staff test (round 3 of #607): not in the "a few / 5+" band, not
 * in how many were asked or said no. A staff test still receives the offer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ db: { poolAsk: { findFirst: vi.fn() }, poolProfile: { findMany: vi.fn() } } }));
vi.mock("../../db", () => dbMock);
vi.mock("../../club-partnership", () => ({ loadPartnerAskSettings: vi.fn(async () => null) }));
const cand = vi.hoisted(() => ({ findPoolCandidates: vi.fn() }));
vi.mock("../candidates", async (orig) => ({ ...(await orig<typeof import("../candidates")>()), findPoolCandidates: cand.findPoolCandidates }));
vi.mock("../round", () => ({ poolAskFill: vi.fn(async () => ({ wanted: 2, placed: 0 })) }));

import { loadPoolPanel } from "../panel";

const eligible = (userId: string) => ({ userId, row: { userId } });

beforeEach(() => {
  vi.clearAllMocks();
  cand.findPoolCandidates.mockResolvedValue({
    ctx: { orgId: "org-1" },
    selection: { gate: null, eligible: [eligible("kemal"), eligible("ali")], excluded: {} },
    staffTestUserIds: new Set(["kemal"]),
  });
  dbMock.db.poolAsk.findFirst.mockResolvedValue({
    id: "ask-1",
    roundId: null,
    status: "open",
    places: 2,
    offers: [
      { userId: "kemal", sentAt: new Date(), outcome: "declined" },
      { userId: "ali", sentAt: new Date(), outcome: "declined" },
      { userId: "bea", sentAt: new Date(), outcome: null },
    ],
  });
  dbMock.db.poolProfile.findMany.mockResolvedValue([{ userId: "kemal" }]);
});

describe("loadPoolPanel: staff tests in no number", () => {
  it("the band counts only the ordinary candidate", async () => {
    const panel = await loadPoolPanel("m1", "org-1");
    expect(panel?.band).toBe("few");
    cand.findPoolCandidates.mockResolvedValue({
      ctx: { orgId: "org-1" },
      selection: { gate: null, eligible: [eligible("kemal")], excluded: {} },
      staffTestUserIds: new Set(["kemal"]),
    });
    expect((await loadPoolPanel("m1", "org-1"))?.band).toBe("none");
  });

  it("asked and declined leave out the offers sent to a staff test", async () => {
    const panel = await loadPoolPanel("m1", "org-1");
    expect(panel?.ask).toMatchObject({ asked: 2, declined: 1 });
    expect(dbMock.db.poolProfile.findMany).toHaveBeenCalledWith({ where: { userId: { in: ["kemal", "ali", "bea"] }, staffTest: true }, select: { userId: true } });
  });
});
