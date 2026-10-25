/**
 * The sport preset library.
 *
 * `football-8aside` was missing: a club that chose 8 players per side in
 * the self-join setup (`sportForPlayersPerSide`) fell through to plain
 * football balanced on rating alone, and the group-add onboarding
 * (`presetForSide`) fell all the way back to the 7-a-side preset.
 */
import { describe, it, expect } from "vitest";
import { SPORT_PRESETS, findPreset } from "@/lib/sport-presets";
import { sportForPlayersPerSide } from "@/lib/club-connect-rules";
import { presetForSide } from "@/lib/onboarding-conversation";
import { balanceTeams } from "@/lib/team-balancer";
import type { PlayerWithRating } from "@/types";

describe("football-8aside", () => {
  it("exists with 8 per side and the same shape as the 7-a-side preset", () => {
    const eight = findPreset("football-8aside");
    const seven = findPreset("football-7aside")!;
    expect(eight).toBeDefined();
    expect(eight!.name).toBe("Football 8-a-side");
    expect(eight!.playersPerTeam).toBe(8);
    expect(eight!.positions).toEqual(seven.positions);
    expect(eight!.teamLabels).toEqual(seven.teamLabels);
    expect(eight!.mvpLabel).toBe(seven.mvpLabel);
    expect(eight!.balancingStrategy).toBe("position-aware");
    expect(eight!.positionComposition).toEqual({ GK: 1, DEF: 3, MID: 2, FWD: 2 });
  });

  it("is what a self-join club choosing 8 per side gets", () => {
    const sport = sportForPlayersPerSide(8);
    expect(sport.preset).toBe("football-8aside");
    expect(sport.playersPerTeam).toBe(8);
    expect(sport.balancingStrategy).toBe("position-aware");
    expect(sport.positionComposition).toEqual({ GK: 1, DEF: 3, MID: 2, FWD: 2 });
  });

  it("sits right after the 7-a-side preset in the picker", () => {
    const keys = SPORT_PRESETS.map((p) => p.key);
    expect(keys.indexOf("football-8aside")).toBe(keys.indexOf("football-7aside") + 1);
  });

  it("is what the in-group setup picks for 8 per side", () => {
    expect(presetForSide(8).preset).toBe("football-8aside");
  });
});

/**
 * `football-9aside` (2026-09-30, Friday group plan slice 4): a Friday
 * 16/18 group plays 9 a side. Without the preset, 9 per side fell to
 * rating-only balancing in the self-join setup and to the 7-a-side
 * preset in the in-group setup.
 */
describe("football-9aside", () => {
  it("exists with 9 per side and the same shape as the 7-a-side preset", () => {
    const nine = findPreset("football-9aside");
    const seven = findPreset("football-7aside")!;
    expect(nine).toBeDefined();
    expect(nine!.name).toBe("Football 9-a-side");
    expect(nine!.playersPerTeam).toBe(9);
    expect(nine!.positions).toEqual(seven.positions);
    expect(nine!.teamLabels).toEqual(seven.teamLabels);
    expect(nine!.mvpLabel).toBe(seven.mvpLabel);
    expect(nine!.balancingStrategy).toBe("position-aware");
    expect(nine!.positionComposition).toEqual({ GK: 1, DEF: 3, MID: 3, FWD: 2 });
  });

  it("is what a self-join club choosing 9 per side gets", () => {
    const sport = sportForPlayersPerSide(9);
    expect(sport.preset).toBe("football-9aside");
    expect(sport.playersPerTeam).toBe(9);
    expect(sport.balancingStrategy).toBe("position-aware");
    expect(sport.positionComposition).toEqual({ GK: 1, DEF: 3, MID: 3, FWD: 2 });
  });

  it("is what the in-group setup picks for 9 per side", () => {
    const p = presetForSide(9);
    expect(p.preset).toBe("football-9aside");
    expect(p.playersPerTeam).toBe(9);
  });

  it("orders the football presets 7, 8, 9, 11 in the picker", () => {
    const keys = SPORT_PRESETS.map((p) => p.key);
    expect(keys.indexOf("football-9aside")).toBe(keys.indexOf("football-8aside") + 1);
    expect(keys.indexOf("football-11aside")).toBe(keys.indexOf("football-9aside") + 1);
  });

  it("balances 18 players into 9 and 9 with one keeper each when two keepers are present", () => {
    const nine = findPreset("football-9aside")!;
    const outfield = ["DEF", "DEF", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "MID", "MID", "MID", "FWD", "FWD", "FWD", "FWD"];
    const players: PlayerWithRating[] = [
      { id: "gk1", name: "Keeper One", positions: ["GK"], rating: 7 },
      { id: "gk2", name: "Keeper Two", positions: ["GK"], rating: 5 },
      ...outfield.map((pos, i) => ({ id: `p${i}`, name: `Player ${i}`, positions: [pos], rating: 4 + (i % 5) })),
    ];
    for (let run = 0; run < 5; run++) {
      const { red, yellow } = balanceTeams({
        players,
        perTeam: nine.playersPerTeam,
        strategy: nine.balancingStrategy,
        composition: nine.positionComposition,
      });
      expect(red).toHaveLength(9);
      expect(yellow).toHaveLength(9);
      expect(red.filter((p) => p.positions.includes("GK"))).toHaveLength(1);
      expect(yellow.filter((p) => p.positions.includes("GK"))).toHaveLength(1);
      expect(new Set([...red, ...yellow].map((p) => p.id)).size).toBe(18);
    }
  });
});

