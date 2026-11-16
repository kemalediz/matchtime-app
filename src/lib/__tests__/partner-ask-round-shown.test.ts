/**
 * The round's fill as an organiser SEES it (rounds 4 and 5 of #607): the
 * real fill (`loadRoundFill`) counts a MatchTime staff test holding a place,
 * since he truly fills it; the number shown on the match page does not, for
 * a pool-only round and a partners-plus-pool round alike, so it never reads
 * "1 found" for Kemal's own test. One helper for both
 * (`loadRoundFillShown`).
 *   - a staff test is read off his offer's own flag (`PoolOffer.staffTest`);
 *   - nothing is taken off when the pool's share could not be read (the
 *     fill then counted no pool guest at all);
 *   - a staff user who is also a partner volunteer or pick in the round is
 *     counted as that, and not taken off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  partnerAsk: { findMany: vi.fn() },
  attendance: { count: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
const share = vi.hoisted(() => ({ poolRoundShare: vi.fn(), poolRoundStaffTestIds: vi.fn() }));
vi.mock("../pool/round-share", () => share);

import { loadRoundFill, loadRoundFillShown } from "../partner-ask-round";

const ASK = { id: "pa1", roundId: "r1", matchId: "m1", places: 2, volunteerUserIds: [] as string[], pickedUserIds: [] as string[] };

/** Confirmed on the match: whoever the query names, among these. */
const confirmed = (ids: string[]) =>
  dbMock.attendance.count.mockImplementation(async (a: { where: { userId: { in: string[] } } }) => a.where.userId.in.filter((u) => ids.includes(u)).length);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.partnerAsk.findMany.mockResolvedValue([{ places: 2, volunteerUserIds: ["vera"], pickedUserIds: [] }]);
  share.poolRoundShare.mockResolvedValue({ places: 2, userIds: ["kemal", "ali"] });
  share.poolRoundStaffTestIds.mockResolvedValue(["kemal"]);
  confirmed(["vera", "kemal", "ali"]);
});

describe("loadRoundFillShown", () => {
  it("partners and the pool together: the staff test's place is not shown, the real fill still counts it", async () => {
    expect(await loadRoundFill(ASK)).toEqual({ wanted: 2, placed: 3 });
    expect(await loadRoundFillShown(ASK)).toEqual({ wanted: 2, placed: 2 });
    expect(share.poolRoundStaffTestIds).toHaveBeenCalledWith("m1", "r1");
  });

  it("the reviewer's case: the only pool player is a staff test and he accepted: 0 found", async () => {
    dbMock.partnerAsk.findMany.mockResolvedValue([{ places: 1, volunteerUserIds: [], pickedUserIds: [] }]);
    share.poolRoundShare.mockResolvedValue({ places: 1, userIds: ["kemal"] });
    confirmed(["kemal"]);
    expect(await loadRoundFill(ASK)).toMatchObject({ placed: 1 });
    expect(await loadRoundFillShown(ASK)).toEqual({ wanted: 1, placed: 0 });
  });

  it("the pool's share could not be read: nothing taken off (the fill counted no pool guest)", async () => {
    share.poolRoundShare.mockResolvedValue(null);
    confirmed(["vera", "kemal"]);
    expect(await loadRoundFillShown(ASK)).toEqual({ wanted: 2, placed: 1 });
    expect(share.poolRoundStaffTestIds).not.toHaveBeenCalled();
  });

  it("a staff user who is also a partner volunteer in the round is counted as that, never taken off", async () => {
    dbMock.partnerAsk.findMany.mockResolvedValue([{ places: 2, volunteerUserIds: ["kemal"], pickedUserIds: [] }]);
    share.poolRoundShare.mockResolvedValue({ places: 2, userIds: ["kemal"] });
    confirmed(["kemal"]);
    expect(await loadRoundFillShown(ASK)).toEqual({ wanted: 2, placed: 1 });
  });

  it("no staff test in the round: the shown fill is the real one, no extra read", async () => {
    share.poolRoundStaffTestIds.mockResolvedValue([]);
    expect(await loadRoundFillShown(ASK)).toEqual({ wanted: 2, placed: 3 });
    expect(dbMock.attendance.count).toHaveBeenCalledTimes(1);
  });

  it("a pool-only round (the ask's own id, no partners): the same rule", async () => {
    const poolOnly = { id: "pool-ask-1", roundId: null, matchId: "m1", places: 1, volunteerUserIds: [], pickedUserIds: [] };
    share.poolRoundShare.mockResolvedValue({ places: 1, userIds: ["kemal"] });
    confirmed(["kemal"]);
    expect(await loadRoundFillShown(poolOnly)).toEqual({ wanted: 1, placed: 0 });
    expect(share.poolRoundStaffTestIds).toHaveBeenCalledWith("m1", "pool-ask-1");
  });
});
