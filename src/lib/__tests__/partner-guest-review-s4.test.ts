/**
 * The review of the cross-club stack, findings that belong to slice S4.
 *
 *   M5  standing an ask down touches only the guests IT registered: never
 *       an ordinary member who volunteered, never a bench row from before;
 *   L4  a volunteer still on another open ask for the same match is not
 *       stood down; a live guest mark is never overwritten;
 *   H3  a moved game keeps its picked guests and tells them the new time;
 *   L1  a picked guest's plain IN for his own club's game at an
 *       overlapping time is refused with one short reply.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  partnerAsk: { findUnique: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  organisation: { findUnique: vi.fn() },
  attendance: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  membership: { findMany: vi.fn(), updateMany: vi.fn() },
  match: { findMany: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
const att = vi.hoisted(() => ({ registerAttendance: vi.fn(), cancelAttendance: vi.fn() }));
vi.mock("../attendance", () => att);
vi.mock("../admin-channel", () => ({ sendAdminNotice: vi.fn() }));

import { standDownVolunteers, tellGuestsMoved } from "../partner-guest";
import { decide } from "../pipeline/engine";
import { compose } from "../pipeline/compose";
import { NOW, attendanceFacts, claim, msg, world } from "../pipeline/__tests__/helpers";

const KICKOFF = new Date("2026-10-30T20:30:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.partnerAsk.findUnique.mockResolvedValue({
    id: "ask1",
    matchId: "m-fnf",
    askerOrgId: "fnf",
    partnerOrgId: "sutton",
    volunteerUserIds: ["guest", "member", "other"],
    match: { date: KICKOFF },
  });
  dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === "fnf" ? { name: "FNF" } : { id: "sutton", language: "en" }),
  );
  dbMock.attendance.findMany.mockResolvedValue([
    { userId: "guest", status: "BENCH" },
    { userId: "member", status: "BENCH" },
    { userId: "other", status: "BENCH" },
  ]);
  dbMock.user.findMany.mockResolvedValue([
    { id: "guest", phoneNumber: "+1" },
    { id: "member", phoneNumber: "+2" },
    { id: "other", phoneNumber: "+3" },
  ]);
  dbMock.membership.findMany.mockResolvedValue([
    { userId: "guest", guestFromOrgId: "sutton", guestMatchId: "m-fnf", leftAt: null },
    { userId: "member", guestFromOrgId: null, guestMatchId: null, leftAt: null },
    { userId: "other", guestFromOrgId: "sutton", guestMatchId: "m-fnf", leftAt: null },
  ]);
  dbMock.partnerAsk.count.mockImplementation(({ where }: { where: { volunteerUserIds: { has: string } } }) =>
    Promise.resolve(where.volunteerUserIds.has === "other" ? 1 : 0),
  );
  dbMock.membership.updateMany.mockResolvedValue({ count: 1 });
});

describe("M5 and L4: standing an ask down", () => {
  it("only this ask's own guest is stood down; the ordinary member and the volunteer on another open ask are untouched", async () => {
    expect(await standDownVolunteers("ask1", "filled", NOW)).toEqual({ thanked: 1, picked: 0 });
    expect(att.cancelAttendance).toHaveBeenCalledTimes(1);
    expect(att.cancelAttendance).toHaveBeenCalledWith("guest", "m-fnf", expect.anything());
    expect(dbMock.botJob.create).toHaveBeenCalledTimes(1);
  });
});

describe("H3: a moved game", () => {
  it("its guests with a place keep it and are told the new time, in their club's language", async () => {
    dbMock.attendance.findMany.mockResolvedValue([
      { userId: "guest", status: "CONFIRMED" },
      { userId: "other", status: "DROPPED" },
    ]);
    await tellGuestsMoved("ask1", NOW);
    expect(att.cancelAttendance).not.toHaveBeenCalled();
    expect(dbMock.membership.updateMany).not.toHaveBeenCalled();
    expect(dbMock.botJob.create).toHaveBeenCalledTimes(1);
    expect(dbMock.botJob.create.mock.calls[0][0].data.text).toContain("has moved");
  });
});

describe("L1: a picked guest's IN for his own overlapping game", () => {
  it("is refused with one reply and writes nothing", () => {
    const s = { ...world({ confirmed: ["kemal"] }), guestElsewhere: { "u-sait": { askerName: "FNF" } } };
    const r = decide({ now: NOW, state: s, messages: [msg({ id: "wa-1", from: "sait", body: "IN", route: "self_att", facts: attendanceFacts([claim()]) })] });
    expect(r.writes).toEqual([]);
    expect(r.speech).toEqual([{ kind: "partner_guest_overlap", messageId: "wa-1", askerName: "FNF" }]);
    expect(compose(r).utterances[0].text).toContain("FNF");
  });
  it("his OUT for his own game is not refused", () => {
    const s = { ...world({ confirmed: ["kemal", "sait"] }), guestElsewhere: { "u-sait": { askerName: "FNF" } } };
    const r = decide({ now: NOW, state: s, messages: [msg({ id: "wa-1", from: "sait", body: "OUT", route: "self_att", facts: attendanceFacts([claim({ polarity: "out" })]) })] });
    expect(r.writes[0]).toMatchObject({ kind: "attendance", userId: "u-sait", status: "DROPPED" });
  });
});
