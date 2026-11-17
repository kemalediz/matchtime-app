/**
 * TOGETHER AND APART AS HARD CONSTRAINTS (2026-11-16, the Vets: "@Match
 * Time generate the teams, put Dan and Craig in separate teams please" was
 * read as a plain generate and the two came out on one side).
 *
 * The balancer takes groups of player ids that must share a side
 * (`together`) and groups that must be split (`apart`: two people on
 * different sides; a bigger group spread as evenly as two sides allow). It
 * balances the ratings within them, and when they clash with each other,
 * with a pin or with the side sizes it does the best it can and says which
 * groups it could not keep (`unmet`).
 */
import { describe, expect, it } from "vitest";
import { balanceTeams } from "../team-balancer";
import type { PlayerWithRating, TeamResult } from "@/types";

const P = (id: string, rating: number, positions: string[] = []): PlayerWithRating => ({ id, name: id, positions, rating, image: null });

// Ten players, 5 a side. Dan and Craig are the two strongest, so a plain
// balance puts them on different sides; Abe and Bob are the two weakest.
const TEN = [
  P("Dan", 9),
  P("Craig", 8.8),
  P("Eli", 7),
  P("Finn", 6.8),
  P("Gus", 6.5),
  P("Hal", 6.2),
  P("Ivo", 6),
  P("Jon", 5.5),
  P("Abe", 4),
  P("Bob", 3.8),
];

const sideOf = (r: TeamResult, id: string) => (r.red.some((p) => p.id === id) ? "RED" : r.yellow.some((p) => p.id === id) ? "YELLOW" : null);
const total = (ps: PlayerWithRating[]) => ps.reduce((s, p) => s + p.rating, 0);

for (const strategy of ["rating-only", "position-aware"] as const) {
  const composition = strategy === "position-aware" ? { GK: 1, DEF: 2, MID: 1, FWD: 1 } : undefined;
  const run = (opts: { together?: string[][]; apart?: string[][]; pinnedToTeam?: Record<string, "RED" | "YELLOW">; players?: PlayerWithRating[]; perTeam?: number }) =>
    balanceTeams({ players: opts.players ?? TEN, perTeam: opts.perTeam ?? 5, strategy, composition, ...opts });

  describe(`balanceTeams constraints (${strategy})`, () => {
    it("apart: the two weakest, who a plain balance might pair, end up on different sides", () => {
      const r = run({ apart: [["Abe", "Bob"]] });
      expect(sideOf(r, "Abe")).not.toBe(sideOf(r, "Bob"));
      expect(r.unmet).toEqual({ together: [], apart: [] });
      expect(r.red).toHaveLength(5);
      expect(r.yellow).toHaveLength(5);
    });

    it("together: the two strongest share a side, and the rest balances around them", () => {
      const r = run({ together: [["Dan", "Craig"]] });
      expect(sideOf(r, "Dan")).toBe(sideOf(r, "Craig"));
      expect(r.unmet).toEqual({ together: [], apart: [] });
      // Balanced within the constraint: the gap is no wider than one player's rating.
      expect(Math.abs(total(r.red) - total(r.yellow))).toBeLessThan(4);
    });

    it("both at once: Dan with Abe, Dan apart from Craig, Craig with Bob", () => {
      const r = run({ together: [["Dan", "Abe"], ["Craig", "Bob"]], apart: [["Dan", "Craig"]] });
      expect(sideOf(r, "Dan")).toBe(sideOf(r, "Abe"));
      expect(sideOf(r, "Craig")).toBe(sideOf(r, "Bob"));
      expect(sideOf(r, "Dan")).not.toBe(sideOf(r, "Craig"));
      expect(r.unmet).toEqual({ together: [], apart: [] });
    });

    it("a conflict: together and apart about the same two people. The first holds, the clash is reported", () => {
      const r = run({ together: [["Dan", "Craig"]], apart: [["Dan", "Craig"]] });
      expect(sideOf(r, "Dan")).toBe(sideOf(r, "Craig"));
      expect(r.unmet).toMatchObject({ together: [], apart: [["Dan", "Craig"]] });
      // The TRUE reason (review of #619): a clash, because there is one.
      expect(Object.values(r.unmet.why ?? {})).toEqual([{ reason: "clash" }]);
    });

    it("the reasons are true: a member not in the squad, and a group too big for a side", () => {
      const missing = run({ apart: [["Dan", "Zed"]] });
      expect(Object.values(missing.unmet.why ?? {})).toEqual([{ reason: "not-on-teams", missing: ["Zed"] }]);
      const six = ["Dan", "Craig", "Eli", "Finn", "Gus", "Hal"];
      const big = run({ together: [six] });
      expect(Object.values(big.unmet.why ?? {})).toEqual([{ reason: "sizes" }]);
    });

    it("a conflict with a pin: both pinned to Red and asked apart. The pins hold, apart is reported", () => {
      const r = run({ pinnedToTeam: { Dan: "RED", Craig: "RED" }, apart: [["Dan", "Craig"]] });
      expect(sideOf(r, "Dan")).toBe("RED");
      expect(sideOf(r, "Craig")).toBe("RED");
      expect(r.unmet.apart).toEqual([["Dan", "Craig"]]);
    });

    it("apart with a pin: Dan pinned to Yellow, so Craig goes to Red", () => {
      const r = run({ pinnedToTeam: { Dan: "YELLOW" }, apart: [["Dan", "Craig"]] });
      expect(sideOf(r, "Dan")).toBe("YELLOW");
      expect(sideOf(r, "Craig")).toBe("RED");
      expect(r.unmet).toEqual({ together: [], apart: [] });
    });

    it("a together group bigger than a side cannot be met: the teams are still made, and it is reported", () => {
      const six = ["Dan", "Craig", "Eli", "Finn", "Gus", "Hal"];
      const r = run({ together: [six] });
      expect(r.red).toHaveLength(5);
      expect(r.yellow).toHaveLength(5);
      expect(r.unmet.together).toEqual([six]);
    });

    it("an apart group of four is spread two and two", () => {
      const r = run({ apart: [["Dan", "Craig", "Eli", "Finn"]] });
      const reds = ["Dan", "Craig", "Eli", "Finn"].filter((id) => sideOf(r, id) === "RED").length;
      expect(reds).toBe(2);
      expect(r.unmet.apart).toEqual([]);
    });

    it("a player who is not in the squad cannot be kept apart: reported, never silently dropped", () => {
      const r = run({ apart: [["Dan", "Zed"]] });
      expect(r.unmet.apart).toEqual([["Dan", "Zed"]]);
    });

    it("no constraints: unmet is empty and nothing else changes", () => {
      const r = run({});
      expect(r.unmet).toEqual({ together: [], apart: [] });
      expect(r.red.length + r.yellow.length).toBe(10);
    });
  });
}

