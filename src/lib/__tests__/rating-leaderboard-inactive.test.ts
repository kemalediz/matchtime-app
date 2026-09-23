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
 * Team of the Season deliberately does NOT follow the rule — it is an
 * award over a closed season, not a statement about who is here now.
 * See TEAM_OF_SEASON_FOLLOWS_ACTIVITY_RULE.
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

describe("Team of the Season is an award, not a table, and is NOT filtered", () => {
  it("still picks a player who has stopped turning up", async () => {
    const tots = await loadTeamOfSeason(ORG, { minGames: 1 });
    expect(tots!.formation.map((s) => s.name)).toContain("Ehtisham");
  });

  it("picks him on merit — he is the highest-rated, so he leads the XI", async () => {
    const tots = await loadTeamOfSeason(ORG, { minGames: 1 });
    expect(tots!.formation[0]!.name).toBe("Ehtisham");
  });
});
