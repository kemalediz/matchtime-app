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
  attendanceEvent: { findMany: vi.fn() },
  activity: { findMany: vi.fn() },
  clubPartnership: { count: vi.fn() },
  platformSetting: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
// No ask setting is read any more: an active pairing is the switch
// (Kemal, 2026-11-08). The mock proves it is never called.
const askSettings = vi.hoisted(() => ({ loadPartnerAskSettings: vi.fn() }));
vi.mock("../club-partnership", () => askSettings);

import { loadHelloInput, type HelloReadClient } from "../group-hello-load";
import { DEFAULT_HELLO_SETTINGS, HELLO_ORG_SELECT, NO_HELLO_CLUB_FACTS, buildGroupHello, type HelloOrgRow } from "../group-hello";
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
  maxPlayers: 10,
  activity: { orgId: "org-1", venue: "Pitch", dayOfWeek: 2 },
});
const attendanceRow = (matchId: string, userId: string) => ({
  matchId,
  userId,
  status: "CONFIRMED",
  position: 1,
  user: { phoneNumber: "+447700900001", email: `${userId}@example.invalid`, isActive: true },
});
/** `n` members on `matchId`, as the two reads return them. */
function playersOn(matchId: string, n: number) {
  const ids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  dbMock.attendance.findMany.mockResolvedValue(ids.map((id) => attendanceRow(matchId, id)));
  dbMock.membership.findMany.mockResolvedValue(ids.map((userId) => ({ userId, leftAt: null, provisionallyAddedAt: null })));
}
/** Last week's 10-a-game match, completed, with `n` members on it (half
 *  the places unless a case says otherwise); next week's ahead. */
function squadFromLastWeek(n = 5) {
  dbMock.match.findMany.mockResolvedValue([fixtureMatch("last", -5, "COMPLETED"), fixtureMatch("next", 2, "UPCOMING")]);
  playersOn("last", n);
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
    dbMock.attendanceEvent.findMany,
    dbMock.activity.findMany,
    dbMock.clubPartnership.count,
    dbMock.platformSetting.findUnique,
  ]) {
    m.mockReset();
  }
  dbMock.clubPartnership.count.mockResolvedValue(0);
  askSettings.loadPartnerAskSettings.mockReset();
  dbMock.platformSetting.findUnique.mockResolvedValue({ on: true });
  dbMock.attendanceEvent.findMany.mockResolvedValue([]);
  dbMock.activity.findMany.mockResolvedValue([]);
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

// ── 2026-11-02: "help run the Monday games" ──
describe("loadHelloInput: the game day", () => {
  it("one weekly game day names it", async () => {
    dbMock.activity.findMany.mockResolvedValue([{ dayOfWeek: 1 }, { dayOfWeek: 1 }]);
    const input = await loadHelloInput("org-1");
    expect(input.gameDay).toBe(1);
    expect(dbMock.activity.findMany.mock.calls[0][0]).toEqual({ where: { orgId: "org-1", isActive: true }, select: { dayOfWeek: true } });
    expect(buildGroupHello(input)).toContain("Ali has set me up to help run the Monday games.");
  });

  it("several days, or none, is no single day", async () => {
    dbMock.activity.findMany.mockResolvedValue([{ dayOfWeek: 1 }, { dayOfWeek: 4 }]);
    expect((await loadHelloInput("org-1")).gameDay).toBeNull();
    dbMock.activity.findMany.mockResolvedValue([]);
    expect((await loadHelloInput("org-1")).gameDay).toBeNull();
  });

  it("a read that fails, or a client without it, is no single day", async () => {
    dbMock.activity.findMany.mockRejectedValue(new Error("db down"));
    expect((await loadHelloInput("org-1")).gameDay).toBeNull();
    const { activity: _a, ...rest } = dbMock;
    expect((await loadHelloInput("org-1", { client: rest as unknown as HelloReadClient })).gameDay).toBeNull();
  });
});

