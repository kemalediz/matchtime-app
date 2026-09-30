/**
 * The web "Squad leaderboard" follows the same rule as the chat ones —
 * and the player looking at his OWN page is the one exception.
 *
 * `/profile/stats` advertises "how you stack up against the squad". A
 * player back after four months who opens the one page in the product
 * that is about him, and finds himself missing from it, has been told by
 * a page with his own name at the top that he does not exist. So the
 * ranked table is filtered, and the viewer gets his own row underneath
 * it: unranked, with the date he last played.
 *
 * Team of the Season follows the same rule, and the same minimum of
 * rated matches as the squad leaderboard (Kemal, 2026-09-30). See
 * TEAM_OF_SEASON_FOLLOWS_ACTIVITY_RULE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const matchFindMany = vi.fn();
const userFindMany = vi.fn();
const sportFindFirst = vi.fn();
const attendanceFindMany = vi.fn();
const positionFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    match: { findMany: (...a: unknown[]) => matchFindMany(...a) },
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
    sport: { findFirst: (...a: unknown[]) => sportFindFirst(...a) },
    attendance: { findMany: (...a: unknown[]) => attendanceFindMany(...a) },
    playerActivityPosition: { findMany: (...a: unknown[]) => positionFindMany(...a) },
    organisation: { findUnique: vi.fn() },
    momVote: { findMany: vi.fn() },
    membership: { findMany: vi.fn() },
  },
}));

import { loadRatingLeaderboard, loadTeamOfSeason } from "@/lib/player-stats";
import { GROUP_RATINGS_MIN_GAMES, TEAM_OF_SEASON_MIN_GAMES } from "@/lib/pipeline/stats-answer";

const ORG = "org-1";
const NOW = new Date("2026-09-15T12:00:00.000Z");
const day = 86_400_000;
const ago = (n: number) => new Date(NOW.getTime() - n * day);

/** Three players: a regular, someone who last played 100 days ago
 *  (out), and someone who last played 80 days ago (in). Ratings are
 *  chosen so the leaver would top the table if he were still in it —
 *  otherwise the filter could pass by accident. */
