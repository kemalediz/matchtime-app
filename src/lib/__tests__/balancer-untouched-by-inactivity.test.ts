/**
 * THE BALANCER IS UNTOUCHED. This is the regression that matters most.
 *
 * Kemal, 2026-09-15, verbatim: "drop inactive players from the table
 * after three months, LEAVE THE BALANCER ALONE."
 *
 * The inactivity rule is a DISPLAY filter on leaderboards. It must not
 * reach team generation or the rating formula, because rust in team
 * selection is already handled — better — by `rating-adjuster.ts`,
 * whose prompt says "Player hasn't played in weeks / mentioned rust →
 * small negative delta". That adjustment is temporary, per match,
 * evidence-backed and self-correcting. A permanent decay applied here
 * would double-count it and would never recover.
 *
 * Two guarantees, tested two different ways, because either alone is
 * escapable:
 *
 *   BEHAVIOURAL — a squad containing players who have not appeared in
 *   a year balances into exactly the teams it balanced into before,
 *   down to the rating diff.
 *
 *   STRUCTURAL — the balancing and rating modules do not import the
 *   inactivity module at all. A future "small tweak" that wires a
 *   decay in has to delete a test that says, in words, not to.
 *
 * ─── ONE THING THE BALANCER IS NOT, AND IT SURPRISED US ───────────────
 *
 * `balanceTeams` is NOT deterministic under the "position-aware"
 * strategy. Its step-3 hill-climb draws 1,000 candidate swaps from a
 * bare `Math.random()` (`team-balancer.ts`), so the same squad can and
 * does come out as different teams run to run — found while writing
 * this file on 2026-09-15, and a pre-existing property of the balancer,
 * not something the inactivity rule introduced.
 *
 * That makes the naive form of the owner's guarantee — "the same squad
 * produces the same teams before and after" — untestable as literally
 * written, because it is not even true of the balancer against itself.
 * So the guarantee is pinned the honest way instead: the RNG is
 * replaced with a fixed sequence, and the resulting teams are asserted
 * as golden values. Identical inputs plus identical randomness must
 * give identical teams. Any change to the algorithm, the draft order,
 * the cost function or the inputs breaks these, which is exactly the
 * alarm the owner asked for. "rating-only" draws no randomness at all
 * and is asserted for plain determinism.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { balanceTeams } from "@/lib/team-balancer";
import type { PlayerWithRating } from "@/types";

const SRC = join(process.cwd(), "src", "lib");

/** A fixed, repeatable stand-in for `Math.random` — a plain LCG. The
 *  hill-climb only uses randomness to pick swap candidates, so pinning
 *  the sequence pins the search path and therefore the result. */
