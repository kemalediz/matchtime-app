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
      expect(r.unmet).toEqual({ together: [], apart: [["Dan", "Craig"]] });
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
