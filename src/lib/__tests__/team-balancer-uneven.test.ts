/**
 * Teams with an odd count (2026-11-03, the Vets play 6 against 7). With a
 * minimum set the caller lets the balancer make teams below two full
 * sides: the sides are as even in number as the count allows, and the
 * balance is on total rating, so the side one short gets the stronger
 * players.
 */
import { describe, expect, it } from "vitest";
import { balanceTeams } from "../team-balancer";
import type { PlayerWithRating } from "@/types";

const players = (ratings: number[]): PlayerWithRating[] =>
  ratings.map((rating, i) => ({ id: `p${i + 1}`, name: `P${i + 1}`, positions: [], rating, image: null }));

const total = (ps: PlayerWithRating[]) => ps.reduce((s, p) => s + p.rating, 0);

describe("balanceTeams with fewer than two full sides", () => {
  const thirteen = players([9, 8.5, 8, 7.5, 7, 7, 6.5, 6, 6, 5.5, 5, 4.5, 4]);

  for (const strategy of ["rating-only", "position-aware"] as const) {
    it(`${strategy}: 13 players make 7 against 6, with nobody left out`, () => {
      const r = balanceTeams({
        players: thirteen,
        perTeam: 7,
        strategy,
        composition: strategy === "position-aware" ? { GK: 1, DEF: 2, MID: 2, FWD: 2 } : undefined,
        minPlayers: 12,
      });
      expect([r.red.length, r.yellow.length].sort()).toEqual([6, 7]);
      const ids = new Set([...r.red, ...r.yellow].map((p) => p.id));
      expect(ids.size).toBe(13);
      // Balanced on total rating: the gap is no wider than one middling player.
      expect(Math.abs(total(r.red) - total(r.yellow))).toBeLessThan(6);
    });
  }

  it("without a minimum the old rule stands: two full sides or an error", () => {
    expect(() => balanceTeams({ players: thirteen, perTeam: 7, strategy: "rating-only" })).toThrow(/Need at least 14/);
  });

  it("below the minimum it still refuses", () => {
    expect(() => balanceTeams({ players: players([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]), perTeam: 7, strategy: "rating-only", minPlayers: 12 })).toThrow(
      /Need at least 12/,
    );
  });

  it("a full squad is unchanged: 7 and 7", () => {
    const r = balanceTeams({ players: players([9, 8, 8, 7, 7, 7, 6, 6, 6, 5, 5, 5, 4, 4]), perTeam: 7, strategy: "rating-only", minPlayers: 12 });
    expect([r.red.length, r.yellow.length]).toEqual([7, 7]);
  });

  it("a pinned player stays on his side", () => {
    const r = balanceTeams({ players: thirteen, perTeam: 7, strategy: "rating-only", minPlayers: 12, pinnedToTeam: { p13: "YELLOW" } });
    expect(r.yellow.map((p) => p.id)).toContain("p13");
  });
});
