/**
 * The Guest players page's read model (slice L5b, 2026-10-24). Pure.
 * Upcoming, History, the guest card, the Report's maths (fill rate =
 * short games rescued) and its CSV.
 */
import { describe, expect, it } from "vitest";
import {
  askCountsAsShort,
  buildGuestPlayers,
  buildGuestReport,
  guestDisplayName,
  guestReportCsv,
  matchEnded,
  parseGuestPageQuery,
  periodOf,
  reportFilterOptions,
  settleGuestResult,
  type GuestGameFact,
  type GuestMatchFacts,
  type GuestPersonFacts,
  type ReportAskFact,
} from "../guest-report";
import { inviteToClubState } from "../club-invite";

const NOW = new Date("2026-10-24T12:00:00Z");
const ORG = "org-here";
const H = 60 * 60 * 1000;

function match(id: string, kickoff: string, over: Partial<GuestMatchFacts> = {}): GuestMatchFacts {
  return {
    matchId: id,
    kickoff: new Date(kickoff),
    durationMins: 60,
    status: new Date(kickoff) < NOW ? "COMPLETED" : "UPCOMING",
    sportId: "s-5",
    sportName: "Football 5-a-side",
    venue: "Goals Sutton",
    ...over,
  };
}

function game(userId: string, m: GuestMatchFacts, over: Partial<GuestGameFact> = {}): GuestGameFact {
  return { userId, orgId: ORG, match: m, attendance: "CONFIRMED", recorded: null, source: "partner", fromClub: "Sutton Lenders", ...over };
}

function person(userId: string, over: Partial<GuestPersonFacts> = {}): GuestPersonFacts {
  return { userId, name: "Ali Khan", member: false, pool: "none", poolSports: [], openInvitation: false, ...over };
}

describe("guestDisplayName: first name and last initial", () => {
  it("keeps the first name and the last word's initial", () => {
    expect(guestDisplayName("Ali Khan")).toBe("Ali K");
    expect(guestDisplayName("  mehmet ali  yilmaz ")).toBe("mehmet Y");
    expect(guestDisplayName("Şükrü Öztürk")).toBe("Şükrü Ö");
  });
  it("a single name stays, an already short form is unchanged, none is null", () => {
    expect(guestDisplayName("Ali")).toBe("Ali");
    expect(guestDisplayName("Ali K")).toBe("Ali K");
    expect(guestDisplayName("Ali K.")).toBe("Ali K");
    expect(guestDisplayName("")).toBeNull();
    expect(guestDisplayName(null)).toBeNull();
  });
});

describe("settleGuestResult: one rule for recorded and pre-pool guests", () => {
  const past = match("m1", "2026-10-20T19:00:00Z");
  const future = match("m2", "2026-10-28T19:00:00Z");

  it("a match has ended once COMPLETED or kickoff plus its length has passed", () => {
    expect(matchEnded(past, NOW)).toBe(true);
    expect(matchEnded(future, NOW)).toBe(false);
    const running = match("m3", new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(), { status: "TEAMS_PUBLISHED" });
    expect(matchEnded(running, NOW)).toBe(false);
    expect(matchEnded({ ...running, status: "COMPLETED" }, NOW)).toBe(true);
  });

  it("a recorded outcome other than booked wins", () => {
    expect(settleGuestResult(game("u", past, { recorded: "no-show" }), NOW)).toBe("no-show");
    expect(settleGuestResult(game("u", past, { recorded: "late-cancel", attendance: "DROPPED" }), NOW)).toBe("late-cancel");
  });

  it("a cancelled match is not a game", () => {
    expect(settleGuestResult(game("u", { ...past, status: "CANCELLED" }), NOW)).toBeNull();
    expect(settleGuestResult(game("u", { ...future, status: "CANCELLED" }, { recorded: "booked" }), NOW)).toBeNull();
  });

  it("before the game: booked, or withdrawn once he dropped out", () => {
    expect(settleGuestResult(game("u", future), NOW)).toBe("booked");
    expect(settleGuestResult(game("u", future, { attendance: "BENCH" }), NOW)).toBe("booked");
    expect(settleGuestResult(game("u", future, { attendance: "DROPPED" }), NOW)).toBe("withdrawn");
    expect(settleGuestResult(game("u", future, { recorded: "booked", attendance: null }), NOW)).toBe("booked");
  });

  it("after the game, a pre-pool guest (no record): confirmed is played, dropped is withdrawn, a bench place never called up is not a game", () => {
    expect(settleGuestResult(game("u", past), NOW)).toBe("played");
    expect(settleGuestResult(game("u", past, { attendance: "DROPPED" }), NOW)).toBe("withdrawn");
    expect(settleGuestResult(game("u", past, { attendance: "BENCH" }), NOW)).toBeNull();
  });

  it("after the game, a recorded place (slice L7): the RECORD decides, never his attendance row", () => {
    // Still booked and not settled: the organisers may yet mark a no-show,
    // so it is "booked" (result due), not played.
    expect(settleGuestResult(game("u", past, { recorded: "booked" }), NOW)).toBe("booked");
    // The cron recorded it played once the window closed.
    expect(settleGuestResult(game("u", past, { recorded: "played", settled: true }), NOW)).toBe("played");
    // Settled and still booked: a bench place never called up, not a game.
    expect(settleGuestResult(game("u", past, { recorded: "booked", settled: true }), NOW)).toBeNull();
    // Not settled yet: a bench place or a place given up is what it will be.
    expect(settleGuestResult(game("u", past, { recorded: "booked", attendance: "BENCH" }), NOW)).toBeNull();
    expect(settleGuestResult(game("u", past, { attendance: null, recorded: "booked" }), NOW)).toBe("withdrawn");
  });
});

