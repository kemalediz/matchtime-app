/**
 * A partner club's player volunteers (cross-club ask, slice S3):
 * `handlePartnerVolunteer`, the one writer onto another club's match.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  guestPlace: { upsert: vi.fn(), updateMany: vi.fn() },
  partnerAsk: { findUnique: vi.fn(), updateMany: vi.fn() },
  sentNotification: { create: vi.fn() },
  $executeRaw: vi.fn(),
  // P4: a first-come club's place is written under the match's lock.
  $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(dbMock)),
  organisation: { findUnique: vi.fn() },
  membership: { findUnique: vi.fn(), upsert: vi.fn() },
  attendance: { findUnique: vi.fn(), findMany: vi.fn() },
  user: { findUnique: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
// Slice L7: the partner guest's GuestPlace, and the club's cut-off for a late drop.
vi.mock("../club-partnership", () => ({ loadPartnerAskSettings: vi.fn(async () => ({ cutoffHours: 4 })) }));
const att = vi.hoisted(() => ({ registerAttendance: vi.fn(), cancelAttendance: vi.fn() }));
vi.mock("../attendance", () => att);
const notice = vi.hoisted(() => ({ sendAdminNotice: vi.fn() }));
vi.mock("../admin-channel", () => notice);
// His standing at his own club (2026-10-22): read by partner-guest-standing.ts.
const standing = vi.hoisted(() => ({ loadGuestStandings: vi.fn() }));
vi.mock("../partner-guest-standing", () => standing);
// 2026-10-29: the asking club is told through the shared guest notice (HQ,
// else its players' group, else the admins' DMs): partner-guest-club-notice.test.ts.
const guestNotice = vi.hoisted(() => ({ tellClubAboutGuest: vi.fn() }));
vi.mock("../guest-notice", () => guestNotice);

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
  dbMock.user.findUnique.mockResolvedValue({ phoneNumber: "+447700900111" });
  dbMock.botJob.create.mockResolvedValue({ id: "dm1" });
  standing.loadGuestStandings.mockResolvedValue(new Map([["ali", { club: "Sutton FC", band: "top", rating: null }]]));
  guestNotice.tellClubAboutGuest.mockResolvedValue("admin-channel");
});

/** The organisers' words of the asking club's notice. */
const toldAsker = (text: string) => expect(guestNotice.tellClubAboutGuest).toHaveBeenCalledWith(expect.objectContaining({ orgId: "fnf", hqText: expect.stringContaining(text) }));

/** The one DM he was sent, or undefined. */
const dmTo = () => dbMock.botJob.create.mock.calls.map((c) => c[0].data).find((d) => d.kind === "dm");