describe("loadHelloInput", () => {
  it("reads the hello's columns and names the person who connected the club", async () => {
    const input = await loadHelloInput("org-1");
    expect(dbMock.organisation.findUnique).toHaveBeenCalledWith({ where: { id: "org-1" }, select: HELLO_ORG_SELECT });
    expect(input).toEqual({
      organiser: "Ali",
      lang: "en",
      settings: DEFAULT_HELLO_SETTINGS,
      hasSquadToCarry: false,
      gameDay: null,
      clubFacts: NO_HELLO_CLUB_FACTS,
    });
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

  // ── The squad must be SUBSTANTIAL (owner decision, 2026-10-13): at
  //    least half of the next game's places, or most of the group still
  //    has to say In and the first-game form is the true one. ──
  const SIZES: Array<[string, number, boolean]> = [
    ["nobody carried", 0, false],
    ["one player (a website In before go-live)", 1, false],
    ["just under half the places", 4, false],
    ["exactly half the places", 5, true],
    ["a full squad", 10, true],
  ];
  for (const lang of ["en", "tr"] as const) {
    for (const [name, n, standing] of SIZES) {
      it(`${lang}: ${name} (${n} of 10): ${standing ? "the standing wording" : "the first-game form"}`, async () => {
        const s = lang === "en" ? en : tr;
        dbMock.organisation.findUnique.mockResolvedValue({ ...ROW, language: lang, rollingSquadEnabled: true });
        squadFromLastWeek(n);
        const input = await loadHelloInput("org-1", { now: NOW });
        expect(input.hasSquadToCarry).toBe(standing);
        const said = buildGroupHello(input).split("\n");
        const standingLine = s.sj_hello_rolling({ deadline: null });
        const firstLine = s.sj_hello_rolling_first({ deadline: null, mode: "first-come" });
        expect(said.includes(standingLine)).toBe(standing);
        expect(said.includes(firstLine)).toBe(!standing);
      });
    }
  }

  it("the places are the next game's: 6 carried is not half of a 14-a-game match", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...ROW, rollingSquadEnabled: true });
    dbMock.match.findMany.mockResolvedValue([fixtureMatch("last", -5, "COMPLETED"), { ...fixtureMatch("next", 2, "UPCOMING"), maxPlayers: 14 }]);
    playersOn("last", 6);
    expect((await loadHelloInput("org-1", { now: NOW })).hasSquadToCarry).toBe(false);
    playersOn("last", 7);
    expect((await loadHelloInput("org-1", { now: NOW })).hasSquadToCarry).toBe(true);
    expect(dbMock.match.findMany.mock.calls[0][0].select.maxPlayers).toBe(true);
  });

  it("a player who has left the group is not carried, so he does not count towards the half", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...ROW, rollingSquadEnabled: true });
    squadFromLastWeek(5);
    dbMock.membership.findMany.mockResolvedValue(
      ["p1", "p2", "p3", "p4", "p5"].map((userId) => ({ userId, leftAt: userId === "p5" ? new Date() : null, provisionallyAddedAt: null })),
    );
    expect((await loadHelloInput("org-1", { now: NOW })).hasSquadToCarry).toBe(false);
  });

  it("a phoneless placeholder counts only when an admin added him: the seeding's own rule", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...ROW, rollingSquadEnabled: true });
    squadFromLastWeek(5);
    const rows = ["p1", "p2", "p3", "p4"].map((id) => attendanceRow("last", id));
    rows.push({ ...attendanceRow("last", "uncle"), user: { phoneNumber: null, email: "provisional+uncle-x@matchtime.local", isActive: true } } as never);
    dbMock.attendance.findMany.mockResolvedValue(rows);
    dbMock.membership.findMany.mockResolvedValue(
      ["p1", "p2", "p3", "p4", "uncle"].map((userId) => ({ userId, leftAt: null, provisionallyAddedAt: userId === "uncle" ? NOW : null })),
    );
    // A guest a player registered: not carried, 4 of 10.
    dbMock.attendanceEvent.findMany.mockResolvedValue([]);
    expect((await loadHelloInput("org-1", { now: NOW })).hasSquadToCarry).toBe(false);
    // Pasted in the admin group: carried, 5 of 10.
    dbMock.attendanceEvent.findMany.mockResolvedValue([{ userId: "uncle" }]);
    expect((await loadHelloInput("org-1", { now: NOW })).hasSquadToCarry).toBe(true);
    expect(dbMock.attendanceEvent.findMany.mock.calls[0][0].where).toMatchObject({
      orgId: "org-1",
      userId: { in: ["uncle"] },
      actorKind: "admin",
    });
  });

  it("a game that kicked off while the club was setting up is read as played: half its places is a squad, one website In is not", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...ROW, rollingSquadEnabled: true });
    dbMock.match.findMany.mockResolvedValue([fixtureMatch("kicked-off", -0.2, "UPCOMING"), fixtureMatch("next", 7, "UPCOMING")]);
    playersOn("kicked-off", 5);
    expect((await loadHelloInput("org-1", { now: NOW })).hasSquadToCarry).toBe(true);
    playersOn("kicked-off", 1);
    expect((await loadHelloInput("org-1", { now: NOW })).hasSquadToCarry).toBe(false);
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
    const five = ["p1", "p2", "p3", "p4", "p5"];
    const tx = {
      organisation: { findUnique: vi.fn(async () => ({ ...ROW, rollingSquadEnabled: true })) },
      clubConnect: { findFirst: vi.fn(async () => ({ userId: "u-tx" })) },
      membership: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => five.map((userId) => ({ userId, leftAt: null, provisionallyAddedAt: null }))),
      },
      user: { findUnique: vi.fn(async () => ({ name: "Tamsin Xu" })) },
      match: { findMany: vi.fn(async () => [fixtureMatch("last", -5, "COMPLETED"), fixtureMatch("next", 2, "UPCOMING")]) },
      attendance: { findMany: vi.fn(async () => five.map((id) => attendanceRow("last", id))) },
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

