/**
 * The owner's safety page leaves MatchTime staff test sign-ups
 * (`PoolProfile.staffTest`) out of its paused list (round 2 of #607).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  db: {
    poolReport: { findMany: vi.fn() },
    poolProfile: { findMany: vi.fn() },
    guestPlace: { findMany: vi.fn() },
    organisation: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));
vi.mock("../../db", () => dbMock);

import { loadPoolSafety } from "../safety";

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(dbMock.db)) for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

describe("loadPoolSafety", () => {
  it("lists only paused profiles that are not staff tests", async () => {
    await loadPoolSafety(new Date("2026-11-16T12:00:00Z"));
    const where = (dbMock.db.poolProfile.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ staffTest: false });
    expect(where.pausedReason).toBeDefined();
  });
});