describe("handlePartnerVolunteer", () => {
  it("IN: a guest membership in the asking club, a row on ITS match with cause partner-ask, recorded on the ask, both sides told", async () => {
    const r = await handlePartnerVolunteer(write(), NOW);
    expect(r).toMatchObject({ ok: true, outcome: "registered-bench" });
    expect(dbMock.membership.upsert).toHaveBeenCalledWith({
      where: { userId_orgId: { userId: "ali", orgId: "fnf" } },
      create: { userId: "ali", orgId: "fnf", role: "PLAYER", guestVia: "partner", guestFromOrgId: "sutton", guestMatchId: "m-fnf" },
      update: { role: "PLAYER", leftAt: null, guestVia: "partner", guestFromOrgId: "sutton", guestMatchId: "m-fnf" },
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
    expect(r.dmText).toContain("FNF* yedek listesindesin");
    toldAsker("Ali Kaya (Sutton FC, top third there) answered your ask");
    // His standing is read at HIS club (the partner), never the asking club.
    expect(standing.loadGuestStandings).toHaveBeenCalledWith([{ userId: "ali", homeOrgId: "sutton" }]);
  });

  it("2026-10-22: his club shares its ratings: the notice carries his number there too", async () => {
    standing.loadGuestStandings.mockResolvedValue(new Map([["ali", { club: "Sutton FC", band: "middle", rating: 7.4 }]]));
    await handlePartnerVolunteer(write(), NOW);
    toldAsker("Ali Kaya (Sutton FC, middle third there, rated 7.4) answered");
  });

  it("2026-10-22: his standing cannot be read: the notice still goes, with his club alone", async () => {
    standing.loadGuestStandings.mockResolvedValue(new Map());
    await handlePartnerVolunteer(write(), NOW);
    toldAsker("Ali Kaya (Sutton FC) answered");
  });

  it("M1 (review of #400): a former ADMIN who left the asking club comes back as a guest: his row is a PLAYER again, never an admin", async () => {
    dbMock.membership.findUnique.mockImplementation(({ where }: { where: { userId_orgId: { orgId: string } } }) =>
      Promise.resolve(
        where.userId_orgId.orgId === "sutton" ? { leftAt: null, guestFromOrgId: null } : { id: "old", leftAt: new Date("2026-09-01"), guestFromOrgId: null, guestMatchId: null, guestVia: null },
      ),
    );
    await handlePartnerVolunteer(write(), NOW);
    expect(dbMock.membership.upsert.mock.calls[0][0].update).toMatchObject({ role: "PLAYER", leftAt: null, guestVia: "partner" });
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
    expect(r.dmText).toContain("20:00");
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
      // P4: the round's fresh read under the match's lock.
      .mockResolvedValueOnce(ASK)
      .mockResolvedValueOnce({ ...ASK, status: "filled" });
    const r = await handlePartnerVolunteer(write(), NOW);
    expect(r.outcome).toBe("closed");
    expect(att.cancelAttendance).toHaveBeenCalledWith("ali", "m-fnf", expect.objectContaining({ cause: "partner-ask" }));
  });

  it("M7 (review): the asking club's notice is keyed on the reply, so a replay is claimed once (guest-notice.ts)", async () => {
    await handlePartnerVolunteer(write(), NOW);
    expect(guestNotice.tellClubAboutGuest).toHaveBeenCalledWith(expect.objectContaining({ key: "xask:ask1:vol:ali:in:wa-1", kind: "xask-volunteer" }));
    expect(notice.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("a failed write says so to him and to the log, never silence", async () => {
    att.registerAttendance.mockRejectedValue(new Error("db"));
    const r = await handlePartnerVolunteer(write(), NOW);
    expect(r).toMatchObject({ ok: false, outcome: "failed" });
    expect(r.dmText).toBeTruthy();
    expect(dmTo()?.text).toBe(r.dmText);
  });

  // ── 2026-10-21 (Kemal): volunteering adds no noise to the partner group ──
  it("every answer goes to HIM by DM, as a reply-priority BotJob of HIS club, in his club's language; nothing for the group", async () => {
    const r = await handlePartnerVolunteer(write(), NOW);
    expect(r).not.toHaveProperty("replyText");
    expect(r.dmQueued).toBe(true);
    expect(dmTo()).toEqual({ orgId: "sutton", kind: "dm", phone: "447700900111", text: r.dmText, priority: 1 });
    expect(dmTo()?.text).toContain("yedek listesindesin");
    // No group post of any kind.
    expect(dbMock.botJob.create.mock.calls.some((c) => c[0].data.kind === "group")).toBe(false);
  });

  it("the refusals (closed, overlap, not on the list) are DMs too", async () => {
    dbMock.partnerAsk.findUnique.mockResolvedValue({ ...ASK, status: "filled" });
    const closed = await handlePartnerVolunteer(write(), NOW);
    expect(closed.outcome).toBe("closed");
    expect(dmTo()?.text).toBe(closed.dmText);
    dbMock.botJob.create.mockClear();
    dbMock.partnerAsk.findUnique.mockResolvedValue(ASK);
    const notOn = await handlePartnerVolunteer(write({ polarity: "out" }), NOW);
    expect(notOn.outcome).toBe("not-on-list");
    expect(dmTo()?.text).toBe(notOn.dmText);
  });

  it("a withdrawal is answered by DM", async () => {
    dbMock.attendance.findUnique.mockResolvedValue({ status: "BENCH" });
    const r = await handlePartnerVolunteer(write({ polarity: "out" }), NOW);
    expect(r.outcome).toBe("withdrawn");
    expect(dmTo()?.text).toContain("FNF");
  });

  it("the DM goes to the number he messaged from when the caller has it (the DM path)", async () => {
    await handlePartnerVolunteer(write({ replyPhone: "447700900222" }), NOW);
    expect(dmTo()?.phone).toBe("447700900222");
  });

  it("no number on file: nothing is sent anywhere, and the caller is told", async () => {
    dbMock.user.findUnique.mockResolvedValue({ phoneNumber: null });
    const r = await handlePartnerVolunteer(write(), NOW);
    expect(r.outcome).toBe("registered-bench");
    expect(r.dmQueued).toBe(false);
    expect(dmTo()).toBeUndefined();
  });
});

describe("slice L7: a partner guest's game is a GuestPlace too", () => {
  it("taking a place (bench or in) as a guest writes his partner guest place", async () => {
    await handlePartnerVolunteer(write(), NOW);
    expect(dbMock.guestPlace.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { matchId_userId: { matchId: "m-fnf", userId: "ali" } },
        create: { orgId: "fnf", matchId: "m-fnf", userId: "ali", source: "partner", fromOrgId: "sutton", partnerAskId: "ask1" },
      }),
    );
  });

  it("an ordinary member of the asking club gets no guest place", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ id: "mem", leftAt: null, guestFromOrgId: null });
    await handlePartnerVolunteer(write(), NOW);
    expect(dbMock.guestPlace.upsert).not.toHaveBeenCalled();
  });

  it("OUT after the club's cut-off marks his place a late cancel; before it, given up in time", async () => {
    dbMock.membership.findUnique.mockImplementation(({ where }: { where: { userId_orgId: { orgId: string } } }) =>
      Promise.resolve(where.userId_orgId.orgId === "sutton" ? { leftAt: null, guestFromOrgId: null } : { id: "g", leftAt: null, guestFromOrgId: "sutton", guestMatchId: "m-fnf", guestVia: "partner" }),
    );
    dbMock.attendance.findUnique.mockResolvedValue({ status: "CONFIRMED" });
    dbMock.partnerAsk.findUnique.mockResolvedValue({ ...ASK, volunteerUserIds: ["ali"] });
    // NOW is 5.5 hours before kickoff, the cut-off 4: in time.
    await handlePartnerVolunteer(write({ polarity: "out" }), NOW);
    expect(dbMock.guestPlace.updateMany).toHaveBeenLastCalledWith({ where: { matchId: "m-fnf", userId: "ali", result: "booked", settledAt: null }, data: { result: "withdrawn", resultAt: NOW } });
    const late = new Date(KICKOFF.getTime() - 3600_000);
    await handlePartnerVolunteer(write({ polarity: "out", sourceMessageId: "wa-2" }), late);
    expect(dbMock.guestPlace.updateMany).toHaveBeenLastCalledWith({ where: { matchId: "m-fnf", userId: "ali", result: "booked", settledAt: null }, data: { result: "late-cancel", resultAt: late } });
  });
});
