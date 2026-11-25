/**
 * The one guest writer's entry point for a game RECORDED AFTER IT WAS
 * PLAYED, with no ask (2026-11-03: the Vets' Mon 2 Nov game, played before
 * the club went live; Ibrahim Sahin of Sutton FC played as a guest). He
 * gets exactly a volunteer's marks: a guest membership (PLAYER, guestVia
 * "partner", his home club, this match), his place through
 * `registerAttendance` with cause "partner-ask", and a partner GuestPlace
 * with no ask. An ordinary member of the club is written as a member.
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

import { recordPlayedPartnerGuest } from "../partner-guest";

const A = {
  orgId: "vets",
  matchId: "m-2nov",
  userId: "ibrahim",
  fromOrgId: "sutton",
  event: { actorKind: "script" as const, actorUserId: "kemal", sourceRef: "script:x" },
};

beforeEach(() => {
  vi.clearAllMocks();
  att.registerAttendance.mockResolvedValue({ status: "CONFIRMED" });
});

describe("recordPlayedPartnerGuest", () => {
  it("a stranger to the club: a guest membership, his place as partner-ask, a partner guest place with no ask", async () => {
    dbMock.membership.findUnique.mockResolvedValue(null);
    expect(await recordPlayedPartnerGuest(A)).toEqual({ kind: "guest", status: "CONFIRMED" });
    const up = dbMock.membership.upsert.mock.calls[0][0];
    expect(up.where).toEqual({ userId_orgId: { userId: "ibrahim", orgId: "vets" } });
    expect(up.create).toEqual({ userId: "ibrahim", orgId: "vets", role: "PLAYER", guestVia: "partner", guestFromOrgId: "sutton", guestMatchId: "m-2nov" });
    expect(att.registerAttendance).toHaveBeenCalledWith("ibrahim", "m-2nov", {
      event: { cause: "partner-ask", actorKind: "script", actorUserId: "kemal", sourceRef: "script:x" },
      actorIsAdmin: true,
    });
    const gp = dbMock.guestPlace.upsert.mock.calls[0][0];
    expect(gp.create).toEqual({ orgId: "vets", matchId: "m-2nov", userId: "ibrahim", source: "partner", fromOrgId: "sutton", partnerAskId: null });
  });

  it("the guest membership is written before his place, so the place sees a guest", async () => {
    dbMock.membership.findUnique.mockResolvedValue(null);
    const order: string[] = [];
    dbMock.membership.upsert.mockImplementation(async () => void order.push("membership"));
    att.registerAttendance.mockImplementation(async () => (order.push("attendance"), { status: "CONFIRMED" }));
    await recordPlayedPartnerGuest(A);
    expect(order).toEqual(["membership", "attendance"]);
  });

  it("a past guest of the club plays on the same row, marked for this match, as a PLAYER", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ role: "ADMIN", leftAt: new Date("2026-10-01"), guestFromOrgId: "sutton", guestMatchId: "m-old", guestVia: "partner" });
    await recordPlayedPartnerGuest(A);
    expect(dbMock.membership.upsert.mock.calls[0][0].update).toEqual({ role: "PLAYER", leftAt: null, guestVia: "partner", guestFromOrgId: "sutton", guestMatchId: "m-2nov" });
  });

  it("an ordinary member of the club plays as a member: no guest marks, no guest place", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ role: "PLAYER", leftAt: null, guestFromOrgId: null, guestMatchId: null, guestVia: null });
    expect(await recordPlayedPartnerGuest(A)).toEqual({ kind: "member", status: "CONFIRMED" });
    expect(dbMock.membership.upsert).not.toHaveBeenCalled();
    expect(dbMock.guestPlace.upsert).not.toHaveBeenCalled();
    expect(att.registerAttendance.mock.calls[0][2].event.cause).toBe("partner-ask");
  });

  it("a place that did not take (DROPPED) records no guest place", async () => {
    dbMock.membership.findUnique.mockResolvedValue(null);
    att.registerAttendance.mockResolvedValue({ status: "DROPPED" });
    expect(await recordPlayedPartnerGuest(A)).toEqual({ kind: "guest", status: "DROPPED" });
    expect(dbMock.guestPlace.upsert).not.toHaveBeenCalled();
  });
});