describe("every preset", () => {
  it("has a unique key", () => {
    const keys = SPORT_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("fills exactly one side with its position composition when it balances by position", () => {
    for (const p of SPORT_PRESETS) {
      if (p.balancingStrategy !== "position-aware") continue;
      const comp = p.positionComposition!;
      // Volleyball's libero is left out of its composition on purpose
      // (a substitute role), and its six still fill the side.
      const total = Object.values(comp).reduce((s, n) => s + n, 0);
      expect(total, p.key).toBe(p.playersPerTeam);
      for (const pos of Object.keys(comp)) expect(p.positions, `${p.key}:${pos}`).toContain(pos);
    }
  });
});

/**
 * Club setup offers football only, through the same `LIVE_SPORTS` switch as
 * the website and the pool (Kemal, 2026-10-25). The in-group setup used to
 * fall back to "any preset with that many per side", so 6 a side silently
 * became volleyball and 3 became basketball 3-on-3. It now only ever picks a
 * live preset, and for a size with none it builds the same plain-football
 * sport the self-join setup builds.
 */
describe("in-group setup picks only a live sport (presetForSide)", () => {
  const FOOTBALLISH = /^(football-\d+aside|futsal)$/;

  it.each([5, 7, 11])("%d per side is the football preset", (n) => {
    const p = presetForSide(n);
    expect(p.preset).toBe(`football-${n}aside`);
    expect(p.name).toBe(`Football ${n}-a-side`);
    expect(p.playersPerTeam).toBe(n);
  });

  it.each([3, 4, 6, 10])("%d per side is plain football, the same sport self-join builds", (n) => {
    const p = presetForSide(n);
    expect(p.preset).toBeNull();
    expect(p.name).toBe(`Football ${n}-a-side`);
    expect(p.playersPerTeam).toBe(n);
    const { name: _name, ...rest } = p;
    const { name: _sjName, ...selfJoin } = sportForPlayersPerSide(n);
    expect(rest).toEqual(selfJoin);
  });

  it("never picks a sport that is not football, for any size", () => {
    for (let n = 1; n <= 15; n++) {
      const p = presetForSide(n);
      if (p.preset !== null) expect(p.preset).toMatch(FOOTBALLISH);
      expect(p.positions).toEqual(["GK", "DEF", "MID", "FWD"]);
      expect(p.mvpLabel).toBe("Man of the Match");
    }
  });

  it("self-join reads the same switch: a basketball club only once basketball is live", () => {
    expect(sportForPlayersPerSide(3).preset).toBeNull();
    expect(sportForPlayersPerSide(3, { sports: ["football", "basketball"], other: false }).preset).toBe("basketball-3v3");
    expect(sportForPlayersPerSide(5, { sports: ["football", "basketball"], other: false }).preset).toBe("football-5aside");
  });
});
