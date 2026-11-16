/**
 * The owner's pool funnel (growth slice G2) leaves MatchTime staff test
 * sign-ups out of every count (Kemal, 2026-11-16; offer health in round 2
 * of #607): `PoolProfile.staffTest` profiles are not read for the funnel or
 * the paused-for-ignoring count, and the offers sent to them, and the
 * offer jobs carrying those offers, are not in the offer health, except
 * that they still fill the shared platform cap (round 7 of #607).
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
import { POOL_PLATFORM_CAPS } from "../caps";

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
    expect(wheres(dbMock.db.poolOffer.findMany)).toContainEqual({ staffTest: true });
    // By the job's own refId (the offer's id), not the offer's current platformJobId.
    expect(wheres(dbMock.db.platformJob.findMany)[0]).toMatchObject({ NOT: { refId: { in: ["offer-staff"] } } });
    // No profile is read to decide it.
    expect(wheres(dbMock.db.poolProfile.findMany).some((w) => w.staffTest === true)).toBe(false);
  });

  // Round 7 of #607: the platform cap is shared by every offer, so a staff
  // test's delivered offer still fills it; only "Offers delivered" leaves it out.
  it("offer health: a staff test's delivered offer counts towards the shared platform cap, never as delivered", async () => {
    const q = parseFunnelQuery({ from: "2026-11-10", to: "2026-11-16" }, NOW);
    const base = new Date("2026-11-12T09:00:00Z").getTime();
    dbMock.db.poolOffer.findMany.mockImplementation(async (a: Args) => {
      if (!("sentAt" in a.where)) return [];
      expect(a.where).not.toHaveProperty("staffTest");
      return Array.from({ length: POOL_PLATFORM_CAPS.perHour }, (_, i) => ({ sentAt: new Date(base + i * 60_000), staffTest: i === POOL_PLATFORM_CAPS.perHour - 1 }));
    });
    const { health } = await loadPoolFunnel(q, NOW);
    expect(health.delivered).toBe(POOL_PLATFORM_CAPS.perHour - 1);
    expect(health.platformCapHits).toBe(1);
  });

  it("with no staff-test offer anywhere, the jobs are read as before", async () => {
    await loadPoolFunnel(parseFunnelQuery({}, NOW), NOW);
    expect(wheres(dbMock.db.platformJob.findMany)[0]).not.toHaveProperty("NOT");
  });
});
