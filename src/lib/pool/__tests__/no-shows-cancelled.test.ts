/**
 * Review of #437, 2: a game marked as not played keeps its guests' results
 * (a no-show an organiser marked comes back if the game is put back), and
 * the no-show sweep never rewrites a SETTLED result, cancelled game or not:
 * it reads, and writes, only places still unsettled.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  guestPlace: { findMany: vi.fn(), updateMany: vi.fn() },
  attendance: { findMany: vi.fn() },
}));
vi.mock("../../db", () => ({ db }));
vi.mock("../../platform-jobs", () => ({ queuePlatformDm: vi.fn() }));

import { finaliseGuestPlaces } from "../no-shows";

const NOW = new Date("2026-10-29T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  db.attendance.findMany.mockResolvedValue([]);
  db.guestPlace.updateMany.mockResolvedValue({ count: 1 });
});

describe("finaliseGuestPlaces and a cancelled game", () => {
  it("reads only unsettled places, and writes only while still unsettled", async () => {
    db.guestPlace.findMany
      .mockResolvedValueOnce([{ id: "gp1", userId: "u1", matchId: "tue", result: "booked", match: { date: new Date("2026-10-27T21:15:00Z"), status: "CANCELLED" } }])
      .mockResolvedValueOnce([]);
    await finaliseGuestPlaces(NOW);
    expect(db.guestPlace.findMany.mock.calls[0][0].where.settledAt).toBeNull();
    expect(db.guestPlace.updateMany.mock.calls[0][0].where).toMatchObject({ id: "gp1", settledAt: null });
  });
});
