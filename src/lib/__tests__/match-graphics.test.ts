/**
 * The data behind the list poster and the team sheet (2026-10-14), read
 * from the database (mocked here at `@/lib/db`): the club's name and
 * language, the match day, kickoff and venue, the confirmed players and
 * the bench in their order, and the two teams with their labels. First
 * names only; never a phone number, never a rating.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  match: { findFirst: vi.fn(), findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { loadGraphicData, nextGraphicMatch } from "../match-graphics";

// Fri 16 Oct 2026, 21:00 London.
const DATE = new Date("2026-10-16T20:00:00Z");

const att = (userId: string, name: string | null, status: "CONFIRMED" | "BENCH", position: number) => ({
  userId,
  status,
  position,
  respondedAt: new Date("2026-10-12T10:00:00Z"),
  user: { id: userId, name },
});

function matchRow(over: Record<string, unknown> = {}) {
  return {
    id: "m-1",
    date: DATE,
    teamLabels: [],
    activity: {
      venue: "Goals Wimbledon",
      sport: { teamLabels: ["Red", "Yellow"] },
      org: { name: "FNF", language: "en", teamLabels: [] },
    },
    attendances: [
      att("u1", "Shehryar Khan", "CONFIRMED", 1),
      att("u2", "Ali Kaya", "CONFIRMED", 2),
      att("u3", "Ali Yılmaz", "CONFIRMED", 3),
      att("u4", "+447700900123", "CONFIRMED", 4),
      att("u5", "Bilal Ahmed", "BENCH", 5),
    ],
    teamAssignments: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadGraphicData: the list poster", () => {
  it("club, day, kickoff, venue, the confirmed names in order and the bench as reserves", async () => {
    dbMock.match.findFirst.mockResolvedValue(matchRow());
    const d = await loadGraphicData({ orgId: "org-fnf", matchId: "m-1", kind: "list" });
    expect(d).toEqual({
      kind: "list",
      clubName: "FNF",
      lang: "en",
      matchDate: DATE,
      kickoff: "21:00",
      venue: "Goals Wimbledon",
      players: ["Shehryar", "Ali K.", "Ali Y.", "Player"],
      reserves: ["Bilal"],
    });
  });

  it("reads the match only through its org: another club's match is not found", async () => {
    dbMock.match.findFirst.mockResolvedValue(null);
    expect(await loadGraphicData({ orgId: "org-other", matchId: "m-1", kind: "list" })).toBeNull();
    const where = dbMock.match.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({ id: "m-1", activity: { orgId: "org-other" } });
  });

  it("selects no phone number, no rating, nothing but a name off the user", async () => {
    dbMock.match.findFirst.mockResolvedValue(matchRow());
    await loadGraphicData({ orgId: "org-fnf", matchId: "m-1", kind: "list" });
    const select = dbMock.match.findFirst.mock.calls[0][0].select;
    expect(select.attendances.select.user).toEqual({ select: { id: true, name: true } });
    expect(JSON.stringify(select)).not.toMatch(/phone|rating|elo|seed/i);
  });

  it("only CONFIRMED and BENCH are read, in position order", async () => {
    dbMock.match.findFirst.mockResolvedValue(matchRow());
    await loadGraphicData({ orgId: "org-fnf", matchId: "m-1", kind: "list" });
    const a = dbMock.match.findFirst.mock.calls[0][0].select.attendances;
    expect(a.where).toEqual({ status: { in: ["CONFIRMED", "BENCH"] } });
    expect(a.orderBy).toEqual([{ position: "asc" }, { respondedAt: "asc" }]);
  });

  it("a Turkish club: its language comes through", async () => {
    dbMock.match.findFirst.mockResolvedValue(
      matchRow({ activity: { venue: "Saha", sport: { teamLabels: ["Red", "Yellow"] }, org: { name: "Erdal FC", language: "tr", teamLabels: [] } } }),
    );
    const d = await loadGraphicData({ orgId: "org-tr", matchId: "m-1", kind: "list" });
    expect(d).toMatchObject({ lang: "tr", clubName: "Erdal FC", players: ["Shehryar", "Ali K.", "Ali Y.", "Oyuncu"] });
  });
});

describe("loadGraphicData: the team sheet", () => {
  const teams = [
    { userId: "u1", team: "RED" },
    { userId: "u2", team: "YELLOW" },
    { userId: "u3", team: "RED" },
    { userId: "u4", team: "YELLOW" },
    { userId: "u-dropped", team: "YELLOW" },
  ];

  it("the two teams under their labels, players in squad order; a dropped player's old slot is not shown", async () => {
    dbMock.match.findFirst.mockResolvedValue(matchRow({ teamAssignments: teams }));
    const d = await loadGraphicData({ orgId: "org-fnf", matchId: "m-1", kind: "teams" });
    expect(d).toEqual({
      kind: "teams",
      clubName: "FNF",
      lang: "en",
      matchDate: DATE,
      kickoff: "21:00",
      venue: "Goals Wimbledon",
      teams: [
        { label: "Red", names: ["Shehryar", "Ali Y."] },
        { label: "Yellow", names: ["Ali K.", "Player"] },
      ],
    });
  });

  it("the club's own team labels win over the sport's, and the match's over both", async () => {
    dbMock.match.findFirst.mockResolvedValue(
      matchRow({
        teamAssignments: teams,
        teamLabels: ["", "Bibs"],
        activity: { venue: "V", sport: { teamLabels: ["Red", "Yellow"] }, org: { name: "FNF", language: "en", teamLabels: ["Team 1", "Team 2"] } },
      }),
    );
    const d = await loadGraphicData({ orgId: "org-fnf", matchId: "m-1", kind: "teams" });
    expect(d && d.kind === "teams" && d.teams.map((t) => t.label)).toEqual(["Team 1", "Bibs"]);
  });

  it("a Turkish club with the default sport labels: Kırmızı and Sarı", async () => {
    dbMock.match.findFirst.mockResolvedValue(
      matchRow({ teamAssignments: teams, activity: { venue: "V", sport: { teamLabels: ["Red", "Yellow"] }, org: { name: "X", language: "tr", teamLabels: [] } } }),
    );
    const d = await loadGraphicData({ orgId: "o", matchId: "m-1", kind: "teams" });
    expect(d && d.kind === "teams" && d.teams.map((t) => t.label)).toEqual(["Kırmızı", "Sarı"]);
  });

  it("no teams yet: null", async () => {
    dbMock.match.findFirst.mockResolvedValue(matchRow({ teamAssignments: [] }));
    expect(await loadGraphicData({ orgId: "org-fnf", matchId: "m-1", kind: "teams" })).toBeNull();
  });
});

describe("nextGraphicMatch", () => {
  it("the club's active registration match: the soonest open one, the same match the squad commands use", async () => {
    dbMock.match.findMany.mockResolvedValue([
      { id: "m-next", date: DATE, status: "UPCOMING" },
      { id: "m-later", date: new Date("2026-10-23T20:00:00Z"), status: "UPCOMING" },
    ]);
    expect(await nextGraphicMatch("org-fnf", new Date("2026-10-14T12:00:00Z"))).toBe("m-next");
    expect(dbMock.match.findMany.mock.calls[0][0].where).toEqual({
      activity: { orgId: "org-fnf" },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    });
  });
  it("none: null", async () => {
    dbMock.match.findMany.mockResolvedValue([]);
    expect(await nextGraphicMatch("org-fnf", new Date())).toBeNull();
  });
});
