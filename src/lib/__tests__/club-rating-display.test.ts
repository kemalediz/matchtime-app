/**
 * THE NUMBER A PLAYER IS SHOWN IS THE NUMBER THEIR CLUB GAVE THEM.
 *
 * Slice 6 of `MDs/club-scoped-ratings-design-2026-09-18.md`. The
 * dashboard tile was the last player-visible read of the global rating
 * (design section 3.1, site G4): it fetched this player's sixty most
 * recent ratings FROM ANY CLUB and blended them with `User.seedRating`,
 * on a page whose every other word is about one club.
 *
 * Two things made that worse than a stale label. The tile disagreed
 * with the "Avg rating" tile on `/profile/stats`, which has been
 * club-scoped all along, and nothing on either page explained why. And
 * since slice 4 stopped writing `User.seedRating`, a player who joined
 * after that date has NO global seed at all, so the tile was already
 * degrading for every new member: no seed, and peer ratings pulled from
 * clubs they may not even play for.
 *
 * `loadClubRating` is the fix and this file is its contract. The db is
 * mocked: what is under test is the QUERY SHAPE (does the org filter
 * exist, and does `take` sit next to it) and the display decisions
 * layered on top of `computeClubRating`, not Prisma.
 *
 * ── TWO NUMBERS SINCE 2026-09-19 ─────────────────────────────────────
 *
 * `rating` is what a human is shown: the raw mean of the ratings this
 * club actually gave this player. `balancerRating` is what team
 * generation uses: the same scores shrunk toward the club's own mean
 * while there are only one or two of them. Kemal answered the design's
 * open question 2 that way round, and the arithmetic of each is pinned
 * in `club-rating-shown-vs-balanced.test.ts`. Here we only check that
 * one call produces both and that the right one reaches each field.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const ORG = "org-sutton-fc";
const OTHER_ORG = "org-sutton-lads";
const ME = "u-me";

interface RatingRow {
  playerId: string;
  orgId: string;
  score: number;
  createdAt: Date;
}

let ratingRows: RatingRow[] = [];
let clubSeed: number | null = null;
/** Every `rating.findMany` argument this run, so the test can assert on
 *  the shape of the query and not only on the answer it produced. */
let findManyCalls: unknown[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    rating: {
      findMany: (args: {
        where: { playerId?: string; match?: { activity?: { orgId?: string } } };
        orderBy?: { createdAt?: "asc" | "desc" };
        take?: number;
      }) => {
        findManyCalls.push(args);
        const orgId = args.where?.match?.activity?.orgId;
        let rows = ratingRows.filter((r) => r.playerId === args.where?.playerId);
        // The org filter applies BEFORE `take`, exactly as Postgres
        // would, so a dead club cannot evict a live one from the window.
        if (orgId) rows = rows.filter((r) => r.orgId === orgId);
        rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (args.take) rows = rows.slice(0, args.take);
        return Promise.resolve(rows.map((r) => ({ score: r.score, createdAt: r.createdAt })));
      },
      aggregate: (args: { where?: { match?: { activity?: { orgId?: string } } } }) => {
        const orgId = args.where?.match?.activity?.orgId;
        const rows = orgId ? ratingRows.filter((r) => r.orgId === orgId) : ratingRows;
        const avg = rows.length ? rows.reduce((s, r) => s + r.score, 0) / rows.length : null;
        return Promise.resolve({ _avg: { score: avg } });
      },
    },
    membership: {
      findUnique: () => Promise.resolve(clubSeed === null ? { seedRating: null } : { seedRating: clubSeed }),
    },
  },
}));

let t = 0;
function push(playerId: string, orgId: string, score: number) {
  ratingRows.push({ playerId, orgId, score, createdAt: new Date(1_700_000_000_000 + t++ * 1000) });
}

beforeEach(() => {
  ratingRows = [];
  findManyCalls = [];
  clubSeed = null;
  t = 0;
});

async function load(orgId = ORG, userId = ME) {
  const { loadClubRating } = await import("@/lib/player-stats");
  return loadClubRating(orgId, userId);
}

