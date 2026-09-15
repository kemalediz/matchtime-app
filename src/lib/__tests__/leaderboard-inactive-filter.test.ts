/**
 * The four prompt leaderboards drop players who have stopped turning up.
 *
 * Kemal, 2026-09-15, verbatim: "drop inactive players from the table
 * after three months, leave the balancer alone."
 *
 * Why removal and not a decayed rating — the argument belongs next to
 * the tests that enforce it, because "just fade them out instead" is the
 * change somebody will propose:
 *
 *   A leaderboard is a record of what happened. Decaying a number
 *   invents a rating the player never earned, and reads to them as a
 *   bug ("why did I drop, I didn't play?"). Removal is
 *   self-explanatory and reversible: one match back and they are in
 *   the table again with their real number, because the number was
 *   never touched.
 *
 * These tests cover the whole-block behaviour: which rows survive, that
 * the numbers on the survivors are untouched, that a returning player
 * comes back at their real value, that the aggregate denominator is
 * unaffected, and that the model is TOLD the table is filtered so it
 * never answers "we have no record of him".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const matchFindMany = vi.fn();
const orgFindUnique = vi.fn();
const attendanceFindMany = vi.fn();
const userFindMany = vi.fn();
const teamAssignmentFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    match: { findMany: (...a: unknown[]) => matchFindMany(...a) },
    organisation: { findUnique: (...a: unknown[]) => orgFindUnique(...a) },
    attendance: { findMany: (...a: unknown[]) => attendanceFindMany(...a) },
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
    teamAssignment: { findMany: (...a: unknown[]) => teamAssignmentFindMany(...a) },
  },
}));

/** MoM wins, keyed by match id, injected per-test. */
let momByMatch: Map<string, { playerId: string; name: string }> = new Map();
vi.mock("@/lib/mom", () => ({
  getMomSummaries: async (ids: string[]) => {
    const out = new Map();
    for (const id of ids) {
      const w = momByMatch.get(id);
      if (w) {
        out.set(id, { topPlayers: [{ playerId: w.playerId, name: w.name, votes: 5 }], totalVotes: 5, topCount: 5 });
      }
    }
    return out;
  },
}));
vi.mock("@/lib/team-labels", () => ({ resolveTeamLabels: () => ["Reds", "Yellows"] }));

import { loadRecentHistory, formatRecentHistoryBlock } from "@/lib/match-history";
import { RANKED_TABLE_INACTIVE_AFTER_MONTHS } from "@/lib/ranked-table-activity";

const ORG = "org-1";
const NOW = new Date("2026-09-15T12:00:00.000Z");

const day = 86_400_000;
/** A date `n` days before the frozen NOW. */
const ago = (n: number) => new Date(NOW.getTime() - n * day);

type Seed = {
  /** matchId -> match date */
  matches: Array<{ id: string; date: Date }>;
  /** userId -> the match ids they were CONFIRMED for */
  attendance: Record<string, string[]>;
  users: Array<{ id: string; name: string; matchRating: number }>;
  mom?: Record<string, string>; // matchId -> userId
};

function seed(s: Seed) {
  const ordered = [...s.matches].sort((a, b) => a.date.getTime() - b.date.getTime());
  matchFindMany.mockImplementation(async (args: Record<string, unknown>) => {
    const where = (args.where ?? {}) as Record<string, unknown>;
    if (where.status !== "COMPLETED") return ordered.map((m) => ({ id: m.id }));
    if (args.include) {
      const desc = (args.orderBy as { date?: string } | undefined)?.date === "desc";
      const rows = (desc ? [...ordered].reverse() : ordered).map((m) => ({
        ...m,
        redScore: 5,
        yellowScore: 4,
        activity: { sport: { teamLabels: null } },
      }));
      const take = args.take as number | undefined;
      return typeof take === "number" ? rows.slice(0, take) : rows;
    }
    // The aggregate query — ids AND dates, because the inactivity
    // filter needs to know when each match was played.
    return ordered.map((m) => ({ id: m.id, date: m.date }));
  });
  orgFindUnique.mockResolvedValue({ teamLabels: null });
  attendanceFindMany.mockResolvedValue(
    Object.entries(s.attendance).flatMap(([userId, matchIds]) =>
      matchIds.map((matchId) => ({ userId, matchId })),
    ),
  );
  userFindMany.mockResolvedValue(s.users);
  teamAssignmentFindMany.mockResolvedValue(s.users.map((u) => ({ userId: u.id })));
  momByMatch = new Map(
    Object.entries(s.mom ?? {}).map(([matchId, userId]) => [
      matchId,
      { playerId: userId, name: s.users.find((u) => u.id === userId)!.name },
    ]),
  );
}

