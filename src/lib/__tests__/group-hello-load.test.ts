/**
 * `loadHelloInput`: the one read behind the settings-aware group hello
 * (go-live slice S2, 2026-10-12). The database is a double; no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn() },
  clubConnect: { findFirst: vi.fn() },
  membership: { findFirst: vi.fn(), findMany: vi.fn() },
  user: { findUnique: vi.fn() },
  match: { findMany: vi.fn() },
  attendance: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { loadHelloInput, type HelloReadClient } from "../group-hello-load";
import { DEFAULT_HELLO_SETTINGS, HELLO_ORG_SELECT, buildGroupHello, type HelloOrgRow } from "../group-hello";
import { en } from "../i18n/strings.en";
import { tr } from "../i18n/strings.tr";

const ROW: HelloOrgRow = {
  language: "en",
  squadMode: "weekly",
  featureAttendance: true,
  featureBench: true,
  featureTeamBalancing: true,
  featureMomVoting: true,
  featurePlayerRating: true,
  featureReminders: true,
  featureStatsQa: true,
  featureSquadFromList: false,
  rollingSquadEnabled: false,
  benchPickMode: "first-come",
  dropOutDeadlineDay: null,
  dropOutDeadlineTime: null,
  listPublishDay: null,
  listPublishTime: null,
  paymentTrackingEnabled: false,
  paymentCollectionEnabled: false,
  stripeConnectAccountId: null,
  stripeChargesEnabled: false,
  payMethodCard: true,
  payMethodPayByBank: true,
};

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-13T12:00:00.000Z");
const fixtureMatch = (id: string, offsetDays: number, status: string) => ({
  id,
  date: new Date(NOW.getTime() + offsetDays * DAY),
  status,
  isHistorical: false,
  rollingSeededAt: null,
  activity: { orgId: "org-1", venue: "Pitch", dayOfWeek: 2 },
});
const attendanceRow = (matchId: string, userId: string) => ({
  matchId,
  userId,
  status: "CONFIRMED",
  position: 1,
  user: { phoneNumber: "+447700900001", email: `${userId}@example.invalid`, isActive: true },
});
/** Last week's game, completed, with one member on it; next week's ahead. */
function squadFromLastWeek() {
  dbMock.match.findMany.mockResolvedValue([fixtureMatch("last", -5, "COMPLETED"), fixtureMatch("next", 2, "UPCOMING")]);
  dbMock.attendance.findMany.mockResolvedValue([attendanceRow("last", "p1")]);
  dbMock.membership.findMany.mockResolvedValue([{ userId: "p1", leftAt: null, provisionallyAddedAt: null }]);
}

beforeEach(() => {
  for (const m of [
    dbMock.organisation.findUnique,
    dbMock.clubConnect.findFirst,
    dbMock.membership.findFirst,
    dbMock.membership.findMany,
    dbMock.user.findUnique,
    dbMock.match.findMany,
    dbMock.attendance.findMany,
  ]) {
    m.mockReset();
  }
  dbMock.match.findMany.mockResolvedValue([]);
  dbMock.attendance.findMany.mockResolvedValue([]);
  dbMock.membership.findMany.mockResolvedValue([]);
  dbMock.organisation.findUnique.mockResolvedValue(ROW);
  dbMock.clubConnect.findFirst.mockResolvedValue({ userId: "u-connect" });
  dbMock.membership.findFirst.mockResolvedValue({ userId: "u-owner" });
  dbMock.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    name: where.id === "u-connect" ? "Ali Veli" : where.id === "u-owner" ? "Olivia Owner" : "Given Person",
  }));
});

