/**
 * A partner guest whom the ASKING club's organisers take off their game
 * (Kemal, 2026-10-22): one DM to him in his own club's language, and he is
 * off every ask of that match so he is not picked again.
 * `tellGuestTakenOffByAdmin` in partner-guest.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  guestPlace: { upsert: vi.fn(), updateMany: vi.fn() },
  match: { findUnique: vi.fn() },
  membership: { findUnique: vi.fn() },
  organisation: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  botJob: { create: vi.fn() },
  $executeRaw: vi.fn(),
}));
vi.mock("../db", () => ({ db: dbMock }));
// Slice L7: the partner guest's GuestPlace, and the club's cut-off for a late drop.
vi.mock("../club-partnership", () => ({ loadPartnerAskSettings: vi.fn(async () => ({ cutoffHours: 4 })) }));
vi.mock("../attendance", () => ({ registerAttendance: vi.fn(), cancelAttendance: vi.fn() }));
vi.mock("../admin-channel", () => ({ sendAdminNotice: vi.fn() }));
const removal = vi.hoisted(() => ({ tellPoolGuestRemoved: vi.fn(async () => true) }));
vi.mock("../pool/removal", () => removal);

import { tellGuestTakenOffByAdmin } from "../partner-guest";

const KICKOFF = new Date("2026-10-28T20:30:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.match.findUnique.mockResolvedValue({ id: "m-mt", date: KICKOFF, status: "UPCOMING", activity: { orgId: "mt" } });
  dbMock.membership.findUnique.mockResolvedValue({ guestFromOrgId: "fmc", guestMatchId: "m-mt", leftAt: null });
  dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === "mt" ? { id: "mt", name: "MT Test", language: "en" } : { id: "fmc", name: "Friday MT Community", language: "en" }),
  );
  dbMock.user.findUnique.mockResolvedValue({ phoneNumber: "+447700900222" });
  dbMock.botJob.create.mockResolvedValue({ id: "j1" });
  dbMock.$executeRaw.mockResolvedValue(1);
});

const dms = () => dbMock.botJob.create.mock.calls.map((c) => c[0].data);

describe("tellGuestTakenOffByAdmin", () => {
  it("a live guest: one DM from his own club, in its language, and off every ask of the match", async () => {
    expect(await tellGuestTakenOffByAdmin({ userId: "c1", matchId: "m-mt" })).toBe(true);
    expect(dms()).toEqual([
      expect.objectContaining({
        orgId: "fmc",
        kind: "dm",
        phone: "447700900222",
        text: "*MT Test*'s organisers have taken you off their game on Wed 28 Oct, 20:30. Thanks for offering 🙏",
      }),
    ]);
    // array_remove on every ask of THIS match, in SQL (never a stale rewrite).
    expect(dbMock.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = (dbMock.$executeRaw.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toContain('array_remove("volunteerUserIds"');
    expect(sql).toContain('"matchId" =');
    expect(dbMock.$executeRaw.mock.calls[0].slice(1)).toEqual(["c1", "m-mt"]);
  });

  it("his club speaks Turkish: the DM is in Turkish", async () => {
    dbMock.organisation.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === "mt" ? { id: "mt", name: "MT Test", language: "en" } : { id: "fmc", name: "Cuma MT", language: "tr" }),
    );
    await tellGuestTakenOffByAdmin({ userId: "c1", matchId: "m-mt" });
    expect(dms()[0].text).toBe("*MT Test* organizatörleri seni 28 Ekim Çarşamba 20:30 maçından çıkardı. Teklifin için teşekkürler 🙏");
  });

  it("an ordinary member of the club: no DM, no change to any ask", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ guestFromOrgId: null, guestMatchId: null, leftAt: null });
    expect(await tellGuestTakenOffByAdmin({ userId: "p1", matchId: "m-mt" })).toBe(false);
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
    expect(dbMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("a guest for another match, or a past guest: no DM", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ guestFromOrgId: "fmc", guestMatchId: "m-other", leftAt: null });
    expect(await tellGuestTakenOffByAdmin({ userId: "c1", matchId: "m-mt" })).toBe(false);
    dbMock.membership.findUnique.mockResolvedValue({ guestFromOrgId: "fmc", guestMatchId: "m-mt", leftAt: new Date() });
    expect(await tellGuestTakenOffByAdmin({ userId: "c1", matchId: "m-mt" })).toBe(false);
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("a game already played or cancelled: no DM", async () => {
    dbMock.match.findUnique.mockResolvedValue({ id: "m-mt", date: KICKOFF, status: "COMPLETED", activity: { orgId: "mt" } });
    expect(await tellGuestTakenOffByAdmin({ userId: "c1", matchId: "m-mt" })).toBe(false);
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("no number on file: he is still taken off the asks, nothing is sent", async () => {
    dbMock.user.findUnique.mockResolvedValue({ phoneNumber: null });
    expect(await tellGuestTakenOffByAdmin({ userId: "c1", matchId: "m-mt" })).toBe(true);
    expect(dbMock.$executeRaw).toHaveBeenCalledTimes(1);
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    dbMock.match.findUnique.mockRejectedValue(new Error("db down"));
    expect(await tellGuestTakenOffByAdmin({ userId: "c1", matchId: "m-mt" })).toBe(false);
  });
});

describe("slice L7: the guest place, and a pool guest", () => {
  it("a partner guest taken off: his guest place is marked given up in time, never a miss", async () => {
    await tellGuestTakenOffByAdmin({ userId: "c1", matchId: "m-mt" });
    expect(dbMock.guestPlace.updateMany).toHaveBeenCalledWith({ where: { matchId: "m-mt", userId: "c1", result: "booked", settledAt: null }, data: { result: "withdrawn", resultAt: expect.any(Date) } });
  });

  it("a POOL guest goes to the pool's own neutral DM, never his (non-existent) home club's", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ guestFromOrgId: null, guestMatchId: "m-mt", guestVia: "pool", leftAt: null });
    expect(await tellGuestTakenOffByAdmin({ userId: "p1", matchId: "m-mt" })).toBe(true);
    expect(removal.tellPoolGuestRemoved).toHaveBeenCalledWith({ userId: "p1", matchId: "m-mt", orgId: "mt" });
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });
});
