/**
 * `loadGuestStandings`: a partner guest's standing at HIS OWN club, read
 * from that club's ratings only, and his number only when that club shares.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findMany: vi.fn() },
  membership: { findMany: vi.fn() },
  rating: { findMany: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));

import { loadGuestStandings } from "../partner-guest-standing";

/** Ratings at the home club: one row per score, newest first. */
const rows = (byPlayer: Record<string, number[]>) =>
  Object.entries(byPlayer).flatMap(([playerId, scores]) => scores.map((score, i) => ({ playerId, matchId: `m${i}`, score })));

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.organisation.findMany.mockResolvedValue([{ id: "fmc", name: "Friday MT Community", sharePlayerRatingsWithPartners: false }]);
  dbMock.membership.findMany.mockResolvedValue(["c1", "a", "b", "c", "d", "e"].map((userId) => ({ userId, orgId: "fmc" })));
  dbMock.rating.findMany.mockResolvedValue(rows({ c1: [9, 9], a: [5], b: [6], c: [7], d: [8], e: [6.5] }));
});

describe("loadGuestStandings", () => {
  it("bands him among his own club's rated members, without his number when the club does not share", async () => {
    const r = await loadGuestStandings([{ userId: "c1", homeOrgId: "fmc" }]);
    expect(r.get("c1")).toEqual({ club: "Friday MT Community", band: "top", rating: null });
  });

  it("with the club's opt-in on, his actual club rating comes too", async () => {
    dbMock.organisation.findMany.mockResolvedValue([{ id: "fmc", name: "Friday MT Community", sharePlayerRatingsWithPartners: true }]);
    const r = await loadGuestStandings([{ userId: "c1", homeOrgId: "fmc" }]);
    expect(r.get("c1")).toEqual({ club: "Friday MT Community", band: "top", rating: 9 });
  });

  it("reads only the home club's ratings, of its current ordinary members", async () => {
    await loadGuestStandings([{ userId: "c1", homeOrgId: "fmc" }]);
    expect(dbMock.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: { in: ["fmc"] }, leftAt: null, guestMatchId: null } }),
    );
    const where = dbMock.rating.findMany.mock.calls[0][0].where;
    expect(where.match).toEqual({ activity: { orgId: "fmc" } });
    expect(where.playerId.in).toEqual(expect.arrayContaining(["c1", "a"]));
  });

  it("no rating at his club: not rated yet, and no number even when sharing", async () => {
    dbMock.organisation.findMany.mockResolvedValue([{ id: "fmc", name: "Friday MT Community", sharePlayerRatingsWithPartners: true }]);
    dbMock.rating.findMany.mockResolvedValue(rows({ a: [5], b: [6], c: [7], d: [8], e: [6.5] }));
    const r = await loadGuestStandings([{ userId: "c1", homeOrgId: "fmc" }]);
    expect(r.get("c1")).toEqual({ club: "Friday MT Community", band: "unrated", rating: null });
  });

  it("a club with too few rated players: no band", async () => {
    dbMock.rating.findMany.mockResolvedValue(rows({ c1: [7], a: [5] }));
    const r = await loadGuestStandings([{ userId: "c1", homeOrgId: "fmc" }]);
    expect(r.get("c1")?.band).toBe("too-few");
  });

  it("nothing to read: an empty map, no query", async () => {
    expect((await loadGuestStandings([])).size).toBe(0);
    expect(dbMock.rating.findMany).not.toHaveBeenCalled();
  });

  it("a failed read never throws: the caller simply has no standing", async () => {
    dbMock.rating.findMany.mockRejectedValue(new Error("db down"));
    expect((await loadGuestStandings([{ userId: "c1", homeOrgId: "fmc" }])).size).toBe(0);
  });
});
