/**
 * B1 (club summary, K1 2026-11-04): the web's squad bar reads the one
 * definition of "short". Until now the dashboard and the match list
 * coloured a squad blue from 75% of its places, a third meaning of "low"
 * (plan D1). Now: green when full, blue when the game is on (at or above
 * its minimum), amber when it is short.
 */
import { describe, it, expect } from "vitest";
import { squadBarColor } from "@/lib/squad-bar";
import { squadNumbers } from "@/lib/squad-short";

const bar = (places: number, confirmed: number, minPlayers: number | null, playersPerTeam: number) =>
  squadBarColor(squadNumbers({ places, confirmed, minPlayers, playersPerTeam }));

describe("squadBarColor", () => {
  it("full: green", () => {
    expect(bar(14, 14, null, 7)).toBe("bg-green-500");
    expect(bar(18, 18, 12, 9)).toBe("bg-green-500");
  });

  it("FNF, 12 of 18 with a minimum of 12: the game is on, blue (was amber at 67%)", () => {
    expect(bar(18, 12, 12, 9)).toBe("bg-blue-600");
  });

  it("FNF, 11 of 18: short, amber", () => {
    expect(bar(18, 11, 12, 9)).toBe("bg-amber-500");
  });

  it("no minimum: short while a place is open, so amber until full (was blue from 75%)", () => {
    expect(bar(14, 13, null, 7)).toBe("bg-amber-500");
    expect(bar(14, 6, null, 7)).toBe("bg-amber-500");
  });

  it("the Vets, 12 of 14 with a minimum of 12: on, blue", () => {
    expect(bar(14, 12, 12, 7)).toBe("bg-blue-600");
  });
});