describe("the dashboard tile reads THIS club's ratings", () => {
  it("asks for this org's ratings only, newest first, capped at 60", async () => {
    await load();
    const call = findManyCalls[0] as {
      where: { playerId: string; match: { activity: { orgId: string } } };
      orderBy: { createdAt: string };
      take: number;
    };
    expect(call.where.playerId).toBe(ME);
    expect(call.where.match.activity.orgId).toBe(ORG);
    expect(call.orderBy.createdAt).toBe("desc");
    expect(call.take).toBe(60);
  });

  it("another club's ratings cannot move the number", async () => {
    clubSeed = 6;
    for (let i = 0; i < 3; i++) push(ME, ORG, 7);
    const withoutForeign = await load();

    // Ten 9s arrive at a club this player has left. Nothing may move.
    for (let i = 0; i < 10; i++) push(ME, OTHER_ORG, 9);
    findManyCalls = [];
    const withForeign = await load();

    expect(withForeign.rating).toBe(withoutForeign.rating);
    expect(withForeign.balancerRating).toBe(withoutForeign.balancerRating);
    // Shown: the mean of the three 7s he was actually given here.
    expect(withForeign.rating).toBe(7);
    // Balanced: (sum 21 + prior 6 x 3) / (3 + 3) = 6.5
    expect(withForeign.balancerRating).toBe(6.5);
  });

  it("a player with no global seed still gets their club's number", async () => {
    // Every member created since slice 4 is in this position: no
    // `User.seedRating` exists to fall back on, only the club's.
    clubSeed = 8;
    for (let i = 0; i < 2; i++) push(ME, ORG, 9);
    const r = await load();
    // Shown: the mean of the two 9s.
    expect(r.rating).toBe(9);
    // Balanced: (9 + 9 + 8 x 3) / (2 + 3) = 8.4
    expect(r.balancerRating).toBeCloseTo(8.4, 10);
    expect(r.source).toBe("blended");
  });
});

/**
 * Kemal's open question 2, ANSWERED 2026-09-19: the player sees their
 * own raw average, the balancer keeps the shrunk one. `provisional` is
 * what survives of the old answer and it changes meaning with it. It no
 * longer warns that the number has been adjusted, because it has not.
 * It warns that one or two ratings is thin evidence, so the number will
 * move a lot, and that MatchTime is correspondingly careful with it
 * when it picks the teams. Same flag, same threshold, honest sentence.
 */
describe("provisional while the prior still outweighs the player's own scores", () => {
  it("one club rating is provisional", async () => {
    clubSeed = 6;
    push(ME, ORG, 10);
    const r = await load();
    expect(r.peerCount).toBe(1);
    expect(r.provisional).toBe(true);
  });

  it("two club ratings are provisional", async () => {
    clubSeed = 6;
    push(ME, ORG, 10);
    push(ME, ORG, 10);
    const r = await load();
    expect(r.peerCount).toBe(2);
    expect(r.provisional).toBe(true);
  });

  it("three club ratings are not: that is the 50/50 crossover", async () => {
    clubSeed = 6;
    for (let i = 0; i < 3; i++) push(ME, ORG, 10);
    const r = await load();
    expect(r.peerCount).toBe(3);
    expect(r.provisional).toBe(false);
  });

  it("no club ratings at all is not 'provisional', it is empty", async () => {
    clubSeed = 6;
    const r = await load();
    expect(r.peerCount).toBe(0);
    expect(r.provisional).toBe(false);
  });
});

/**
 * Design section 4.2: `source: "club-average"` exists precisely so the
 * UI can refuse to present the club's average as if it were this
 * player's own number. A brand-new unseeded member enters the balancer
 * at the club mean, which is right for team selection and would be a
 * lie on their own dashboard.
 */
