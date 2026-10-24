/**
 * A guest after the ask, and after the match (cross-club ask, slice S4,
 * plan 3.10; Kemal's decisions of 2026-10-16).
 *
 *   - the ask closes: volunteers without a place are stood down (bench row
 *     dropped, past guest, one thank-you DM in their club's language);
 *     the one who got a place keeps it and is recorded as picked;
 *   - the morning after the match a guest becomes a PAST guest: the
 *     membership is KEPT, closed with `leftAt`, never deleted;
 *   - "Add to FNF" makes him an ordinary member.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  partnerAsk: { findUnique: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  organisation: { findUnique: vi.fn() },
  attendance: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  membership: { findMany: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
  match: { findMany: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
const att = vi.hoisted(() => ({ registerAttendance: vi.fn(), cancelAttendance: vi.fn() }));
vi.mock("../attendance", () => att);
vi.mock("../admin-channel", () => ({ sendAdminNotice: vi.fn() }));

import { keepGuestAsMember, retirePastGuests, standDownVolunteers } from "../partner-guest";
import { isPastGuestDue, pastGuestAt } from "../partner-volunteer-rules";

const NOW = new Date("2026-10-30T21:40:00Z");
const KICKOFF = new Date("2026-10-30T20:30:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.partnerAsk.findUnique.mockResolvedValue({
    id: "ask1",
    matchId: "m-fnf",
    askerOrgId: "fnf",
    partnerOrgId: "sutton",
    volunteerUserIds: ["ali", "bob"],
    match: { date: KICKOFF },
  });
  dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === "fnf" ? { name: "FNF" } : { id: "sutton", language: "en" }),
  );
  dbMock.attendance.findMany.mockResolvedValue([
    { userId: "ali", status: "CONFIRMED" },
    { userId: "bob", status: "BENCH" },
  ]);
  dbMock.user.findMany.mockResolvedValue([
    { id: "ali", phoneNumber: "+447700900111" },
    { id: "bob", phoneNumber: "+447700900222" },
  ]);
  dbMock.membership.updateMany.mockResolvedValue({ count: 1 });
  // Both are this ask's own guests (review M5), on no other open ask (L4).
  dbMock.membership.findMany.mockResolvedValue([
    { userId: "ali", guestFromOrgId: "sutton", guestMatchId: "m-fnf", leftAt: null },
    { userId: "bob", guestFromOrgId: "sutton", guestMatchId: "m-fnf", leftAt: null },
  ]);
  dbMock.partnerAsk.count.mockResolvedValue(0);
});

describe("standDownVolunteers: the ask has closed", () => {
  it("the picked one keeps his place; the other is stood down, becomes a past guest and is thanked", async () => {
    expect(await standDownVolunteers("ask1", "filled", NOW)).toEqual({ thanked: 1, picked: 1 });
    expect(att.cancelAttendance).toHaveBeenCalledTimes(1);
    expect(att.cancelAttendance).toHaveBeenCalledWith("bob", "m-fnf", expect.objectContaining({ cause: "partner-ask", actorKind: "system" }));
    expect(dbMock.membership.updateMany).toHaveBeenCalledWith({
      where: { userId: "bob", orgId: "fnf", guestMatchId: "m-fnf", leftAt: null },
      data: { leftAt: NOW },
    });
    // Kept, never deleted.
    expect(dbMock.membership.delete).not.toHaveBeenCalled();
    expect(dbMock.membership.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.botJob.create).toHaveBeenCalledWith({
      data: { orgId: "sutton", kind: "dm", phone: "447700900222", text: "*FNF* have their player now. Thanks for offering 🙏" },
    });
    expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith({ where: { id: "ask1" }, data: { pickedUserIds: ["ali"] } });
  });

  it("the game is off: everyone is stood down and told the game is off", async () => {
    expect(await standDownVolunteers("ask1", "match-cancelled", NOW)).toEqual({ thanked: 2, picked: 0 });
    expect(dbMock.botJob.create.mock.calls.every((c) => /is off now/.test(c[0].data.text))).toBe(true);
  });

  it("no volunteers: nothing at all", async () => {
    dbMock.partnerAsk.findUnique.mockResolvedValue({ id: "ask1", volunteerUserIds: [] });
    expect(await standDownVolunteers("ask1", "kickoff", NOW)).toEqual({ thanked: 0, picked: 0 });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });
});

describe("past guests (Kemal, 2026-10-16): kept, closed for the squad", () => {
  it("the morning after, at the rolling squad's hour, London time, either side of the clock change", () => {
    // Fri 23 Oct 20:30 BST: Sat 24 Oct 08:00 BST = 07:00 UTC.
    expect(pastGuestAt(new Date("2026-10-23T19:30:00Z")).toISOString()).toBe("2026-10-24T07:00:00.000Z");
    // Sat 24 Oct 20:30 BST: Sun 25 Oct 08:00 GMT (after the change).
    expect(pastGuestAt(new Date("2026-10-24T19:30:00Z")).toISOString()).toBe("2026-10-25T08:00:00.000Z");
    expect(isPastGuestDue({ kickoff: KICKOFF, status: "COMPLETED", now: NOW })).toBe(false);
    expect(isPastGuestDue({ kickoff: KICKOFF, status: "COMPLETED", now: new Date("2026-10-31T08:00:00Z") })).toBe(true);
    expect(isPastGuestDue({ kickoff: KICKOFF, status: "CANCELLED", now: NOW })).toBe(true);
  });

  it("retirePastGuests sets leftAt on guests whose match is over, and nobody else", async () => {
    dbMock.membership.findMany.mockResolvedValue([
      { id: "mem-done", guestMatchId: "m-old" },
      { id: "mem-next", guestMatchId: "m-new" },
    ]);
    dbMock.match.findMany.mockResolvedValue([
      { id: "m-old", date: new Date("2026-10-29T20:30:00Z"), status: "COMPLETED" },
      { id: "m-new", date: new Date("2026-10-31T20:30:00Z"), status: "UPCOMING" },
    ]);
    expect(await retirePastGuests("fnf", new Date("2026-10-30T09:00:00Z"))).toBe(1);
    expect(dbMock.membership.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["mem-done"] }, leftAt: null }, data: { leftAt: new Date("2026-10-30T09:00:00Z") } });
  });

  it("no guests: one read, no write", async () => {
    dbMock.membership.findMany.mockResolvedValue([]);
    expect(await retirePastGuests("fnf", NOW)).toBe(0);
    expect(dbMock.membership.updateMany).not.toHaveBeenCalled();
  });
});

describe("Add to FNF", () => {
  it("clears both guest marks and leftAt: an ordinary member", async () => {
    expect(await keepGuestAsMember("fnf", "ali")).toBe(true);
    expect(dbMock.membership.updateMany).toHaveBeenCalledWith({
      where: { orgId: "fnf", userId: "ali", guestMatchId: { not: null } },
      data: { role: "PLAYER", guestVia: null, guestFromOrgId: null, guestMatchId: null, leftAt: null },
    });
  });
});