describe("odd squads try BOTH ways round (review of #619): 7 against 6 is no mirror image", () => {
  // Thirteen players, Red takes 7 and Yellow 6.
  const T = (ids: string[], r: (i: number) => number) => ids.map((id, i) => P(id, r(i)));
  const ids = ["X", "Y", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];

  /** The best gap any 7/6 split meeting the groups can have, by brute force. */
  const bestGap = (players: PlayerWithRating[], ok: (red: Set<string>) => boolean) => {
    let best = Infinity;
    const n = players.length;
    for (let mask = 0; mask < 1 << n; mask++) {
      let bits = 0;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) bits++;
      if (bits !== 7) continue;
      const red = new Set(players.filter((_, i) => mask & (1 << i)).map((p) => p.id));
      if (!ok(red)) continue;
      const r = players.filter((p) => red.has(p.id)).reduce((s, p) => s + p.rating, 0);
      const y = players.filter((p) => !red.has(p.id)).reduce((s, p) => s + p.rating, 0);
      best = Math.min(best, Math.abs(r - y));
    }
    return best;
  };

  it("a together group of seven that only fits Red, joined to an apart pair: met, not dropped", () => {
    // X with k, Y with six others, X apart from Y: Y's seven only fit the
    // side of seven, so only one of the two ways round works.
    const players = T(ids, (i) => 5 + (i % 3));
    const together = [["X", "k"], ["Y", "a", "b", "c", "d", "e", "f"]];
    const apart = [["X", "Y"]];
    const r = balanceTeams({ players, perTeam: 7, minPlayers: 12, strategy: "rating-only", together, apart });
    expect(r.unmet).toEqual({ together: [], apart: [] });
    expect(r.red.map((p) => p.id).sort()).toEqual(["Y", "a", "b", "c", "d", "e", "f"].sort());
  });

  it("an apart pair of a strong and a weak player: the balance is as close as the groups allow", () => {
    const ratings: Record<string, number> = { X: 9.5, Y: 2, a: 7, b: 6.5, c: 6, d: 6, e: 5.5, f: 5, g: 5, h: 4.5, i: 4, j: 3.5, k: 3 };
    const players = ids.map((id) => P(id, ratings[id]));
    const r = balanceTeams({ players, perTeam: 7, minPlayers: 12, strategy: "rating-only", apart: [["X", "Y"]] });
    expect(r.unmet.apart).toEqual([]);
    const optimum = bestGap(players, (red) => red.has("X") !== red.has("Y"));
    expect(r.ratingDiff).toBeLessThanOrEqual(optimum + 0.5);
  });
});

describe("balanceTeams constraints with uneven sides (7 against 6)", () => {
  const thirteen = [...TEN, P("Kit", 5), P("Lou", 4.5), P("Max", 4.2)];
  it("apart and together hold, and the count is 7 and 6", () => {
    const r = balanceTeams({
      players: thirteen,
      perTeam: 7,
      strategy: "rating-only",
      minPlayers: 12,
      apart: [["Dan", "Craig"]],
      together: [["Abe", "Bob"]],
    });
    expect([r.red.length, r.yellow.length].sort()).toEqual([6, 7]);
    expect(sideOf(r, "Dan")).not.toBe(sideOf(r, "Craig"));
    expect(sideOf(r, "Abe")).toBe(sideOf(r, "Bob"));
    expect(r.unmet).toEqual({ together: [], apart: [] });
  });
});
