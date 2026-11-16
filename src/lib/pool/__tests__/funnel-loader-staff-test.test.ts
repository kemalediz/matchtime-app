/**
 * The owner's pool funnel (growth slice G2) leaves MatchTime staff test
 * sign-ups out of every count (Kemal, 2026-11-16): `PoolProfile.staffTest`
 * profiles are not read, neither for the funnel itself nor for the offer
 * health's paused-for-ignoring count.
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

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(dbMock.db)) for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

describe("loadPoolFunnel: no staff test sign-up in any count", () => {
  it("reads only profiles that are not staff tests, for the funnel and for the paused count", async () => {
    const now = new Date("2026-11-16T12:00:00Z");
    await loadPoolFunnel(parseFunnelQuery({}, now), now);
    const calls = dbMock.db.poolProfile.findMany.mock.calls.map((c) => c[0] as { where?: Record<string, unknown> });
    expect(calls).toHaveLength(2);
    for (const args of calls) expect(args.where).toMatchObject({ staffTest: false });
    expect(calls.some((a) => a.where?.status === "paused" && a.where?.pausedReason === "ignored")).toBe(true);
  });
});