describe("loadHelloInput", () => {
  it("reads the hello's columns and names the person who connected the club", async () => {
    const input = await loadHelloInput("org-1");
    expect(dbMock.organisation.findUnique).toHaveBeenCalledWith({ where: { id: "org-1" }, select: HELLO_ORG_SELECT });
    expect(input).toEqual({ organiser: "Ali", lang: "en", settings: DEFAULT_HELLO_SETTINGS, hasSquadToCarry: false });
    expect(dbMock.membership.findFirst).not.toHaveBeenCalled();
    // A club that signs up each week is never asked about a squad to carry.
    expect(dbMock.match.findMany).not.toHaveBeenCalled();
    expect(buildGroupHello({ ...input, catchUp: false })).toBe(en.sj_group_hello({ organiser: "Ali" }));
  });

  it("falls back to the club's owner when no connect link exists", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue(null);
    expect((await loadHelloInput("org-1")).organiser).toBe("Olivia");
  });

  it("uses the organiser it is given, with no lookup", async () => {
    expect((await loadHelloInput("org-1", { organiserUserId: "u-given" })).organiser).toBe("Given");
    expect(dbMock.clubConnect.findFirst).not.toHaveBeenCalled();
    expect(dbMock.membership.findFirst).not.toHaveBeenCalled();
  });

  it("no organiser at all, or one with no name, is the hello's nameless wording", async () => {
    dbMock.clubConnect.findFirst.mockResolvedValue(null);
    dbMock.membership.findFirst.mockResolvedValue(null);
    const input = await loadHelloInput("org-1");
    expect(input.organiser).toBeNull();
    expect(dbMock.user.findUnique).not.toHaveBeenCalled();
    expect(buildGroupHello({ ...input, catchUp: false })).toBe(en.sj_group_hello({ organiser: null }));

    dbMock.clubConnect.findFirst.mockResolvedValue({ userId: "u-x" });
    dbMock.user.findUnique.mockResolvedValue({ name: null });
    expect((await loadHelloInput("org-1")).organiser).toBeNull();
  });

  it("a Turkish rolling squad club is greeted in Turkish, from its own settings", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({
      ...ROW,
      language: "tr",
      rollingSquadEnabled: true,
      dropOutDeadlineDay: 1,
      dropOutDeadlineTime: "21:00",
    });
    squadFromLastWeek();
    const out = buildGroupHello(await loadHelloInput("org-1", { now: NOW }));
    expect(out).toContain(tr.sj_hello_rolling({ deadline: "Pazartesi 21:00" }));
    expect(out).not.toContain(tr.sj_hello_whos_in);
    expect(out).not.toContain(tr.sj_hello_catch_up);
  });

  // ── 2026-10-13: a rolling club MatchTime has no squad for yet ────────
  it("a rolling club with no game played yet: no squad to carry, and the hello is the first-game form", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...ROW, rollingSquadEnabled: true });
    dbMock.match.findMany.mockResolvedValue([fixtureMatch("next", 2, "UPCOMING")]);
    const input = await loadHelloInput("org-1", { now: NOW });
    expect(input.hasSquadToCarry).toBe(false);
    const out = buildGroupHello(input);
    expect(out).toContain(en.sj_hello_rolling_first({ deadline: null, mode: "first-come" }));
    expect(out).not.toContain(en.sj_hello_rolling({ deadline: null }));
    // Nothing to read players for.
    expect(dbMock.attendance.findMany).not.toHaveBeenCalled();
  });

  it("a rolling club whose last game has players on it: a squad to carry, and today's rolling wording stands", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...ROW, rollingSquadEnabled: true });
    squadFromLastWeek();
    const input = await loadHelloInput("org-1", { now: NOW });
    expect(input.hasSquadToCarry).toBe(true);
    const out = buildGroupHello(input);
    expect(out).toContain(en.sj_hello_rolling({ deadline: null }));
    expect(out).not.toContain(en.sj_hello_rolling_first({ deadline: null, mode: "first-come" }));
    // The seeding's own selection: this club, not historical, live or lately completed.
    const where = dbMock.match.findMany.mock.calls[0][0].where;
    expect(where.activity).toEqual({ orgId: "org-1" });
    expect(where.isHistorical).toBe(false);
    expect(dbMock.attendance.findMany.mock.calls[0][0].where).toEqual({ matchId: { in: ["last"] }, status: "CONFIRMED" });
  });

  it("the last game's only player has left the group: the seeding would carry nobody, so the hello does not say anybody is in", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...ROW, rollingSquadEnabled: true });
    squadFromLastWeek();
    dbMock.membership.findMany.mockResolvedValue([{ userId: "p1", leftAt: new Date(), provisionallyAddedAt: null }]);
    expect((await loadHelloInput("org-1", { now: NOW })).hasSquadToCarry).toBe(false);
  });

  it("a game that kicked off while the club was setting up, with a player on it, is a squad to carry: go-live completes it and the seeding reads it", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...ROW, rollingSquadEnabled: true });
    dbMock.match.findMany.mockResolvedValue([fixtureMatch("kicked-off", -0.2, "UPCOMING"), fixtureMatch("next", 7, "UPCOMING")]);
    dbMock.attendance.findMany.mockResolvedValue([attendanceRow("kicked-off", "p1")]);
    dbMock.membership.findMany.mockResolvedValue([{ userId: "p1", leftAt: null, provisionallyAddedAt: null }]);
    expect((await loadHelloInput("org-1", { now: NOW })).hasSquadToCarry).toBe(true);
  });

  it("a monthly club is never asked: rolling squad reads as off for it", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...ROW, squadMode: "monthly", rollingSquadEnabled: true });
    expect((await loadHelloInput("org-1", { now: NOW })).hasSquadToCarry).toBe(false);
    expect(dbMock.match.findMany).not.toHaveBeenCalled();
  });

  it("throws for a club that does not exist, so no hello is ever built from nothing", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(null);
    await expect(loadHelloInput("org-missing")).rejects.toThrow(/org-missing/);
  });

  it("reads through the client it is handed (a transaction), not the shared one", async () => {
    const tx = {
      organisation: { findUnique: vi.fn(async () => ({ ...ROW, rollingSquadEnabled: true })) },
      clubConnect: { findFirst: vi.fn(async () => ({ userId: "u-tx" })) },
      membership: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => [{ userId: "p1", leftAt: null, provisionallyAddedAt: null }]),
      },
      user: { findUnique: vi.fn(async () => ({ name: "Tamsin Xu" })) },
      match: { findMany: vi.fn(async () => [fixtureMatch("last", -5, "COMPLETED"), fixtureMatch("next", 2, "UPCOMING")]) },
      attendance: { findMany: vi.fn(async () => [attendanceRow("last", "p1")]) },
    };
    const input = await loadHelloInput("org-1", { client: tx as unknown as HelloReadClient, now: NOW });
    expect(input.organiser).toBe("Tamsin");
    expect(input.settings.rollingSquad).toBe(true);
    // The squad question is answered from the same transaction.
    expect(input.hasSquadToCarry).toBe(true);
    expect(tx.match.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.match.findMany).not.toHaveBeenCalled();
    expect(dbMock.organisation.findUnique).not.toHaveBeenCalled();
  });
});