describe("Upcoming and History around the no-show window (slice L7)", () => {
  it("a game that has ended with its result due leaves Upcoming and shows in History as booked", () => {
    const ended = match("m-end", "2026-10-24T09:00:00Z");
    const r = buildGuestPlayers({ orgId: ORG, now: NOW, lang: "en", games: [game("ali", ended, { source: "pool", fromClub: null, recorded: "booked" })], people: [person("ali")] });
    expect(r.upcoming).toEqual([]);
    expect(r.history[0].games).toEqual([{ matchId: "m-end", kickoff: ended.kickoff, venue: "Goals Sutton", result: "booked" }]);
  });
});

describe("buildGuestPlayers: Upcoming, History and the cards", () => {
  const tue = match("m-tue", "2026-10-27T19:00:00Z", { venue: "Goals Sutton" });
  const sat = match("m-sat", "2026-10-31T09:00:00Z", { venue: "Powerleague" });
  const old1 = match("m-old1", "2026-09-01T19:00:00Z");
  const old2 = match("m-old2", "2026-10-06T19:00:00Z", { venue: "Powerleague" });

  const build = (games: GuestGameFact[], people: GuestPersonFacts[]) =>
    buildGuestPlayers({ orgId: ORG, now: NOW, lang: "en", games, people });

  it("Upcoming: accepted guests grouped by match, soonest first; withdrawn and other clubs' games left out", () => {
    const r = build(
      [
        game("ali", sat, { source: "pool", fromClub: null, recorded: "booked" }),
        game("bob", tue, { attendance: "BENCH" }),
        game("cem", tue),
        game("dan", tue, { attendance: "DROPPED" }),
        game("eve", tue, { orgId: "org-other" }),
      ],
      [person("ali"), person("bob"), person("cem"), person("dan"), person("eve")],
    );
    expect(r.upcoming.map((g) => g.matchId)).toEqual(["m-tue", "m-sat"]);
    expect(r.upcoming[0].guests).toEqual([
      { userId: "bob", onBench: true },
      { userId: "cem", onBench: false },
    ]);
    expect(r.upcoming[0]).toMatchObject({ venue: "Goals Sutton", kickoff: tue.kickoff });
    expect(r.upcoming[1].guests).toEqual([{ userId: "ali", onBench: false }]);
  });

  it("History: every past guest with each game here, newest first, and whether he joined", () => {
    const r = build(
      [
        game("ali", old1),
        game("ali", old2, { recorded: "no-show" }),
        game("bob", old2, { attendance: "DROPPED" }),
        game("cem", tue),
        game("ali", old1, { orgId: "org-other", match: match("m-x", "2026-08-01T19:00:00Z") }),
      ],
      [person("ali"), person("bob", { member: true }), person("cem")],
    );
    expect(r.history.map((h) => h.userId)).toEqual(["ali", "bob"]);
    expect(r.history[0].games.map((g) => [g.matchId, g.result])).toEqual([
      ["m-old2", "no-show"],
      ["m-old1", "played"],
    ]);
    expect(r.history[0].joined).toBe(false);
    expect(r.history[1].joined).toBe(true);
    expect(r.history[1].games.map((g) => g.result)).toEqual(["withdrawn"]);
  });

  it("the card: first name and last initial, source, record across clubs, games played here", () => {
    const r = build(
      [
        game("ali", old1, { source: "pool", fromClub: null, recorded: "played" }),
        game("ali", old2, { source: "pool", fromClub: null, recorded: "no-show" }),
        game("ali", tue, { source: "pool", fromClub: null, recorded: "booked" }),
        game("ali", old1, { orgId: "org-other", match: match("m-x", "2026-08-01T19:00:00Z"), recorded: "played" }),
      ],
      [person("ali", { name: "Ali Khan", pool: "active", poolSports: [{ sport: "football", otherName: "", level: "advanced", levelText: null }, { sport: "other", otherName: "Futsal", level: null, levelText: "decent" }] })],
    );
    const c = r.cards.ali;
    expect(c.name).toBe("Ali K");
    expect(c.source).toBe("pool");
    expect(c.fromClub).toBeNull();
    expect(c.record).toEqual({ played: 2, missed: 1 });
    expect(c.gamesHere).toBe(1);
    expect(c.sports).toEqual([
      { label: "Football", level: "Advanced" },
      { label: "Futsal", level: "decent" },
    ]);
    expect(c.invite).toBe("available");
  });

  it("the card of a partner guest with no pool profile: his club, the sports he played here, no level", () => {
    const r = build([game("bob", old1), game("bob", old2)], [person("bob", { name: null })]);
    const c = r.cards.bob;
    expect(c.name).toBeNull();
    expect(c.source).toBe("partner");
    expect(c.fromClub).toBe("Sutton Lenders");
    expect(c.sports).toEqual([{ label: "Football 5-a-side", level: null }]);
    expect(c.gamesHere).toBe(2);
  });

  it("the card carries no phone, area or other club: only the fields it lists", () => {
    const r = build([game("ali", old1)], [person("ali")]);
    expect(Object.keys(r.cards.ali).sort()).toEqual(["blocked", "fromClub", "gamesHere", "invite", "name", "record", "source", "sports", "userId"]);
  });

  it("slice L7: the card says whether THIS club stopped offering him its games", () => {
    expect(build([game("ali", old1)], [person("ali")]).cards.ali.blocked).toBe(false);
    expect(build([game("ali", old1)], [person("ali", { clubBlocked: true })]).cards.ali.blocked).toBe(true);
  });

  it("the latest game decides the source shown", () => {
    const r = build(
      [game("ali", old1, { source: "partner" }), game("ali", old2, { source: "pool", fromClub: null, recorded: "played" })],
      [person("ali", { pool: "active" })],
    );
    expect(r.cards.ali.source).toBe("pool");
  });
});

