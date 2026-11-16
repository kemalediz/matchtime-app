/**
 * The match page's pool panel (and so the short-squad notice and the HQ
 * YES list) with MatchTime staff tests (rounds 3 and 4 of #607):
 *   - whether the pool can be asked is decided by EVERY eligible candidate,
 *     staff tests included, so Kemal can test an ask with nobody else near;
 *   - the band SHOWN counts only real players, and reads "a few" when the
 *     only candidates are staff tests;
 *   - asked, declined and placed leave staff tests out, read off the offer's
 *     own flag (`PoolOffer.staffTest`), which outlives the profile.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ db: { poolAsk: { findFirst: vi.fn() } } }));
vi.mock("../../db", () => dbMock);
vi.mock("../../club-partnership", () => ({ loadPartnerAskSettings: vi.fn(async () => null) }));
const cand = vi.hoisted(() => ({ findPoolCandidates: vi.fn() }));
vi.mock("../candidates", async (orig) => ({ ...(await orig<typeof import("../candidates")>()), findPoolCandidates: cand.findPoolCandidates }));
// The shown fill is the one shared helper (`loadRoundFillShown`, through
// `poolAskShownFill`); its own rules are partner-ask-round-shown.test.ts.
const fill = vi.hoisted(() => ({ poolAskShownFill: vi.fn() }));
vi.mock("../round", () => fill);

import { loadPoolPanel, poolNoticeBand } from "../panel";

const eligible = (userId: string) => ({ userId, row: { userId } });
const found = (ids: string[], staff: string[]) => ({
  ctx: { orgId: "org-1" },
  selection: { gate: null, eligible: ids.map(eligible), excluded: {} },
  staffTestUserIds: new Set(staff),
});

beforeEach(() => {
  vi.clearAllMocks();
  cand.findPoolCandidates.mockResolvedValue(found(["kemal", "ali"], ["kemal"]));
  dbMock.db.poolAsk.findFirst.mockResolvedValue(null);
  fill.poolAskShownFill.mockResolvedValue({ wanted: 2, placed: 0 });
});

describe("the band: asking decided by everyone eligible, the shown band by real players", () => {
  it("a real player and a staff test: a few", async () => {
    expect((await loadPoolPanel("m1", "org-1"))?.band).toBe("few");
  });

  it("only a staff test near: the ask can still go out, the band shown is a few", async () => {
    cand.findPoolCandidates.mockResolvedValue(found(["kemal"], ["kemal"]));
    const panel = await loadPoolPanel("m1", "org-1");
    expect(panel?.band).toBe("few");
    expect(panel?.gate).toBeNull();
  });

  it("five staff tests and one real player: a few, never 5+", async () => {
    cand.findPoolCandidates.mockResolvedValue(found(["s1", "s2", "s3", "s4", "s5", "ali"], ["s1", "s2", "s3", "s4", "s5"]));
    expect((await loadPoolPanel("m1", "org-1"))?.band).toBe("few");
  });

  it("nobody eligible at all: none", async () => {
    cand.findPoolCandidates.mockResolvedValue(found([], []));
    expect((await loadPoolPanel("m1", "org-1"))?.band).toBe("none");
  });

  it("the short-squad notice line (and so the HQ YES list) offers the pool when only a staff test is near", async () => {
    cand.findPoolCandidates.mockResolvedValue(found(["kemal"], ["kemal"]));
    expect(await poolNoticeBand("org-1", { id: "m1", date: new Date(Date.now() + 3 * 24 * 3600_000) }, new Date())).toBe("few");
  });
});

describe("asked, declined and placed: staff tests left out, by the offer's own flag", () => {
  beforeEach(() => {
    dbMock.db.poolAsk.findFirst.mockResolvedValue({
      id: "ask-1",
      roundId: null,
      status: "open",
      places: 2,
      offers: [
        { sentAt: new Date(), outcome: "accepted", staffTest: true },
        { sentAt: new Date(), outcome: "declined", staffTest: true },
        { sentAt: new Date(), outcome: "declined", staffTest: false },
        { sentAt: new Date(), outcome: null, staffTest: false },
      ],
    });
  });

  it("asked 2 and declined 1 of the real players", async () => {
    const panel = await loadPoolPanel("m1", "org-1");
    expect(panel?.ask).toMatchObject({ asked: 2, declined: 1 });
    const select = dbMock.db.poolAsk.findFirst.mock.calls[0][0].select.offers.select;
    expect(select).toMatchObject({ staffTest: true });
  });

  it("placed is the round's SHOWN fill: a staff test with a place is not found", async () => {
    fill.poolAskShownFill.mockResolvedValue({ wanted: 2, placed: 0 });
    const panel = await loadPoolPanel("m1", "org-1");
    expect(panel?.ask).toMatchObject({ placed: 0, wanted: 2 });
    expect(fill.poolAskShownFill).toHaveBeenCalledWith({ id: "ask-1", roundId: null, matchId: "m1", places: 2 });
  });
});