function seed() {
  const matches = [
    { id: "m1", date: ago(180) },
    { id: "m2", date: ago(100) },
    { id: "m3", date: ago(80) },
    { id: "m4", date: ago(5) },
  ];
  const ratings: Record<string, Array<{ playerId: string; score: number }>> = {
    m1: [
      { playerId: "regular", score: 6 },
      { playerId: "leaver", score: 9 },
      { playerId: "stayer", score: 7 },
    ],
    m2: [
      { playerId: "regular", score: 6 },
      { playerId: "leaver", score: 9 },
    ],
    m3: [
      { playerId: "regular", score: 7 },
      { playerId: "stayer", score: 7 },
    ],
    m4: [{ playerId: "regular", score: 8 }],
  };
  matchFindMany.mockImplementation(async () =>
    matches.map((m) => ({ ...m, ratings: ratings[m.id] })),
  );
  userFindMany.mockResolvedValue([
    { id: "regular", name: "Kemal" },
    { id: "leaver", name: "Ehtisham" },
    { id: "stayer", name: "Najib" },
  ]);
  attendanceFindMany.mockResolvedValue([
    { userId: "regular", match: { date: ago(5) } },
    { userId: "leaver", match: { date: ago(100) } },
    { userId: "stayer", match: { date: ago(80) } },
  ]);
  sportFindFirst.mockResolvedValue({
    name: "Football",
    playersPerTeam: 7,
    positions: ["GK", "DEF", "MID", "FWD"],
    positionComposition: { GK: 1, DEF: 1, MID: 1 },
  });
  positionFindMany.mockResolvedValue([
    { userId: "regular", positions: ["MID"] },
    { userId: "leaver", positions: ["GK"] },
    { userId: "stayer", positions: ["DEF"] },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  seed();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("loadRatingLeaderboard drops players who have stopped turning up", () => {
  it("leaves out the player whose last match is over three months ago", async () => {
    const rows = await loadRatingLeaderboard(ORG, { minGames: 1 });
    expect(rows.map((r) => r.name)).not.toContain("Ehtisham");
  });

  it("keeps the player whose last match is inside the window", async () => {
    const rows = await loadRatingLeaderboard(ORG, { minGames: 1 });
    expect(rows.map((r) => r.name)).toContain("Najib");
  });

  it("closes the ranks up — no gap where the dropped player was", async () => {
    const rows = await loadRatingLeaderboard(ORG, { minGames: 1 });
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("does not alter the surviving players' averages", async () => {
    const rows = await loadRatingLeaderboard(ORG, { minGames: 1 });
    // Kemal: (6+6+7+8)/4 = 6.75. Removing Ehtisham must not touch it.
    expect(rows.find((r) => r.name === "Kemal")!.avg).toBeCloseTo(6.75, 5);
  });
});

describe("the viewer sees their own row on their own page", () => {
  it("returns the viewer unranked when they have aged out", async () => {
    const rows = await loadRatingLeaderboard(ORG, { minGames: 1, viewerId: "leaver" });
    const me = rows.find((r) => r.userId === "leaver");
    expect(me).toBeDefined();
    expect(me!.inactive).toBe(true);
    expect(me!.rank).toBeNull();
  });

  it("gives the viewer's row their real average, not a decayed one", async () => {
    const rows = await loadRatingLeaderboard(ORG, { minGames: 1, viewerId: "leaver" });
    // Ehtisham: (9+9)/2 = 9. The number was never touched.
    expect(rows.find((r) => r.userId === "leaver")!.avg).toBeCloseTo(9, 5);
  });

  it("tells the row when they last played, so the page can say why", async () => {
    const rows = await loadRatingLeaderboard(ORG, { minGames: 1, viewerId: "leaver" });
    expect(rows.find((r) => r.userId === "leaver")!.lastPlayed).toEqual(ago(100));
  });

  it("puts the viewer's unranked row last, below everyone still ranked", async () => {
    const rows = await loadRatingLeaderboard(ORG, { minGames: 1, viewerId: "leaver" });
    expect(rows.at(-1)!.userId).toBe("leaver");
    expect(rows.slice(0, -1).every((r) => r.rank !== null)).toBe(true);
  });

  it("does not duplicate or unrank a viewer who is still active", async () => {
    const rows = await loadRatingLeaderboard(ORG, { minGames: 1, viewerId: "regular" });
    expect(rows.filter((r) => r.userId === "regular")).toHaveLength(1);
    expect(rows.find((r) => r.userId === "regular")!.inactive).toBe(false);
    expect(rows.find((r) => r.userId === "regular")!.rank).toBe(2);
  });

  it("exempts only the viewer — other inactive players stay out", async () => {
    const rows = await loadRatingLeaderboard(ORG, { minGames: 1, viewerId: "regular" });
    expect(rows.map((r) => r.userId)).not.toContain("leaver");
  });

  it("adds nothing for a viewer who has never been rated at all", async () => {
    const rows = await loadRatingLeaderboard(ORG, { minGames: 1, viewerId: "stranger" });
    expect(rows.map((r) => r.userId)).not.toContain("stranger");
  });
});

/**
 * `viewerId` CAN ONLY ADD THE VIEWER'S OWN ROW. IT CAN NEVER CHANGE,
 * REORDER OR REMOVE A CLUBMATE'S.
 *
 * This is the property `overall-rating-visibility.test.ts` was reaching
 * for when it asserted that `loadRatingLeaderboard` has no `viewerId`
 * parameter at all. That ban was a static proxy, written when the only
 * imaginable reason for this function to learn who is looking was to
 * start personalising what it shows — which is exactly the leak
 * decision 4 of `MDs/club-scoped-ratings-design-2026-09-18.md` forbids:
 * a club rating is the club's own opinion, formed inside the club, and
 * every member of the club is meant to see it.
 *
 * The three-month rule needs the viewer's id for the opposite purpose:
 * to show him MORE, namely himself, on the one page that is about him.
 * So the proxy had to go and the real property had to be pinned
 * directly. This is strictly the stronger check of the two: a regex over
 * the signature would happily accept a future `hideOthersFrom` option,
 * and this does not.
 */
describe("the viewer argument is purely additive", () => {
  it("leaves every other player's row byte-identical, with and without a viewer", async () => {
    const anonymous = await loadRatingLeaderboard(ORG, { minGames: 1 });
    const asLeaver = await loadRatingLeaderboard(ORG, { minGames: 1, viewerId: "leaver" });

    // Everything the viewer did not add is exactly what an anonymous
    // reader gets: same players, same order, same ranks, same averages.
    expect(asLeaver.filter((r) => !r.inactive)).toEqual(anonymous);
  });

  it("adds exactly one row, and it is the viewer's own", async () => {
    const anonymous = await loadRatingLeaderboard(ORG, { minGames: 1 });
    const asLeaver = await loadRatingLeaderboard(ORG, { minGames: 1, viewerId: "leaver" });

    expect(asLeaver).toHaveLength(anonymous.length + 1);
    const added = asLeaver.filter((r) => !anonymous.some((a) => a.userId === r.userId));
    expect(added.map((r) => r.userId)).toEqual(["leaver"]);
  });

  it("shows a clubmate's club rating to every viewer alike", async () => {
    // Decision 4: club ratings are visible inside the club. Whoever is
    // looking, Kemal's number is Kemal's number.
    const seenBy = async (viewerId?: string) =>
      (await loadRatingLeaderboard(ORG, { minGames: 1, viewerId })).find(
        (r) => r.userId === "regular",
      )!.avg;

    expect(await seenBy(undefined)).toBeCloseTo(6.75, 5);
    expect(await seenBy("regular")).toBeCloseTo(6.75, 5);
    expect(await seenBy("stayer")).toBeCloseTo(6.75, 5);
    expect(await seenBy("leaver")).toBeCloseTo(6.75, 5);
  });
});

describe("Team of the Season follows the squad leaderboard's rules (Kemal, 2026-09-30)", () => {
  it("leaves out a player who has not played in three months, however well rated", async () => {
    const tots = await loadTeamOfSeason(ORG, { minGames: 1 });
    expect(tots!.formation.map((s) => s.name)).not.toContain("Ehtisham");
  });

  it("keeps a player whose last match is inside the window", async () => {
    const tots = await loadTeamOfSeason(ORG, { minGames: 1 });
    expect(tots!.formation.map((s) => s.name)).toEqual(expect.arrayContaining(["Kemal", "Najib"]));
  });

  it("gives the vacated slot to the best active player, not to nobody", async () => {
    // Ehtisham was the only GK. With him out, the GK slot falls back to
    // the best remaining player rather than coming back empty.
    const tots = await loadTeamOfSeason(ORG, { minGames: 1 });
    expect(tots!.formation.find((s) => s.position === "GK")).toBeDefined();
    expect(tots!.formation.every((s) => s.userId !== "leaver")).toBe(true);
  });

  it("brings him back the moment he plays again", async () => {
    attendanceFindMany.mockResolvedValue([
      { userId: "regular", match: { date: ago(5) } },
      { userId: "leaver", match: { date: ago(2) } },
      { userId: "stayer", match: { date: ago(80) } },
    ]);
    const tots = await loadTeamOfSeason(ORG, { minGames: 1 });
    expect(tots!.formation[0]!.name).toBe("Ehtisham");
  });

  it("by default needs the squad leaderboard's minimum of rated matches", async () => {
    // Kemal has 4 rated matches, Najib 2. With the leaderboard's minimum
    // of three, only Kemal qualifies.
    const tots = await loadTeamOfSeason(ORG);
    expect(tots!.formation.map((s) => s.name)).toEqual(["Kemal"]);
  });

  it("uses exactly the group ratings list's minimum, not a second copy of it", () => {
    expect(TEAM_OF_SEASON_MIN_GAMES).toBe(GROUP_RATINGS_MIN_GAMES);
    expect(TEAM_OF_SEASON_MIN_GAMES).toBe(3);
  });
});

describe("loadRatingLeaderboard cut to a period (2026-09-23)", () => {
  it("asks the database only for the matches on or after `since`", async () => {
    await loadRatingLeaderboard(ORG, { minGames: 1, since: ago(90) });
    const where = (matchFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.date).toEqual({ gte: ago(90) });
  });

  it("with no `since` the whole record is read, exactly as before", async () => {
    await loadRatingLeaderboard(ORG, { minGames: 1 });
    const where = (matchFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).not.toHaveProperty("date");
  });
});

/**
 * THE SQUAD LEADERBOARD NEEDS THREE RATED MATCHES (Kemal, 2026-09-30):
 * "i like the rule for the leaderboard, implement it". The same rule as
 * Team of the Season, from the same constant: at least
 * `GROUP_RATINGS_MIN_GAMES` rated matches AND a match in the last three
 * months. One lucky night no longer puts a newcomer at the top of the
 * table with a "1 game" tag.
 *
 * In the seed: Kemal has 4 rated matches and is active, Najib 2 and
 * active, Ehtisham 2 and gone for 100 days.
 */
describe("the squad leaderboard needs the group's minimum of rated matches (Kemal, 2026-09-30)", () => {
  it("by default ranks only players with GROUP_RATINGS_MIN_GAMES rated matches", async () => {
    const rows = await loadRatingLeaderboard(ORG);
    expect(rows.map((r) => r.name)).toEqual(["Kemal"]);
    expect(rows[0]!.rank).toBe(1);
  });

  it("no ranked row can carry a provisional 'early days' tag any more", async () => {
    const rows = await loadRatingLeaderboard(ORG);
    for (const r of rows) {
      expect(r).not.toHaveProperty("provisional");
      expect(r.games).toBeGreaterThanOrEqual(GROUP_RATINGS_MIN_GAMES);
    }
  });

  it("gives an active viewer below the minimum his own unranked row, saying how many more he needs", async () => {
    const rows = await loadRatingLeaderboard(ORG, { viewerId: "stayer" });
    const me = rows.find((r) => r.userId === "stayer")!;
    expect(me).toBeDefined();
    expect(me.rank).toBeNull();
    expect(me.inactive).toBe(false);
    expect(me.games).toBe(2);
    expect(me.gamesNeeded).toBe(1);
    expect(me.avg).toBeCloseTo(7, 5);
    expect(rows.at(-1)!.userId).toBe("stayer");
  });

  it("a viewer both away and below the minimum is told about the games, and marked inactive", async () => {
    const rows = await loadRatingLeaderboard(ORG, { viewerId: "leaver" });
    const me = rows.find((r) => r.userId === "leaver")!;
    expect(me.rank).toBeNull();
    expect(me.inactive).toBe(true);
    expect(me.gamesNeeded).toBe(1);
  });

  it("a ranked row needs no more games", async () => {
    const rows = await loadRatingLeaderboard(ORG, { viewerId: "regular" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.gamesNeeded).toBe(0);
  });

  it("the viewer's row is still purely additive under the new minimum", async () => {
    const anonymous = await loadRatingLeaderboard(ORG);
    const asStayer = await loadRatingLeaderboard(ORG, { viewerId: "stayer" });
    expect(asStayer.filter((r) => r.rank !== null)).toEqual(anonymous);
    expect(asStayer).toHaveLength(anonymous.length + 1);
  });
});