// ── 2026-11-03: the pool and partner clubs, from rows ──
describe("loadHelloInput: the pool and partner clubs", () => {
  const partners = (asks: number, helps: number) =>
    dbMock.clubPartnership.count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      "askerOrgId" in where ? asks : helps,
    );

  it("the vets: pool switch off, no partnership: both read as off, and the hello marks both optional", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...ROW, squadMode: "monthly", featurePlayerPool: false });
    const input = await loadHelloInput("org-1");
    expect(input.clubFacts).toEqual({ pool: false, partnersAsk: false, partnersHelp: false });
    const out = buildGroupHello(input);
    expect(out).toContain("🤝 *More games (optional, Ali can switch this on):*");
    expect(out).toContain("🌍 *Partner clubs (optional, Ali can switch this on):*");
    // Only ACTIVE partnerships count, each direction read on its own.
    expect(dbMock.clubPartnership.count.mock.calls.map((c) => c[0])).toEqual([
      { where: { askerOrgId: "org-1", status: "active" } },
      { where: { partnerOrgId: "org-1", status: "active" } },
    ]);
  });

  it("the pool is open only with the platform switch AND the club's own switch", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...ROW, featurePlayerPool: true });
    expect((await loadHelloInput("org-1")).clubFacts?.pool).toBe(true);
    dbMock.platformSetting.findUnique.mockResolvedValue({ on: false });
    expect((await loadHelloInput("org-1")).clubFacts?.pool).toBe(false);
    dbMock.platformSetting.findUnique.mockResolvedValue(null);
    expect((await loadHelloInput("org-1")).clubFacts?.pool).toBe(false);
    dbMock.platformSetting.findUnique.mockResolvedValue({ on: true });
    expect((await loadHelloInput("org-1", { env: { POOL_OFFERS_ENABLED: "0" } })).clubFacts?.pool).toBe(false);
    dbMock.organisation.findUnique.mockResolvedValue({ ...ROW, featurePlayerPool: false });
    expect((await loadHelloInput("org-1")).clubFacts?.pool).toBe(false);
    expect(dbMock.platformSetting.findUnique).toHaveBeenCalledWith({ where: { key: "pool-offers" }, select: { on: true } });
  });

  it("asking partners needs an active partnership, the one switch (no ask setting is read); being asked needs one the other way", async () => {
    partners(1, 0);
    expect((await loadHelloInput("org-1")).clubFacts).toMatchObject({ partnersAsk: true, partnersHelp: false });
    expect(askSettings.loadPartnerAskSettings).not.toHaveBeenCalled();
    partners(0, 2);
    expect((await loadHelloInput("org-1")).clubFacts).toMatchObject({ partnersAsk: false, partnersHelp: true });
    partners(1, 1);
    const both = await loadHelloInput("org-1");
    expect(both.clubFacts).toEqual({ pool: false, partnersAsk: true, partnersHelp: true });
    expect(buildGroupHello(both)).toContain(en.sj_hello_partners);
  });

  it("a read that fails, or a client without the reads, is a club with neither: never a false promise", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...ROW, featurePlayerPool: true });
    dbMock.clubPartnership.count.mockRejectedValue(new Error("db down"));
    expect((await loadHelloInput("org-1")).clubFacts).toEqual(NO_HELLO_CLUB_FACTS);
    const { clubPartnership: _c, platformSetting: _p, ...rest } = dbMock;
    expect((await loadHelloInput("org-1", { client: rest as unknown as HelloReadClient })).clubFacts).toEqual(NO_HELLO_CLUB_FACTS);
  });

  it("who chooses Man of the Match comes from the row", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...ROW, momChosenBy: "organisers" });
    const input = await loadHelloInput("org-1");
    expect(input.settings.momByOrganisers).toBe(true);
    expect(buildGroupHello(input)).toContain(en.sj_hello_mom_organisers);
    expect(buildGroupHello({ ...input, lang: "tr" })).toContain(tr.sj_hello_mom_organisers);
  });
});
