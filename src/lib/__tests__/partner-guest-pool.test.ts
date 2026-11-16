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

import { placeFriendGuest, placePoolGuest } from "../partner-guest";

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

// Round 4 of #607: the place carries the staff flag itself, so an erased
// staff-test profile's place stays out of every count.
describe("the guest place carries the staff test flag", () => {
  beforeEach(() => dbMock.membership.findUnique.mockResolvedValue(null));

  it("an offer to a staff test: his place is a staff test's, on create and on update", async () => {
    await placePoolGuest({ ...W, staffTest: true });
    const args = dbMock.guestPlace.upsert.mock.calls[0][0];
    expect(args.create).toMatchObject({ source: "pool", poolOfferId: "o1", staffTest: true });
    expect(args.update).toMatchObject({ staffTest: true });
  });

  it("anybody else's: false", async () => {
    await placePoolGuest(W);
    const args = dbMock.guestPlace.upsert.mock.calls[0][0];
    expect(args.create).toMatchObject({ staffTest: false });
    expect(args.update).toMatchObject({ staffTest: false });
  });

  it("a friend link's sign-up ticked as a staff test: the place is a staff test's, whoever confirmed it", async () => {
    await placeFriendGuest({ linkId: "l1", userId: "ali", orgId: "fnf", matchId: "m2", benchPickMode: "organiser", issuedByUserId: "u-member", staffTest: true });
    expect(dbMock.guestPlace.upsert.mock.calls[0][0].create).toMatchObject({ friendLinkId: "l1", staffTest: true });
  });
});
