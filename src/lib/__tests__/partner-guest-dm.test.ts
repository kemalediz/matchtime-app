/**
 * H4 (review): a picked guest's DM "OUT" must not drop him from his OWN
 * club's game. While he has a live place in the asking club's match, a DM
 * OUT asks which game, one short question, and acts only on the answer
 * ("1" the asking club's, "2" his own club's: a numbered choice, read as
 * structured data). No own game: he is taken out of the guest game.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  membership: { findMany: vi.fn() },
  attendance: { findUnique: vi.fn() },
  match: { findUnique: vi.fn() },
  organisation: { findUnique: vi.fn() },
  sentNotification: { create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
const resolver = vi.hoisted(() => ({ resolveDmSelfAttendance: vi.fn() }));
vi.mock("../dm-self-attendance", () => resolver);
const target = vi.hoisted(() => ({ findDmRegistrationTarget: vi.fn() }));
vi.mock("../dm-registration-target", () => target);
const oob = vi.hoisted(() => ({ applyOutOfBandSelfAttendance: vi.fn() }));
vi.mock("../out-of-band-self-attendance", () => oob);
const guest = vi.hoisted(() => ({ withdrawGuest: vi.fn() }));
vi.mock("../partner-guest", () => guest);
vi.mock("../ai-budget", () => ({ withOrgAiBudget: (_o: string, f: () => unknown) => f() }));
const facts = vi.hoisted(() => ({ loadMatchAvailabilityFacts: vi.fn() }));
vi.mock("../match-availability-context", () => facts);

import { handleGuestDmOut, parseWhichAnswer } from "../partner-guest-dm";

const NOW = new Date("2026-10-30T12:00:00Z");
const OWN = { matchId: "m-own", orgId: "sutton", clubName: "Sutton FC", matchName: "Tuesday", matchWhen: "Tue 3 Nov, 20:00", maxPlayers: 14, lang: "en" };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.membership.findMany.mockResolvedValue([{ orgId: "fnf", guestFromOrgId: "sutton", guestMatchId: "m-fnf" }]);
  dbMock.attendance.findUnique.mockResolvedValue({ status: "CONFIRMED" });
  dbMock.match.findUnique.mockResolvedValue({ id: "m-fnf", date: new Date("2026-10-30T20:30:00Z"), status: "UPCOMING" });
  dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === "fnf" ? { id: "fnf", name: "FNF", language: "en" } : { id: "sutton", name: "Sutton FC", language: "en" }),
  );
  dbMock.sentNotification.findFirst.mockResolvedValue(null);
  resolver.resolveDmSelfAttendance.mockResolvedValue({ decision: "out", via: "fast-path" });
  target.findDmRegistrationTarget.mockResolvedValue(OWN);
  guest.withdrawGuest.mockResolvedValue(true);
  facts.loadMatchAvailabilityFacts.mockResolvedValue({ userId: "ali", matchId: "m-fnf", currentStatus: "in the squad", lastBotDm: null });
});

const call = (text: string) => handleGuestDmOut({ userId: "ali", userName: "Ali", text, replyPhone: "447700900111", now: NOW });

describe("parseWhichAnswer", () => {
  it("1 or 2, nothing else", () => {
    expect(parseWhichAnswer(" 1 ")).toBe(1);
    expect(parseWhichAnswer("2")).toBe(2);
    expect(parseWhichAnswer("out")).toBeNull();
    expect(parseWhichAnswer("12")).toBeNull();
  });
});

describe("handleGuestDmOut", () => {
  it("a guest with a live place and his own game says OUT: one question, nothing dropped", async () => {
    const r = await call("out");
    expect(r?.handled).toBe("guest-dm-which");
    expect(guest.withdrawGuest).not.toHaveBeenCalled();
    expect(oob.applyOutOfBandSelfAttendance).not.toHaveBeenCalled();
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: "xask-dm-out", key: expect.stringMatching(/^xask:dmout:ali:m-fnf:m-own:/) }) });
    const dm = dbMock.botJob.create.mock.calls[0][0].data;
    expect(dm).toMatchObject({ kind: "dm", phone: "447700900111", orgId: "sutton" });
    expect(dm.text).toContain("1");
    expect(dm.text).toContain("FNF");
    expect(dm.text).toContain("Sutton FC");
  });

  it("the classifier is told what MatchTime last said to him and where he stands in the guest game", async () => {
    await call("out");
    expect(facts.loadMatchAvailabilityFacts).toHaveBeenCalledWith({ userId: "ali", matchId: "m-fnf", phone: "447700900111" });
    expect(resolver.resolveDmSelfAttendance.mock.calls[0][0].context).toMatchObject({
      userId: "ali",
      matchId: "m-fnf",
      currentStatus: "in the squad",
      lastBotDm: null,
    });
  });

  it("answer 1: out of the asking club's game only", async () => {
    dbMock.sentNotification.findFirst.mockResolvedValue({ key: `xask:dmout:ali:m-fnf:m-own:${NOW.getTime() - 60_000}`, createdAt: new Date(NOW.getTime() - 60_000) });
    const r = await call("1");
    expect(r?.handled).toBe("guest-dm-out-guest");
    expect(guest.withdrawGuest).toHaveBeenCalledWith({ userId: "ali", matchId: "m-fnf", now: NOW });
    expect(oob.applyOutOfBandSelfAttendance).not.toHaveBeenCalled();
  });

  it("answer 2: out of his own club's game only", async () => {
    dbMock.sentNotification.findFirst.mockResolvedValue({ key: `xask:dmout:ali:m-fnf:m-own:${NOW.getTime() - 60_000}`, createdAt: new Date(NOW.getTime() - 60_000) });
    const r = await call("2");
    expect(r?.handled).toBe("guest-dm-out-own");
    expect(oob.applyOutOfBandSelfAttendance).toHaveBeenCalledWith(expect.objectContaining({ userId: "ali", matchId: "m-own", decision: "out", source: "dm" }));
    expect(guest.withdrawGuest).not.toHaveBeenCalled();
  });

  it("no own game: out of the guest game at once", async () => {
    target.findDmRegistrationTarget.mockResolvedValue(null);
    const r = await call("out");
    expect(r?.handled).toBe("guest-dm-out-guest");
    expect(guest.withdrawGuest).toHaveBeenCalled();
  });

  it("IN, or no live guest place: not this handler's (the ordinary DM path decides)", async () => {
    resolver.resolveDmSelfAttendance.mockResolvedValue({ decision: "in", via: "fast-path" });
    expect(await call("in")).toBeNull();
    resolver.resolveDmSelfAttendance.mockResolvedValue({ decision: "out", via: "fast-path" });
    dbMock.membership.findMany.mockResolvedValue([]);
    expect(await call("out")).toBeNull();
  });

  it("a played or finished guest match is no live place", async () => {
    dbMock.match.findUnique.mockResolvedValue({ id: "m-fnf", date: new Date("2026-10-29T20:30:00Z"), status: "COMPLETED" });
    expect(await call("out")).toBeNull();
  });
});
