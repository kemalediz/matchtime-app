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

  it("sits between the 7-a-side and 11-a-side presets in the picker", () => {
    const keys = SPORT_PRESETS.map((p) => p.key);
    expect(keys.indexOf("football-8aside")).toBe(keys.indexOf("football-7aside") + 1);
    expect(keys.indexOf("football-11aside")).toBe(keys.indexOf("football-8aside") + 1);
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