describe("inviteToClubState: who may be invited to the club", () => {
  const base = { member: false, playedHere: 1, openInvitation: false, pool: "none" as const };
  it("any guest with at least one game here, however long ago, not a member", () => {
    expect(inviteToClubState(base)).toBe("available");
    expect(inviteToClubState({ ...base, pool: "active" })).toBe("available");
    expect(inviteToClubState({ ...base, pool: "paused" })).toBe("available");
  });
  it("hidden for a member or a guest with no game played here", () => {
    expect(inviteToClubState({ ...base, member: true })).toBe("hidden");
    expect(inviteToClubState({ ...base, playedHere: 0 })).toBe("hidden");
  });
  it("greyed out once he stopped messages or deleted his profile", () => {
    expect(inviteToClubState({ ...base, pool: "stopped" })).toBe("unavailable");
    expect(inviteToClubState({ ...base, pool: "deleted" })).toBe("unavailable");
  });
  it("an open invitation shows as invited", () => {
    expect(inviteToClubState({ ...base, openInvitation: true })).toBe("invited");
  });
});

describe("periodOf: London months and Aug to Jul seasons", () => {
  it("a month is the London calendar month", () => {
    expect(periodOf(new Date("2026-10-31T23:30:00Z"), "month").key).toBe("2026-10");
    // 00:30 London on 1 Nov (GMT) is still 1 Nov
    expect(periodOf(new Date("2026-11-01T00:30:00Z"), "month").key).toBe("2026-11");
    // 23:30 UTC on 31 Aug is 00:30 London on 1 Sep (BST)
    expect(periodOf(new Date("2026-08-31T23:30:00Z"), "month").key).toBe("2026-09");
  });
  it("a season runs 1 August to 31 July", () => {
    expect(periodOf(new Date("2026-08-01T10:00:00Z"), "season").key).toBe("2026/27");
    expect(periodOf(new Date("2027-07-31T10:00:00Z"), "season").key).toBe("2026/27");
    expect(periodOf(new Date("2026-07-31T10:00:00Z"), "season").key).toBe("2025/26");
    expect(periodOf(new Date("2026-08-01T10:00:00Z"), "season").start.toISOString()).toBe("2026-07-31T23:00:00.000Z");
  });
});

