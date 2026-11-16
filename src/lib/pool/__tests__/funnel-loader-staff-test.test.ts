/**
 * The owner's pool funnel (growth slice G2) leaves MatchTime staff test
 * sign-ups out of every count (Kemal, 2026-11-16; offer health in round 2
 * of #607): `PoolProfile.staffTest` profiles are not read for the funnel or
 * the paused-for-ignoring count, and the offers sent to them, and the
 * offer jobs carrying those offers, are not in the offer health.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  db: {
    poolProfile: { findMany: vi.fn() },
    poolOffer: { findMany: vi.fn(), groupBy: vi.fn() },
    guestPlace: { findMany: vi.fn() },
    match: { findMany: vi.fn() },
    attendance: { findMany: vi.fn() },
    membership: { findMany: vi.fn() },
    platformJob: { findMany: vi.fn() },
    poolCampaign: { findMany: vi.fn() },
  },
}));
vi.mock("../../db", () => dbMock);

import { loadPoolFunnel } from "../funnel-loader";
import { parseFunnelQuery } from "../funnel-rules";

const NOW = new Date("2026-11-16T12:00:00Z");
type Args = { where: Record<string, unknown> };
const wheres = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => (c[0] as Args).where);

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(dbMock.db)) for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

describe("loadPoolFunnel: no staff test sign-up in any count", () => {
  it("reads only profiles that are not staff tests, for the funnel and for the paused count", async () => {
    await loadPoolFunnel(parseFunnelQuery({}, NOW), NOW);
    const counted = wheres(dbMock.db.poolProfile.findMany).filter((w) => w.staffTest === false);
    expect(counted).toHaveLength(2);
    expect(counted.some((w) => w.status === "paused" && w.pausedReason === "ignored")).toBe(true);
  });

  // Round 4: read off the offer's own flag, so an erased staff-test profile
  // (its offers stay) never comes back into the offer health.
  // Round 5: an offer that is RESET for a new ask (its first DM never went)
  // loses its platformJobId, but every job it ever had names it by refId.
  // So a staff test's old failed job never comes back into "capped" or the
  // quiet-hour holds.
  it("offer health: a staff test's offers, and every job that carried one, even after a reset, are left out by the offer's own flag", async () => {
    dbMock.db.poolOffer.findMany.mockImplementation(async (a: Args) => (a.where.staffTest === true ? [{ id: "offer-staff" }] : []));
    await loadPoolFunnel(parseFunnelQuery({}, NOW), NOW);
    const delivered = wheres(dbMock.db.poolOffer.findMany).find((w) => "sentAt" in w);
    expect(delivered).toMatchObject({ staffTest: false });
    expect(wheres(dbMock.db.poolOffer.findMany)).toContainEqual({ staffTest: true });
    // By the job's own refId (the offer's id), not the offer's current platformJobId.
    expect(wheres(dbMock.db.platformJob.findMany)[0]).toMatchObject({ NOT: { refId: { in: ["offer-staff"] } } });
    // No profile is read to decide it.
    expect(wheres(dbMock.db.poolProfile.findMany).some((w) => w.staffTest === true)).toBe(false);
  });

  // Round 5: the funnel's "played" and "became members" read guest places;
  // a staff test's place (a real person booked by a staff test's link) is
  // not a game for them.
  it("the funnel's games leave out a staff test's guest place", async () => {
    dbMock.db.poolProfile.findMany.mockImplementation(async (a: Args) => (a.where.staffTest === false && !("status" in a.where) ? [{ userId: "u1", createdAt: NOW, status: "active", sports: [] }] : []));
    await loadPoolFunnel(parseFunnelQuery({}, NOW), NOW);
    expect(wheres(dbMock.db.guestPlace.findMany)[0]).toMatchObject({ userId: { in: ["u1"] }, source: "pool", staffTest: false });
  });

  it("with no staff-test offer anywhere, the jobs are read as before", async () => {
    await loadPoolFunnel(parseFunnelQuery({}, NOW), NOW);
    expect(wheres(dbMock.db.platformJob.findMany)[0]).not.toHaveProperty("NOT");
  });
});
