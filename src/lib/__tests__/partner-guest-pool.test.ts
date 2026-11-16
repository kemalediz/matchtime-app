/**
 * The one guest writer's POOL entry point (L5a; review of #400, M1 and
 * minor 6): a pool guest's row is always a PLAYER, and a person who is
 * already this club's live guest for ANOTHER match is not written (one
 * row carries one guest match).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  membership: { findUnique: vi.fn(), upsert: vi.fn() },
  guestPlace: { upsert: vi.fn() },
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
}));
vi.mock("../db", () => ({ db: dbMock }));
const att = vi.hoisted(() => ({ registerAttendance: vi.fn(), cancelAttendance: vi.fn() }));
vi.mock("../attendance", () => att);
vi.mock("../admin-channel", () => ({ sendAdminNotice: vi.fn() }));
vi.mock("../partner-guest-standing", () => ({ loadGuestStandings: vi.fn() }));

import { placePoolGuest } from "../partner-guest";

const W = { offerId: "o1", userId: "ali", orgId: "fnf", matchId: "m2", benchPickMode: "organiser", fill: async () => ({ wanted: 1, placed: 0 }), now: new Date() };

beforeEach(() => {
  vi.clearAllMocks();
  att.registerAttendance.mockResolvedValue({ status: "BENCH" });
});

describe("placePoolGuest", () => {
  it("a former ADMIN who left is written back as a PLAYER guest (M1)", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ leftAt: new Date("2026-09-01"), guestFromOrgId: null, guestMatchId: null, guestVia: null });
    expect(await placePoolGuest(W)).toEqual({ kind: "bench", roundNowFull: false });
    expect(dbMock.membership.upsert.mock.calls[0][0].update).toMatchObject({ role: "PLAYER", guestVia: "pool", guestMatchId: "m2", leftAt: null });
    expect(dbMock.membership.upsert.mock.calls[0][0].create).toMatchObject({ role: "PLAYER", guestVia: "pool" });
  });

  it("already this club's live guest for ANOTHER match: nothing written (minor 6)", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ leftAt: null, guestFromOrgId: "sutton", guestMatchId: "m1", guestVia: "partner" });
    expect(await placePoolGuest(W)).toEqual({ kind: "elsewhere" });
    expect(dbMock.membership.upsert).not.toHaveBeenCalled();
    expect(att.registerAttendance).not.toHaveBeenCalled();
    expect(dbMock.guestPlace.upsert).not.toHaveBeenCalled();
  });

  it("a live guest for THIS match keeps his marks", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ leftAt: null, guestFromOrgId: null, guestMatchId: "m2", guestVia: "pool" });
    await placePoolGuest(W);
    expect(dbMock.membership.upsert.mock.calls[0][0].update).toEqual({});
  });
});