describe("a player this club has never rated is shown the empty state", () => {
  it("unseeded and unrated: the club mean is not theirs to be shown", async () => {
    for (const other of ["u-a", "u-b", "u-c"]) for (let i = 0; i < 4; i++) push(other, ORG, 7);
    const r = await load();
    expect(r.source).toBe("club-average");
    expect(r.hasOwnNumber).toBe(false);
    // Nothing to show: the club's average is not this player's number.
    expect(r.rating).toBeNull();
    // The balancer still gets a usable prior out of the same call.
    expect(r.balancerRating).toBe(7);
  });

  /**
   * Kemal, 2026-09-19: "i prefer them to see nothing, better not to
   * show seed, the ratings are important to the player, not the seed
   * and it can be discouraging too."
   *
   * So this is the SAME screen as the case above. One call still
   * produces both numbers and they now disagree by the whole seed: the
   * player is shown nothing, the balancer is handed 7.5.
   */
  it("seeded but unrated: the player sees nothing, the balancer still gets the seed", async () => {
    clubSeed = 7.5;
    for (const other of ["u-a"]) for (let i = 0; i < 4; i++) push(other, ORG, 4);
    const r = await load();
    expect(r.source).toBe("seed");
    expect(r.hasOwnNumber).toBe(false);
    expect(r.rating).toBeNull();
    expect(r.peerCount).toBe(0);
    expect(r.balancerRating).toBe(7.5);
  });

  it("a low seed is hidden too, and the balancer still reads it", async () => {
    clubSeed = 3;
    for (let i = 0; i < 4; i++) push("u-a", ORG, 8);
    const r = await load();
    expect(r.rating).toBeNull();
    expect(r.hasOwnNumber).toBe(false);
    expect(r.balancerRating).toBe(3);
  });

  it("one team-mate rating, and the number appears", async () => {
    clubSeed = 4;
    const before = await load();
    expect(before.rating).toBeNull();

    findManyCalls = [];
    push(ME, ORG, 9);
    const after = await load();
    // What he was GIVEN, not the 4 he was guessed at.
    expect(after.rating).toBe(9);
    expect(after.hasOwnNumber).toBe(true);
    // Balanced: (9 + 4 x 3) / (1 + 3) = 5.25
    expect(after.balancerRating).toBe(5.25);
  });

  it("a club that has never rated anybody gives nobody a number", async () => {
    const r = await load();
    expect(r.source).toBe("club-average");
    expect(r.hasOwnNumber).toBe(false);
    expect(r.rating).toBeNull();
    expect(r.balancerRating).toBe(5);
  });
});

/**
 * A clubmate's club rating is READABLE. Decision 4: "on a player's
 * stats page they see the club ratings of other players in the same
 * club". `loadClubRating` therefore takes any userId and has no viewer
 * argument, which is the opposite of the overall rating next door.
 */
describe("a clubmate's club rating is reachable", () => {
  it("loads for a player who is not the viewer", async () => {
    clubSeed = 6;
    for (let i = 0; i < 5; i++) push("u-clubmate", ORG, 8);
    const r = await load(ORG, "u-clubmate");
    // Shown: the mean of the five 8s the club gave them.
    expect(r.rating).toBe(8);
    // Balanced: (40 + 18) / 8 = 7.25
    expect(r.balancerRating).toBe(7.25);
    expect(r.hasOwnNumber).toBe(true);
  });
});

/**
 * KEMAL'S EXAMPLE, END TO END THROUGH THE LOADER.
 *
 * One rating of 9 at a club whose mean is 6.674. The player is shown
 * 9.0 because that is what his team-mates gave him; the balancer reads
 * 7.3 because one rating is not yet evidence. Both come out of the one
 * call, so no surface can reach for the wrong one by accident.
 */
describe("one rating of 9 at a club whose mean is about 6.7", () => {
  it("shows 9.0 and balances at roughly 7.3", async () => {
    // Twenty rows from the rest of the squad, sitting where Sutton FC
    // really sits (6.674, measured against production on 2026-09-18),
    // then this player's single 9 on top.
    const others = [7, 7, 7, 7, 6, 7, 6, 6, 7, 6, 7, 6, 7, 7, 6, 7, 6, 7, 7, 6];
    for (const score of others) push("u-other", ORG, score);
    push(ME, ORG, 9);
    const clubMean = ratingRows.reduce((s2, r) => s2 + r.score, 0) / ratingRows.length;

    const r = await load();
    expect(r.peerCount).toBe(1);
    expect(r.rating).toBe(9);
    expect(r.rating!.toFixed(1)).toBe("9.0");
    expect(clubMean).toBeCloseTo(6.714, 3);
    expect(r.balancerRating).toBeCloseTo((9 + clubMean * 3) / 4, 10);
    expect(r.balancerRating.toFixed(1)).toBe("7.3");
    expect(r.provisional).toBe(true);
    // The two are allowed to differ, and here they must.
    expect(r.rating).toBeGreaterThan(r.balancerRating);
  });
});
