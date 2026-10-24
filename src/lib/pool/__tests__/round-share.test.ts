/**
 * One round, partners and the pool together (slice L5a): the round's
 * number covers both, and a pool guest with a place counts toward it, so
 * the partner sweep closes the partner asks when the pool fills the last
 * place, and the other way round.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  partnerAsk: { findMany: vi.fn() },
  poolAsk: { findMany: vi.fn() },
  poolOffer: { findMany: vi.fn() },
  attendance: { count: vi.fn() },
}));
vi.mock("../../db", () => ({ db: dbMock }));

import { loadRoundFill } from "../../partner-ask-round";
import { poolRoundShare } from "../round-share";

const PARTNER = { id: "pa1", roundId: "r1", matchId: "m1", places: 2, volunteerUserIds: ["vol1"], pickedUserIds: [] };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.partnerAsk.findMany.mockResolvedValue([{ places: 2, volunteerUserIds: ["vol1"], pickedUserIds: [] }]);
  dbMock.poolAsk.findMany.mockResolvedValue([{ id: "poolask1", places: 2 }]);
  dbMock.poolOffer.findMany.mockResolvedValue([{ userId: "ali" }]);
  dbMock.attendance.count.mockImplementation(({ where }: { where: { userId: { in: string[] } } }) =>
    Promise.resolve(where.userId.in.filter((u) => u === "vol1" || u === "ali").length),
  );
});

describe("poolRoundShare", () => {
  it("the pool ask's number and who accepted, found by the round id or its own id", async () => {
    expect(await poolRoundShare("m1", "r1")).toEqual({ places: 2, userIds: ["ali"] });
    expect(dbMock.poolAsk.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { matchId: "m1", OR: [{ roundId: "r1" }, { id: "r1" }] } }));
    expect(dbMock.poolOffer.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { poolAskId: { in: ["poolask1"] }, outcome: "accepted" } }));
  });
  it("no pool ask in the round: null", async () => {
    dbMock.poolAsk.findMany.mockResolvedValue([]);
    expect(await poolRoundShare("m1", "r1")).toBeNull();
  });
  it("a failed read never breaks the partner round: null", async () => {
    dbMock.poolAsk.findMany.mockRejectedValue(new Error("db down"));
    expect(await poolRoundShare("m1", "r1")).toBeNull();
  });
});

describe("loadRoundFill counts the pool", () => {
  it("a partner volunteer and a pool guest with places fill a round of 2", async () => {
    expect(await loadRoundFill(PARTNER)).toEqual({ wanted: 2, placed: 2 });
    expect(dbMock.attendance.count.mock.calls[0][0].where.userId.in.sort()).toEqual(["ali", "vol1"]);
  });
  it("without a pool ask, exactly as before", async () => {
    dbMock.poolAsk.findMany.mockResolvedValue([]);
    expect(await loadRoundFill(PARTNER)).toEqual({ wanted: 2, placed: 1 });
  });
  it("a pool-only round (no partner ask): the pool ask's own id is the key", async () => {
    dbMock.partnerAsk.findMany.mockResolvedValue([]);
    dbMock.poolAsk.findMany.mockResolvedValue([{ id: "poolask9", places: 1 }]);
    const fill = await loadRoundFill({ id: "poolask9", roundId: null, matchId: "m1", places: 1, volunteerUserIds: [], pickedUserIds: [] });
    expect(fill).toEqual({ wanted: 1, placed: 1 });
    expect(dbMock.poolAsk.findMany.mock.calls[0][0].where.OR).toEqual([{ roundId: "poolask9" }, { id: "poolask9" }]);
  });
});
