/**
 * The pool's candidate loader (slice L4): thin I/O around the pure rules.
 * The database is a stub; what is checked is that the switches close it
 * before any pool table is read, that the band is all the organiser's
 * loader returns, and that the rows reach the rules.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const fn = () => vi.fn().mockResolvedValue([]);
  return {
    match: { findUnique: vi.fn() },
    poolProfile: { findMany: fn() },
    venue: { findMany: fn() },
    membership: { findMany: fn() },
    attendance: { findMany: fn() },
    poolBlock: { findMany: fn() },
    poolOffer: { findMany: fn() },
    platformJob: { findMany: fn() },
    guestPlace: { findMany: fn() },
  };
});
vi.mock("../../db", () => ({ db: dbMock }));

import { findPoolCandidates, poolNearBand, poolPlatformRoom } from "../candidates";
import { POOL_PLATFORM_CAPS } from "../caps";

const NOW = new Date("2026-10-27T10:00:00Z");
const MATCH = {
  id: "m1",
  date: new Date("2026-10-27T19:00:00Z"),
  status: "UPCOMING",
  isHistorical: false,
  activity: {
    orgId: "club",
    matchDurationMins: 60,
    venueRef: { lat: 51.3618, lng: -0.1945 },
    sport: { preset: "football-7aside", name: "Football 7-a-side", playersPerTeam: 7 },
    org: { featurePlayerPool: true },
  },
};
const PROFILE = (userId: string, lat: number) => ({
  userId,
  status: "active",
  consentAt: new Date("2026-10-01T00:00:00Z"),
  maxMiles: 3,
  areaLat: lat,
  areaLng: -0.1945,
  venueIds: [],
  user: { phoneNumber: `4477009000${userId.length}` },
  sports: [{ sport: "football", formats: [7], level: null }],
  availability: [{ day: 2, fromMin: 18 * 60, toMin: 22 * 60 }],
});
const ON = { POOL_OFFERS_ENABLED: "1" };

beforeEach(() => {
  vi.clearAllMocks();
  for (const t of Object.values(dbMock)) for (const f of Object.values(t)) (f as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  dbMock.match.findUnique.mockResolvedValue(MATCH);
});

describe("the switches close the pool before any pool table is read", () => {
  it("the global switch off", async () => {
    const r = await findPoolCandidates("m1", { now: NOW, env: {} });
    expect(r.selection.gate).toBe("pool-closed");
    expect(dbMock.poolProfile.findMany).not.toHaveBeenCalled();
  });
  it("the club's flag off", async () => {
    dbMock.match.findUnique.mockResolvedValue({ ...MATCH, activity: { ...MATCH.activity, org: { featurePlayerPool: false } } });
    const r = await findPoolCandidates("m1", { now: NOW, env: ON });
    expect(r.selection.gate).toBe("pool-closed");
    expect(dbMock.poolProfile.findMany).not.toHaveBeenCalled();
  });
  it("no such match", async () => {
    dbMock.match.findUnique.mockResolvedValue(null);
    const r = await findPoolCandidates("m1", { now: NOW, env: ON });
    expect(r.selection.gate).toBe("match-not-open");
    expect(dbMock.poolProfile.findMany).not.toHaveBeenCalled();
  });
  it("a venue with no position", async () => {
    dbMock.match.findUnique.mockResolvedValue({ ...MATCH, activity: { ...MATCH.activity, venueRef: null } });
    const r = await findPoolCandidates("m1", { now: NOW, env: ON });
    expect(r.selection.gate).toBe("no-venue");
    expect(dbMock.poolProfile.findMany).not.toHaveBeenCalled();
  });
});

describe("with the pool open", () => {
  it("only active, consented profiles of the club's sport are asked for, and the rules decide the rest", async () => {
    dbMock.poolProfile.findMany.mockResolvedValue([PROFILE("near", 51.37), PROFILE("far", 51.5)]);
    dbMock.membership.findMany.mockResolvedValue([]);
    const r = await findPoolCandidates("m1", { now: NOW, env: ON });
    const where = dbMock.poolProfile.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: "active", userId: { not: null }, consentAt: { not: null }, sports: { some: { sport: "football" } } });
    expect(r.selection.eligible.map((e) => e.userId)).toEqual(["near"]);
    expect(r.selection.excluded).toEqual({ "too-far": 1 });
    expect(r.sendAt).toEqual(NOW);
  });

  it("a member of the asking club is excluded (live, non-guest membership)", async () => {
    dbMock.poolProfile.findMany.mockResolvedValue([PROFILE("near", 51.37)]);
    dbMock.membership.findMany.mockResolvedValue([{ userId: "near" }]);
    const r = await findPoolCandidates("m1", { now: NOW, env: ON });
    expect(dbMock.membership.findMany.mock.calls[0][0].where).toMatchObject({ orgId: "club", leftAt: null, guestMatchId: null });
    expect(r.selection.excluded).toEqual({ "club-member": 1 });
  });

  it("no profile at all: no further queries", async () => {
    const r = await findPoolCandidates("m1", { now: NOW, env: ON });
    expect(r.selection.eligible).toEqual([]);
    expect(dbMock.membership.findMany).not.toHaveBeenCalled();
  });
});

describe("poolNearBand: the organiser gets a band and nothing else", () => {
  it("a bare band string", async () => {
    dbMock.poolProfile.findMany.mockResolvedValue([PROFILE("a", 51.37), PROFILE("bb", 51.365)]);
    const band = await poolNearBand("m1", { now: NOW, env: ON });
    expect(band).toBe("few");
    expect(JSON.stringify(band)).not.toMatch(/"a"|bb|4477/);
  });
  it("the pool closed: none", async () => {
    expect(await poolNearBand("m1", { now: NOW, env: {} })).toBe("none");
  });
});

describe("poolPlatformRoom", () => {
  it("counts sent pool offers in the last day", async () => {
    dbMock.poolOffer.findMany.mockResolvedValue(Array.from({ length: 5 }, (_, i) => ({ sentAt: new Date(NOW.getTime() - i * 60_000) })));
    expect(await poolPlatformRoom(NOW)).toBe(POOL_PLATFORM_CAPS.perHour - 5);
    expect(dbMock.poolOffer.findMany.mock.calls[0][0].where).toMatchObject({ sentAt: { not: null } });
  });
});
