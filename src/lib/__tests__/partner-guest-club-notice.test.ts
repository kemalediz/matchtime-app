/**
 * A PARTNER club's guest joining or leaving the asking club's game is told
 * where the whole club can see it (Kemal, 2026-10-29: the same rule as a
 * pool guest, #458). Every notice to the ASKING club goes through the
 * shared guest notice (`guest-notice.ts` `tellClubAboutGuest`, which applies
 * `clubNoticeRoute`: HQ, else ONE players' group post, else the admins'
 * DMs), never straight to `sendAdminNotice`. Each carries two texts: the
 * organisers' (HQ, with his standing at his own club) and the group's (for
 * everyone, naming his club, no standing).
 *
 *   joined the squad      volunteer reply, a first-come club with room
 *   bench                 volunteer reply, an organiser-pick club
 *   withdrew by reply     an OUT reply to the ask
 *   OUT by DM             `withdrawGuest`
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  guestPlace: { upsert: vi.fn(), updateMany: vi.fn() },
  partnerAsk: { findUnique: vi.fn(), updateMany: vi.fn() },
  sentNotification: { create: vi.fn() },
  $executeRaw: vi.fn(),
  $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(dbMock)),
  organisation: { findUnique: vi.fn() },
  membership: { findUnique: vi.fn(), upsert: vi.fn() },
  attendance: { findUnique: vi.fn(), findMany: vi.fn() },
  match: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
vi.mock("../club-partnership", () => ({ loadPartnerAskSettings: vi.fn(async () => ({ cutoffHours: 4 })) }));
const att = vi.hoisted(() => ({ registerAttendance: vi.fn(), cancelAttendance: vi.fn() }));
vi.mock("../attendance", () => att);
const channel = vi.hoisted(() => ({ sendAdminNotice: vi.fn() }));
vi.mock("../admin-channel", () => channel);
const standing = vi.hoisted(() => ({ loadGuestStandings: vi.fn() }));
vi.mock("../partner-guest-standing", () => standing);
const guestNotice = vi.hoisted(() => ({ tellClubAboutGuest: vi.fn() }));
vi.mock("../guest-notice", () => guestNotice);
vi.mock("../partner-ask-round", () => ({ loadRoundFill: vi.fn(async () => ({ placed: 0, wanted: 2 })) }));

import { handlePartnerVolunteer, withdrawGuest } from "../partner-guest";

const KICKOFF = new Date("2026-10-27T20:00:00Z");
const NOW = new Date("2026-10-27T12:00:00Z");
const ASK = {
  id: "ask1",
  status: "posted",
  closesAt: KICKOFF,
  askerOrgId: "fnf",
  partnerOrgId: "fmc",
  matchId: "m-fnf",
  roundId: null,
  places: 2,
  volunteerUserIds: [] as string[],
  pickedUserIds: [] as string[],
  match: { date: KICKOFF, status: "UPCOMING", activity: { matchDurationMins: 60 } },
};
const ORGS: Record<string, Record<string, unknown>> = {
  fnf: { id: "fnf", name: "FNF", language: "en", benchPickMode: "first-come" },
  fmc: { id: "fmc", name: "Friday MT Community", language: "en" },
};
const write = (over: Record<string, unknown> = {}) => ({ askId: "ask1", userId: "ali", name: "Ali Kaya", polarity: "in" as const, sourceMessageId: "wa-1", ...over });
const call = () => guestNotice.tellClubAboutGuest.mock.calls[0]?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  ORGS.fnf = { id: "fnf", name: "FNF", language: "en", benchPickMode: "first-come" };
  dbMock.partnerAsk.findUnique.mockResolvedValue(ASK);
  dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(ORGS[where.id] ?? null));
  dbMock.membership.findUnique.mockImplementation(({ where }: { where: { userId_orgId: { orgId: string } } }) =>
    Promise.resolve(where.userId_orgId.orgId === "fmc" ? { leftAt: null, guestFromOrgId: null } : null),
  );
  dbMock.attendance.findUnique.mockResolvedValue(null);
  dbMock.attendance.findMany.mockResolvedValue([]);
  dbMock.partnerAsk.updateMany.mockResolvedValue({ count: 1 });
  dbMock.user.findUnique.mockResolvedValue({ name: "Ali Kaya", phoneNumber: "+447700900111" });
  dbMock.botJob.create.mockResolvedValue({});
  att.registerAttendance.mockResolvedValue({ status: "CONFIRMED" });
  standing.loadGuestStandings.mockResolvedValue(new Map([["ali", { club: "Friday MT Community", band: "top", rating: 7.4 }]]));
  guestNotice.tellClubAboutGuest.mockResolvedValue("players-group");
});

describe("every partner-guest notice to the asking club goes through the shared guest notice", () => {
  it("joined the squad: once, keyed on the reply, HQ words with his standing, group words for everyone", async () => {
    await handlePartnerVolunteer(write(), NOW);
    expect(guestNotice.tellClubAboutGuest).toHaveBeenCalledTimes(1);
    expect(call()).toEqual({
      orgId: "fnf",
      matchId: "m-fnf",
      key: "xask:ask1:vol:ali:in:wa-1",
      kind: "xask-volunteer",
      now: NOW,
      hqText: "🤝 Ali Kaya (Friday MT Community, top third there, rated 7.4) answered your ask for Tue 27 Oct, 20:00: in the squad.",
      groupText: "🙋 Ali K from Friday MT Community has joined the squad for Tue 27 Oct, 20:00.",
    });
    expect(channel.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("bench in an organiser-pick club: the group words say how an organiser puts him in", async () => {
    ORGS.fnf = { ...ORGS.fnf, benchPickMode: "organiser" };
    att.registerAttendance.mockResolvedValue({ status: "BENCH" });
    await handlePartnerVolunteer(write(), NOW);
    expect(call().hqText).toContain("on your bench for you to pick");
    expect(call().groupText).toBe(
      "🙋 Ali K from Friday MT Community is on the bench for Tue 27 Oct, 20:00. The organisers pick who plays from the bench. Organisers, to put Ali K in, tag me and say so, for example *@Match Time put Ali K in*",
    );
  });

  it("the group words never carry his standing at his own club (another club's data)", async () => {
    await handlePartnerVolunteer(write(), NOW);
    expect(call().groupText).not.toMatch(/third|rated|7\.4/);
  });

  it("withdrew by reply: once, keyed on the reply, both texts", async () => {
    dbMock.attendance.findUnique.mockResolvedValue({ status: "CONFIRMED" });
    await handlePartnerVolunteer(write({ polarity: "out", sourceMessageId: "wa-2" }), NOW);
    expect(call()).toEqual({
      orgId: "fnf",
      matchId: "m-fnf",
      key: "xask:ask1:vol:ali:out:wa-2",
      kind: "xask-volunteer",
      now: NOW,
      hqText: "Ali Kaya (Friday MT Community) can't play Tue 27 Oct, 20:00 after all, so I've taken them off.",
      groupText: "Ali K from Friday MT Community can no longer play on Tue 27 Oct, 20:00, so I've taken them off.",
    });
    expect(channel.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("OUT by DM (withdrawGuest): once, both texts, and he still gets his own DM", async () => {
    dbMock.match.findUnique.mockResolvedValue({ id: "m-fnf", date: KICKOFF, status: "UPCOMING", activity: { orgId: "fnf" } });
    dbMock.membership.findUnique.mockResolvedValue({ leftAt: null, guestFromOrgId: "fmc", guestMatchId: "m-fnf" });
    dbMock.attendance.findUnique.mockResolvedValue({ status: "BENCH" });
    expect(await withdrawGuest({ userId: "ali", matchId: "m-fnf", now: NOW })).toBe(true);
    expect(call()).toEqual({
      orgId: "fnf",
      matchId: "m-fnf",
      key: "xask-dm:m-fnf:out:ali",
      kind: "xask-volunteer",
      now: NOW,
      hqText: "Ali Kaya (Friday MT Community) can't play Tue 27 Oct, 20:00 after all, so I've taken them off.",
      groupText: "Ali K from Friday MT Community can no longer play on Tue 27 Oct, 20:00, so I've taken them off.",
    });
    expect(channel.sendAdminNotice).not.toHaveBeenCalled();
    expect(dbMock.botJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({ orgId: "fmc", kind: "dm", phone: "447700900111" }) });
  });

  it("a notice that fails to send never fails his reply", async () => {
    guestNotice.tellClubAboutGuest.mockRejectedValue(new Error("db"));
    dbMock.match.findUnique.mockResolvedValue({ id: "m-fnf", date: KICKOFF, status: "UPCOMING", activity: { orgId: "fnf" } });
    dbMock.membership.findUnique.mockResolvedValue({ leftAt: null, guestFromOrgId: "fmc", guestMatchId: "m-fnf" });
    dbMock.attendance.findUnique.mockResolvedValue({ status: "BENCH" });
    expect(await withdrawGuest({ userId: "ali", matchId: "m-fnf", now: NOW })).toBe(true);
    expect(dbMock.botJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: "dm" }) });
  });
});
