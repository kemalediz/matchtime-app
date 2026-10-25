/**
 * CLUB SETUP FOLLOWS THE SAME SWITCH (Kemal, 2026-10-25): club setup offers
 * only football, "but we should be able to bring that up easily soon".
 *
 * `LIVE_SPORTS` (../sports.ts) already decides what the website and the pool
 * offer. The club sport presets (src/lib/sport-presets.ts) are filtered by
 * it through the preset-to-pool mapping, so switching basketball on is one
 * line and both sides offer it. A preset with no pool sport (netball,
 * volleyball, cricket) is never live until a mapping is added.
 */
import { describe, expect, it } from "vitest";
import { SPORT_PRESETS } from "../../sport-presets";
import {
  isLivePreset,
  isOfferedClubSport,
  livePresetForSide,
  liveSportPresets,
  type LiveSports,
} from "../sports";

const WITH_BASKETBALL: LiveSports = { sports: ["football", "basketball"], other: false };
const FOOTBALL_KEYS = ["football-5aside", "football-7aside", "football-8aside", "football-9aside", "football-11aside", "futsal"];
const NOT_LIVE = ["basketball-5v5", "basketball-3v3", "netball", "volleyball", "cricket"];

describe("isLivePreset / liveSportPresets", () => {
  it.each(FOOTBALL_KEYS)("%s is live (futsal is football)", (key) => {
    expect(isLivePreset(key)).toBe(true);
  });

  it.each(NOT_LIVE)("%s is not live", (key) => {
    expect(isLivePreset(key)).toBe(false);
  });

  it("an unknown key is not live", () => {
    expect(isLivePreset("quidditch")).toBe(false);
    expect(isLivePreset("")).toBe(false);
  });

  it("the live presets are the football ones, in the library's order", () => {
    expect(liveSportPresets().map((p) => p.key)).toEqual(
      SPORT_PRESETS.map((p) => p.key).filter((k) => FOOTBALL_KEYS.includes(k)),
    );
  });

  it("switching basketball on makes its presets live; netball, volleyball and cricket stay off (no pool sport)", () => {
    expect(isLivePreset("basketball-5v5", WITH_BASKETBALL)).toBe(true);
    expect(isLivePreset("basketball-3v3", WITH_BASKETBALL)).toBe(true);
    const keys = liveSportPresets(WITH_BASKETBALL).map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining([...FOOTBALL_KEYS, "basketball-5v5", "basketball-3v3"]));
    for (const k of ["netball", "volleyball", "cricket"]) expect(keys).not.toContain(k);
  });
});

describe("livePresetForSide", () => {
  it.each([5, 7, 8, 9, 11])("%d per side is the football preset", (n) => {
    expect(livePresetForSide(n)?.key).toBe(`football-${n}aside`);
  });

  it.each([3, 4, 6, 10])("%d per side has no live preset (never volleyball or basketball)", (n) => {
    expect(livePresetForSide(n)).toBeUndefined();
  });

  it("with basketball on, 3 per side is basketball 3-on-3, and 5 stays football", () => {
    expect(livePresetForSide(3, WITH_BASKETBALL)?.key).toBe("basketball-3v3");
    expect(livePresetForSide(5, WITH_BASKETBALL)?.key).toBe("football-5aside");
  });
});

describe("isOfferedClubSport: a club's own sport rows for a new weekly game", () => {
  const row = (preset: string | null, name: string, playersPerTeam = 7) => ({ preset, name, playersPerTeam });

  it("a live preset is offered", () => {
    expect(isOfferedClubSport(row("football-7aside", "Football 7-a-side"))).toBe(true);
    expect(isOfferedClubSport(row("futsal", "Futsal", 5))).toBe(true);
  });

  it("a preset that is not live is not offered, unless the club already plays it", () => {
    expect(isOfferedClubSport(row("netball", "Netball"))).toBe(false);
    expect(isOfferedClubSport(row("basketball-5v5", "Basketball 5-on-5", 5))).toBe(false);
    expect(isOfferedClubSport(row("netball", "Netball"), { inUse: true })).toBe(true);
  });

  it("a custom sport is judged by its name: football yes, basketball no, an unknown name yes", () => {
    expect(isOfferedClubSport(row(null, "Football 6-a-side", 6))).toBe(true);
    expect(isOfferedClubSport(row(null, "Basketball Tuesdays", 5))).toBe(false);
    expect(isOfferedClubSport(row(null, "Tuesday game", 6))).toBe(true);
  });

  it("follows the switch", () => {
    expect(isOfferedClubSport(row("basketball-5v5", "Basketball 5-on-5", 5), {}, WITH_BASKETBALL)).toBe(true);
  });
});