describe("buildGuestReport: the maths", () => {
  // October: three short games. m-a rescued (a guest played), m-b asked but
  // no guest played, m-c cancelled for want of players. m-d upcoming: not
  // decided yet. September: one short game, rescued.
  const mA = match("m-a", "2026-10-06T19:00:00Z");
  const mB = match("m-b", "2026-10-13T19:00:00Z", { venue: "Powerleague", sportId: "s-7", sportName: "Football 7-a-side" });
  const mC = match("m-c", "2026-10-20T19:00:00Z", { status: "CANCELLED" });
  const mD = match("m-d", "2026-10-29T19:00:00Z");
  const mS = match("m-s", "2026-09-15T19:00:00Z");
  const mN = match("m-n", "2026-10-08T19:00:00Z"); // a guest, no ask
  const matches = [mA, mB, mC, mD, mS, mN];

  const asks: ReportAskFact[] = [
    { matchId: "m-a", kind: "pool", status: "filled", reached: 4 },
    { matchId: "m-a", kind: "partner", status: "filled", reached: 2 },
    { matchId: "m-b", kind: "pool", status: "closed", reached: 3 },
    { matchId: "m-c", kind: "partner", status: "expired", reached: 0 },
    { matchId: "m-d", kind: "pool", status: "open", reached: 4 },
    { matchId: "m-s", kind: "partner", status: "filled", reached: 1 },
    // Not short: the club withdrew the ask (filled from its own players) or the partner refused.
    { matchId: "m-n", kind: "partner", status: "cancelled", reached: 0 },
    { matchId: "m-n", kind: "pool", status: "cancelled", reached: 0 },
  ];

  const games: GuestGameFact[] = [
    game("ali", mA, { source: "pool", fromClub: null, recorded: "played" }),
    game("bob", mA),
    game("cem", mB, { source: "pool", fromClub: null, recorded: "no-show" }),
    game("dan", mB, { attendance: "DROPPED" }),
    game("eve", mD, { source: "pool", fromClub: null, recorded: "booked" }),
    game("bob", mS),
    game("fay", mN),
    game("ali", mA, { orgId: "org-other" }), // never counted here
  ];

  const input = { orgId: ORG, now: NOW, games, asks, matches, members: new Set(["bob", "fay"]) };

  it("asks that count as a short game: any but a cancelled or refused one", () => {
    expect(askCountsAsShort({ kind: "pool", status: "open" })).toBe(true);
    expect(askCountsAsShort({ kind: "pool", status: "cancelled" })).toBe(false);
    expect(askCountsAsShort({ kind: "partner", status: "awaiting-approval" })).toBe(true);
    expect(askCountsAsShort({ kind: "partner", status: "refused" })).toBe(false);
    expect(askCountsAsShort({ kind: "partner", status: "cancelled" })).toBe(false);
  });

  it("by month: asked, accepted, played, no-shows, became members, short games, rescued, fill rate", () => {
    const r = buildGuestReport(input, { period: "month" });
    expect(r.rows.map((x) => x.key)).toEqual(["2026-10", "2026-09"]);
    expect(r.rows[0]).toMatchObject({
      asked: 4 + 2 + 3 + 0 + 4,
      accepted: 6, // ali, bob (m-a), cem, dan (m-b), eve (m-d), fay (m-n)
      played: 3, // ali, bob, fay
      noShows: 1,
      becameMembers: 1, // fay: first game here in October and a member now. Bob's first game was September.
      shortGames: 3, // m-a, m-b, m-c (m-d undecided, m-n not short)
      rescued: 1,
    });
    expect(r.rows[0].fillRate).toBeCloseTo(1 / 3);
    expect(r.rows[1]).toMatchObject({ asked: 1, accepted: 1, played: 1, noShows: 0, becameMembers: 1, shortGames: 1, rescued: 1, fillRate: 1 });
    expect(r.total).toMatchObject({ asked: 14, accepted: 7, played: 4, noShows: 1, becameMembers: 2, shortGames: 4, rescued: 2, fillRate: 0.5 });
  });

  it("by season: one row for 2026/27", () => {
    const r = buildGuestReport(input, { period: "season" });
    expect(r.rows.map((x) => x.key)).toEqual(["2026/27"]);
    expect(r.rows[0]).toMatchObject({ accepted: 7, shortGames: 4, rescued: 2, fillRate: 0.5 });
  });

  it("filters by sport and by venue apply to every column", () => {
    const bySport = buildGuestReport(input, { period: "month", sportId: "s-7" });
    expect(bySport.total).toMatchObject({ asked: 3, accepted: 2, played: 0, noShows: 1, shortGames: 1, rescued: 0, fillRate: 0 });
    const byVenue = buildGuestReport(input, { period: "month", venue: "Goals Sutton" });
    expect(byVenue.total).toMatchObject({ shortGames: 3, rescued: 2 });
  });

  it("no short games: the fill rate is null, not 0", () => {
    const r = buildGuestReport({ ...input, asks: [] }, { period: "month" });
    expect(r.total.fillRate).toBeNull();
    expect(r.total.shortGames).toBe(0);
  });

  it("nothing at all: no rows and a zero total", () => {
    const r = buildGuestReport({ ...input, games: [], asks: [], matches: [] }, { period: "month" });
    expect(r.rows).toEqual([]);
    expect(r.total).toMatchObject({ asked: 0, accepted: 0, fillRate: null });
  });

  it("the filter choices are the club's sports and venues, sorted", () => {
    expect(reportFilterOptions(matches)).toEqual({
      sports: [
        { id: "s-5", name: "Football 5-a-side" },
        { id: "s-7", name: "Football 7-a-side" },
      ],
      venues: ["Goals Sutton", "Powerleague"],
    });
  });

  it("CSV: a header, one line per period and the total, quoted where needed, fill rate as a percentage", () => {
    const r = buildGuestReport(input, { period: "month" });
    const csv = guestReportCsv(r, {
      header: ["Period", "Asked", "Accepted", "Played", "No-shows", "Became members", "Short games", "Rescued", "Fill rate"],
      periodLabel: (key) => (key === "2026-10" ? "October, 2026" : key),
      totalLabel: "Total",
    });
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("Period,Asked,Accepted,Played,No-shows,Became members,Short games,Rescued,Fill rate");
    expect(lines[1]).toBe('"October, 2026",13,6,3,1,1,3,1,33%');
    expect(lines[2]).toBe("2026-09,1,1,1,0,1,1,1,100%");
    expect(lines[3]).toBe("Total,14,7,4,1,2,4,2,50%");
    const empty = guestReportCsv(buildGuestReport({ ...input, asks: [] }, { period: "month" }), {
      header: ["P"],
      periodLabel: (k) => k,
      totalLabel: "Total",
    });
    expect(empty.trimEnd().split("\r\n").at(-1)?.endsWith(",")).toBe(true);
  });

  it("a CSV cell that starts like a formula is neutralised", () => {
    const r = buildGuestReport(input, { period: "month" });
    const csv = guestReportCsv(r, { header: ["=cmd"], periodLabel: (k) => `+${k}`, totalLabel: "@Total" });
    expect(csv).not.toMatch(/(^|,)[=+@-]/m);
  });
});

describe("parseGuestPageQuery: the page's tab and report filters from the URL", () => {
  it("defaults to Upcoming, by month, no filters", () => {
    expect(parseGuestPageQuery({})).toEqual({ tab: "upcoming", period: "month", sportId: null, venue: null });
  });
  it("reads a known tab, period and the filters; ignores anything else", () => {
    expect(parseGuestPageQuery({ tab: "report", period: "season", sport: "s-5", venue: "Goals Sutton" })).toEqual({
      tab: "report",
      period: "season",
      sportId: "s-5",
      venue: "Goals Sutton",
    });
    expect(parseGuestPageQuery({ tab: "admin", period: "year", sport: "", venue: ["a", "b"] })).toEqual({
      tab: "upcoming",
      period: "month",
      sportId: null,
      venue: "a",
    });
  });
});