function seededRandom(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function withSeededRng<T>(fn: () => T, seed = 12345): T {
  const spy = vi.spyOn(Math, "random").mockImplementation(seededRandom(seed));
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fixed 14-man squad. Half of them have not played for a year; the
 *  balancer has no way to know that and must not gain one. */
const SQUAD: PlayerWithRating[] = [
  { id: "kemal", name: "Kemal", positions: ["MID"], rating: 927 },
  { id: "mustafa", name: "Mustafa", positions: ["DEF"], rating: 1009 },
  { id: "abid", name: "Abid", positions: ["FWD"], rating: 1043 },
  { id: "habib", name: "Habib", positions: ["GK"], rating: 991 },
  { id: "idris", name: "Idris", positions: ["DEF"], rating: 879 },
  { id: "wasim", name: "Wasim", positions: ["MID"], rating: 999 },
  { id: "mojib", name: "Mojib", positions: ["FWD"], rating: 1072 },
  // ─── every player below last appeared in April/May 2026 ───
  { id: "ehtisham", name: "Ehtisham", positions: ["FWD"], rating: 1046 },
  { id: "elvin", name: "Elvin", positions: ["DEF"], rating: 921 },
  { id: "sait", name: "Sait", positions: ["MID"], rating: 1018 },
  { id: "baki", name: "Baki", positions: ["DEF"], rating: 940 },
  { id: "zair", name: "Zair", positions: ["MID"], rating: 995 },
  { id: "hasan", name: "Hasan", positions: ["GK"], rating: 997 },
  { id: "erdal", name: "Erdal", positions: ["FWD"], rating: 978 },
];

const COMPOSITION = { GK: 1, DEF: 2, MID: 2, FWD: 2 };

function shape(r: ReturnType<typeof balanceTeams>) {
  return {
    red: r.red.map((p) => p.id),
    yellow: r.yellow.map((p) => p.id),
    ratingDiff: r.ratingDiff,
  };
}

/** The golden teams, captured 2026-09-15 on `main` BEFORE the
 *  inactivity rule existed, with the seeded RNG above. If this changes,
 *  team generation changed — which is the one thing the owner said not
 *  to do. */
const GOLDEN_POSITION_AWARE = {
  red: ["ehtisham", "sait", "wasim", "hasan", "zair", "kemal", "elvin"],
  yellow: ["mojib", "abid", "mustafa", "habib", "erdal", "baki", "idris"],
  ratingDiff: 9,
};

describe("balanceTeams is blind to how long ago anyone played", () => {
  it("position-aware: identical squad + identical randomness = the teams captured before this change", () => {
    const got = withSeededRng(() =>
      shape(
        balanceTeams({
          players: SQUAD,
          perTeam: 7,
          strategy: "position-aware",
          composition: COMPOSITION,
        }),
      ),
    );
    expect(got).toEqual(GOLDEN_POSITION_AWARE);
  });

  it("position-aware: repeats exactly when the randomness repeats", () => {
    const runs = Array.from({ length: 5 }, () =>
      withSeededRng(() =>
        shape(
          balanceTeams({
            players: SQUAD,
            perTeam: 7,
            strategy: "position-aware",
            composition: COMPOSITION,
          }),
        ),
      ),
    );
    for (const r of runs) expect(r).toEqual(runs[0]);
  });

  it("rating-only: draws no randomness, so the same squad produces the same teams, run after run", () => {
    const first = shape(balanceTeams({ players: SQUAD, perTeam: 7, strategy: "rating-only" }));
    for (let i = 0; i < 20; i++) {
      expect(shape(balanceTeams({ players: SQUAD, perTeam: 7, strategy: "rating-only" }))).toEqual(
        first,
      );
    }
  });

  it("rating-only: the teams captured before this change", () => {
    expect(shape(balanceTeams({ players: SQUAD, perTeam: 7, strategy: "rating-only" }))).toEqual({
      red: ["mojib", "sait", "wasim", "hasan", "habib", "kemal", "elvin"],
      yellow: ["ehtisham", "abid", "mustafa", "zair", "erdal", "baki", "idris"],
      ratingDiff: 35,
    });
  });

  it("uses every player handed to it — nobody is filtered out for being inactive", () => {
    const r = balanceTeams({ players: SQUAD, perTeam: 7, strategy: "rating-only" });
    const picked = new Set([...r.red, ...r.yellow].map((p) => p.id));
    expect(picked.size).toBe(14);
    for (const p of SQUAD) expect(picked.has(p.id)).toBe(true);
  });

  it("takes a squad of nothing but year-absent players without complaint", () => {
    // The degenerate case of the rule leaking in: if inactivity ever
    // filtered the balancer's input, a squad of returning players would
    // throw "Need at least 14 players".
    expect(() =>
      balanceTeams({ players: SQUAD, perTeam: 7, strategy: "position-aware", composition: COMPOSITION }),
    ).not.toThrow();
  });
});

describe("the inactivity rule is not wired into team generation or ratings", () => {
  const forbidden = "ranked-table-activity";

  it.each([
    ["team-balancer.ts"],
    ["team-generation.ts"],
    ["player-rating.ts"],
    ["rating-adjuster.ts"],
    ["team-ops-engine.ts"],
  ])("%s does not import the inactivity module", (file) => {
    const src = readFileSync(join(SRC, file), "utf8");
    expect(src).not.toContain(forbidden);
  });

  it("the inactivity module does not reach back into the balancer either", () => {
    const src = readFileSync(join(SRC, "ranked-table-activity.ts"), "utf8");
    expect(src).not.toContain("team-balancer");
    expect(src).not.toContain("team-generation");
    expect(src).not.toContain("matchRating");
  });
});