/** The live shape at Sutton FC, reduced: one regular, one leaver whose
 *  last game is just over the line, one leaver just inside it. */
function suttonShaped() {
  seed({
    matches: [
      { id: "old", date: ago(RANKED_TABLE_INACTIVE_AFTER_MONTHS * 31 + 10) },
      { id: "justOut", date: ago(93) }, // three months and a day-ish
      { id: "justIn", date: ago(89) }, // three months less a day-ish
      { id: "recent", date: ago(7) },
    ],
    attendance: {
      regular: ["old", "justOut", "justIn", "recent"],
      leaver: ["old", "justOut"],
      stayer: ["old", "justIn"],
    },
    users: [
      { id: "regular", name: "Kemal", matchRating: 927 },
      { id: "leaver", name: "Ehtisham", matchRating: 1046 },
      { id: "stayer", name: "Najib", matchRating: 1048 },
    ],
    mom: { old: "leaver", justOut: "leaver", justIn: "stayer", recent: "regular" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe("the three-month boundary, across all four tables", () => {
  it("keeps a player whose last match is three months LESS a day ago", async () => {
    suttonShaped();
    const h = (await loadRecentHistory(ORG))!;
    const names = (rows: { name: string }[]) => rows.map((r) => r.name);
    expect(names(h.momLeaderboard)).toContain("Najib");
    expect(names(h.attendanceLeaderboard)).toContain("Najib");
    expect(names(h.eloTop)).toContain("Najib");
  });

  it("drops a player whose last match is three months AND a day ago", async () => {
    suttonShaped();
    const h = (await loadRecentHistory(ORG))!;
    const names = (rows: { name: string }[]) => rows.map((r) => r.name);
    expect(names(h.momLeaderboard)).not.toContain("Ehtisham");
    expect(names(h.attendanceLeaderboard)).not.toContain("Ehtisham");
    expect(names(h.eloTop)).not.toContain("Ehtisham");
    expect(names(h.eloBottom)).not.toContain("Ehtisham");
  });

  it("reports how many it hid, so a surface can say so out loud", async () => {
    suttonShaped();
    const h = (await loadRecentHistory(ORG))!;
    expect(h.inactivePlayersHidden).toBe(1);
  });
});

describe("a returning player comes back at their REAL number", () => {
  it("restores the exact rating and the exact counts, nothing reconstructed", async () => {
    suttonShaped();
    const before = (await loadRecentHistory(ORG))!;
    expect(before.eloTop.map((r) => r.name)).not.toContain("Ehtisham");

    // One new match. The leaver plays it. Nothing else changes — in
    // particular `matchRating` is still 1046, because removal never
    // touched it.
    vi.clearAllMocks();
    seed({
      matches: [
        { id: "old", date: ago(RANKED_TABLE_INACTIVE_AFTER_MONTHS * 31 + 10) },
        { id: "justOut", date: ago(93) },
        { id: "justIn", date: ago(89) },
        { id: "recent", date: ago(7) },
        { id: "comeback", date: ago(1) },
      ],
      attendance: {
        regular: ["old", "justOut", "justIn", "recent", "comeback"],
        leaver: ["old", "justOut", "comeback"],
        stayer: ["old", "justIn"],
      },
      users: [
        { id: "regular", name: "Kemal", matchRating: 927 },
        { id: "leaver", name: "Ehtisham", matchRating: 1046 },
        { id: "stayer", name: "Najib", matchRating: 1048 },
      ],
      mom: { old: "leaver", justOut: "leaver", justIn: "stayer", recent: "regular" },
    });
    const after = (await loadRecentHistory(ORG))!;

    const elo = after.eloTop.find((r) => r.name === "Ehtisham");
    expect(elo).toBeDefined();
    expect(elo!.value).toBe(1046); // unchanged, not decayed and not restored

    const mom = after.momLeaderboard.find((r) => r.name === "Ehtisham");
    expect(mom!.value).toBe(2); // both historical wins still counted

    const att = after.attendanceLeaderboard.find((r) => r.name === "Ehtisham");
    expect(att!.value).toBe(3);
    expect(after.inactivePlayersHidden).toBe(0);
  });
});

describe("a club-wide break does not empty the table", () => {
  it("survives Sutton's real 49-day summer shutdown with the squad intact", async () => {
    // Real dates, probed from production on 2026-09-15: the club played
    // 14 Jul 2026 then not again until 1 Sep 2026. Evaluated on the last
    // day of that break, every player from the final pre-break fixture
    // is ~7 weeks idle, which is inside a 3-month window by a wide
    // margin. This is exactly why the threshold is 3 months and not 2.
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    seed({
      matches: [
        { id: "m1", date: new Date("2026-06-30T19:00:00.000Z") },
        { id: "m2", date: new Date("2026-07-07T19:00:00.000Z") },
        { id: "m3", date: new Date("2026-07-14T19:00:00.000Z") },
      ],
      attendance: { a: ["m1", "m2", "m3"], b: ["m3"], c: ["m1", "m2"] },
      users: [
        { id: "a", name: "Kemal", matchRating: 927 },
        { id: "b", name: "Adam", matchRating: 993 },
        { id: "c", name: "Najib", matchRating: 1048 },
      ],
    });
    const h = (await loadRecentHistory(ORG))!;
    expect(h.attendanceLeaderboard.map((r) => r.name).sort()).toEqual(["Adam", "Kemal", "Najib"]);
    expect(h.inactivePlayersHidden).toBe(0);
  });
});

describe("the aggregates the filter must NOT touch", () => {
  it("leaves the attendance denominator at the org's TOTAL completed matches", async () => {
    // Kemal, 2026-05-15. Removing rows must never change the yardstick
    // the surviving rows are measured against, or everyone's percentage
    // silently inflates the moment somebody leaves the club.
    suttonShaped();
    const h = (await loadRecentHistory(ORG))!;
    expect(h.totalCompletedMatches).toBe(4);
    expect(h.attendanceLeaderboard.find((r) => r.name === "Kemal")!.detail).toBe("4/4 (100%)");
    expect(h.attendanceLeaderboard.find((r) => r.name === "Najib")!.detail).toBe("2/4 (50%)");
  });

  it("still lists a departed player in the per-match detail rows", async () => {
    // The match history is a record of what happened. The filter is
    // about TABLES, not about erasing the man from the results.
    suttonShaped();
    const h = (await loadRecentHistory(ORG))!;
    expect(h.recentMatches.some((m) => m.momLabel.includes("Ehtisham"))).toBe(true);
  });
});

describe("the block says the table is filtered", () => {
  it("tells the model the leaderboards are limited to recent players", async () => {
    suttonShaped();
    const block = formatRecentHistoryBlock((await loadRecentHistory(ORG))!);
    expect(block).toMatch(/last 3 months/i);
  });

  it("tells the model what to say about somebody who is missing", async () => {
    // Without this the bot answers "I have no record of Ehtisham" about
    // a man with two MoM awards. A silent filter is how "where did I
    // go?" questions start.
    suttonShaped();
    const block = formatRecentHistoryBlock((await loadRecentHistory(ORG))!);
    expect(block).toMatch(/not.*(never played|no record)|hasn't played/i);
  });

  it("says nothing about a filter when nothing was filtered", async () => {
    seed({
      matches: [{ id: "m1", date: ago(7) }],
      attendance: { a: ["m1"] },
      users: [{ id: "a", name: "Kemal", matchRating: 1000 }],
    });
    const block = formatRecentHistoryBlock((await loadRecentHistory(ORG))!);
    expect(block).not.toMatch(/last 3 months/i);
  });
});
