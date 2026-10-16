/**
 * A partner club's player volunteers (cross-club ask, slice S3):
 * `handlePartnerVolunteer`, the one writer onto another club's match.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  partnerAsk: { findUnique: vi.fn(), updateMany: vi.fn() },
  sentNotification: { create: vi.fn() },
  $executeRaw: vi.fn(),
  organisation: { findUnique: vi.fn() },
  membership: { findUnique: vi.fn(), upsert: vi.fn() },
  attendance: { findUnique: vi.fn(), findMany: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
const att = vi.hoisted(() => ({ registerAttendance: vi.fn(), cancelAttendance: vi.fn() }));
vi.mock("../attendance", () => att);
const notice = vi.hoisted(() => ({ sendAdminNotice: vi.fn() }));
vi.mock("../admin-channel", () => notice);

import { handlePartnerVolunteer } from "../partner-guest";

const KICKOFF = new Date("2026-10-30T20:30:00Z");
const NOW = new Date("2026-10-30T15:00:00Z");
const ASK = {
  id: "ask1",
  status: "posted",
  closesAt: KICKOFF,
  askerOrgId: "fnf",
  partnerOrgId: "sutton",
  matchId: "m-fnf",
  volunteerUserIds: [] as string[],
  match: { date: KICKOFF, status: "UPCOMING", activity: { matchDurationMins: 60 } },
};
const write = (over: Partial<Parameters<typeof handlePartnerVolunteer>[0]> = {}) => ({
  askId: "ask1",
  userId: "ali",
  name: "Ali Kaya",
  polarity: "in" as const,
  sourceMessageId: "wa-1",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.partnerAsk.findUnique.mockResolvedValue(ASK);
  dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === "fnf" ? { id: "fnf", name: "FNF", language: "en" } : { id: "sutton", name: "Sutton FC", language: "tr" }),
  );
  dbMock.membership.findUnique.mockImplementation(({ where }: { where: { userId_orgId: { orgId: string } } }) =>
    Promise.resolve(where.userId_orgId.orgId === "sutton" ? { leftAt: null, guestFromOrgId: null } : null),
  );
  dbMock.attendance.findUnique.mockResolvedValue(null);
  dbMock.attendance.findMany.mockResolvedValue([]);
  att.registerAttendance.mockResolvedValue({ status: "BENCH" });
  dbMock.partnerAsk.updateMany.mockResolvedValue({ count: 1 });
  notice.sendAdminNotice.mockResolvedValue({ channel: "dm", queued: 1 });
  dbMock.sentNotification.create.mockResolvedValue({});
});

describe("handlePartnerVolunteer", () => {
  it("IN: a guest membership in the asking club, a row on ITS match with cause partner-ask, recorded on the ask, both sides told", async () => {
    const r = await handlePartnerVolunteer(write(), NOW);
    expect(r).toMatchObject({ ok: true, outcome: "registered-bench" });
    expect(dbMock.membership.upsert).toHaveBeenCalledWith({
      where: { userId_orgId: { userId: "ali", orgId: "fnf" } },
      create: { userId: "ali", orgId: "fnf", role: "PLAYER", guestFromOrgId: "sutton", guestMatchId: "m-fnf" },
      update: { leftAt: null, guestFromOrgId: "sutton", guestMatchId: "m-fnf" },
    });
    expect(att.registerAttendance).toHaveBeenCalledWith("ali", "m-fnf", {
      event: expect.objectContaining({ cause: "partner-ask", actorKind: "player", actorUserId: "ali", sourceRef: "xask:ask1" }),
      actorIsAdmin: false,
    });
    // Review M7: the volunteer is claimed on the ask FIRST, and only while it is open.
    expect(dbMock.partnerAsk.updateMany).toHaveBeenCalledWith({
      where: { id: "ask1", status: "posted", closesAt: { gt: NOW }, NOT: { volunteerUserIds: { has: "ali" } } },
      data: { volunteerUserIds: { push: "ali" } },
    });
    expect(dbMock.partnerAsk.updateMany.mock.invocationCallOrder[0]).toBeLessThan(att.registerAttendance.mock.invocationCallOrder[0]);
    // His reply is in HIS club's language (Turkish here); the asking club's notice in its own.
    expect(r.replyText).toContain("FNF* yedek listesindesin");
    expect(notice.sendAdminNotice).toHaveBeenCalledWith(expect.objectContaining({ orgId: "fnf", text: expect.stringContaining("Ali Kaya (Sutton FC) answered your ask") }));
  });

  it("an ordinary member of the asking club already: an ordinary IN, no guest mark", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ id: "mem", leftAt: null, guestFromOrgId: null });
    await handlePartnerVolunteer(write(), NOW);
    expect(dbMock.membership.upsert).not.toHaveBeenCalled();
    expect(att.registerAttendance).toHaveBeenCalled();
  });

  it("a closed ask: one reply, nothing written", async () => {
    dbMock.partnerAsk.findUnique.mockResolvedValue({ ...ASK, status: "filled" });
    const r = await handlePartnerVolunteer(write(), NOW);
    expect(r.outcome).toBe("closed");
    expect(att.registerAttendance).not.toHaveBeenCalled();
    expect(dbMock.membership.upsert).not.toHaveBeenCalled();
  });

  it("after kickoff the ask takes nobody, even before the sweep has closed it", async () => {
    const r = await handlePartnerVolunteer(write(), KICKOFF);
    expect(r.outcome).toBe("closed");
  });

  it("an unknown sender, or not a member of the partner club: never signed up", async () => {
    expect((await handlePartnerVolunteer(write({ userId: null }), NOW)).outcome).toBe("unknown-sender");
    dbMock.membership.findUnique.mockResolvedValue(null);
    expect((await handlePartnerVolunteer(write(), NOW)).outcome).toBe("unknown-sender");
    expect(att.registerAttendance).not.toHaveBeenCalled();
  });

  it("in his own club's game at an overlapping time: refused, with the time", async () => {
    dbMock.attendance.findMany.mockResolvedValue([{ match: { date: new Date("2026-10-30T20:00:00Z"), activity: { matchDurationMins: 60 } } }]);
    const r = await handlePartnerVolunteer(write(), NOW);
    expect(r.outcome).toBe("overlap");
    expect(r.replyText).toContain("20:00");
    expect(att.registerAttendance).not.toHaveBeenCalled();
  });

  it("OUT takes his row off the asking club's match and off the ask, atomically (review M7)", async () => {
    dbMock.attendance.findUnique.mockResolvedValue({ status: "BENCH" });
    dbMock.partnerAsk.findUnique.mockResolvedValue({ ...ASK, volunteerUserIds: ["ali", "bob"] });
    const r = await handlePartnerVolunteer(write({ polarity: "out" }), NOW);
    expect(r.outcome).toBe("withdrawn");
    expect(att.cancelAttendance).toHaveBeenCalledWith("ali", "m-fnf", expect.objectContaining({ cause: "partner-ask" }));
    // array_remove in SQL, never a rewrite from a stale read.
    expect(dbMock.$executeRaw).toHaveBeenCalled();
    expect(dbMock.partnerAsk.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: { volunteerUserIds: ["bob"] } }));
  });

  it("H2 (review): OUT after the game was played drops nobody", async () => {
    dbMock.attendance.findUnique.mockResolvedValue({ status: "CONFIRMED" });
    dbMock.partnerAsk.findUnique.mockResolvedValue({ ...ASK, status: "filled", match: { ...ASK.match, status: "COMPLETED" } });
    const r = await handlePartnerVolunteer(write({ polarity: "out" }), NOW);
    expect(r.outcome).toBe("game-over");
    expect(att.cancelAttendance).not.toHaveBeenCalled();
  });

  it("H2 (review): a past guest's OUT drops nobody", async () => {
    dbMock.attendance.findUnique.mockResolvedValue({ status: "CONFIRMED" });
    dbMock.membership.findUnique.mockImplementation(({ where }: { where: { userId_orgId: { orgId: string } } }) =>
      Promise.resolve(where.userId_orgId.orgId === "sutton" ? { leftAt: null, guestFromOrgId: null } : { id: "g", leftAt: new Date(), guestFromOrgId: "sutton" }),
    );
    expect((await handlePartnerVolunteer(write({ polarity: "out" }), NOW)).outcome).toBe("game-over");
    expect(att.cancelAttendance).not.toHaveBeenCalled();
  });

  it("M7 (review): the ask closed between the read and the claim: nothing written, he is told", async () => {
    dbMock.partnerAsk.updateMany.mockResolvedValue({ count: 0 });
    dbMock.partnerAsk.findUnique
      .mockResolvedValueOnce(ASK)
      .mockResolvedValueOnce({ ...ASK, status: "filled", volunteerUserIds: [] });
    const r = await handlePartnerVolunteer(write(), NOW);
    expect(r.outcome).toBe("closed");
    expect(att.registerAttendance).not.toHaveBeenCalled();
    expect(dbMock.membership.upsert).not.toHaveBeenCalled();
  });

  it("M7 (review): the ask closed while he was being written: his bench row is undone", async () => {
    dbMock.partnerAsk.findUnique
      .mockResolvedValueOnce(ASK)
      .mockResolvedValueOnce({ ...ASK, status: "filled" });
    const r = await handlePartnerVolunteer(write(), NOW);
    expect(r.outcome).toBe("closed");
    expect(att.cancelAttendance).toHaveBeenCalledWith("ali", "m-fnf", expect.objectContaining({ cause: "partner-ask" }));
  });

  it("M7 (review): the asking club's notice is keyed, so a replayed reply tells it once", async () => {
    await handlePartnerVolunteer(write(), NOW);
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "xask:ask1:vol:ali:in:wa-1", kind: "xask-volunteer" } });
    notice.sendAdminNotice.mockClear();
    dbMock.sentNotification.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    await handlePartnerVolunteer(write(), NOW);
    expect(notice.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("a failed write says so to him and to the log, never silence", async () => {
    att.registerAttendance.mockRejectedValue(new Error("db"));
    const r = await handlePartnerVolunteer(write(), NOW);
    expect(r).toMatchObject({ ok: false, outcome: "failed" });
    expect(r.replyText).toBeTruthy();
  });
});
