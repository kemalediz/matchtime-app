/**
 * WHICH SPORTS ARE LIVE (Kemal, 2026-10-25: "let's focus on football for now
 * ... we can extend to other sports but keep it easily extendable").
 *
 * `LIVE_SPORTS` in ../sports.ts is the one switch. The website copy, the
 * /play form, the server validation, the member opt-in and the public-copy
 * guard all read it; the full catalogue stays in code so reopening a sport
 * is one line there.
 */
import { describe, expect, it } from "vitest";
import {
  LIVE_SPORTS,
  OTHER_SPORT,
  POOL_SPORTS,
  POOL_SPORT_KEYS,
  isLiveSport,
  liveSports,
  notLiveSportNames,
  sportChoiceKey,
  type LiveSports,
} from "../sports";

const WITH_BASKETBALL: LiveSports = { sports: ["football", "basketball"], other: false };

describe("LIVE_SPORTS: football only, for now", () => {
  it("is football, without the typed-in Other", () => {
    expect(LIVE_SPORTS).toEqual({ sports: ["football"], other: false });
  });

  it("keeps the whole catalogue in code", () => {
    expect(POOL_SPORT_KEYS.length).toBeGreaterThan(1);
    expect(POOL_SPORT_KEYS).toContain("basketball");
  });

  it("isLiveSport: only a live catalogue sport, and Other only when switched on", () => {
    expect(isLiveSport("football")).toBe(true);
    expect(isLiveSport("basketball")).toBe(false);
    expect(isLiveSport("padel")).toBe(false);
    expect(isLiveSport(OTHER_SPORT)).toBe(false);
    expect(isLiveSport("curling")).toBe(false);
    expect(isLiveSport("basketball", WITH_BASKETBALL)).toBe(true);
    expect(isLiveSport(OTHER_SPORT, { sports: ["football"], other: true })).toBe(true);
  });

  it("an unknown key in the switch is never live", () => {
    expect(isLiveSport("curling", { sports: ["curling" as never], other: false })).toBe(false);
  });

  it("liveSports: the catalogue entries that are live, in catalogue order", () => {
    expect(liveSports().map((s) => s.key)).toEqual(["football"]);
    expect(liveSports({ sports: ["basketball", "football"], other: false }).map((s) => s.key)).toEqual(["football", "basketball"]);
    expect(liveSports()[0].formats).toEqual([5, 7, 8, 9, 11]);
  });

  it("notLiveSportNames: every other catalogue sport in every language, lower case, never 'pool'", () => {
    const names = notLiveSportNames();
    expect(names).toEqual(expect.arrayContaining(["basketball", "basketbol", "tennis", "padel", "table tennis", "masa tenisi", "snooker", "billiards", "squash", "badminton"]));
    expect(names).not.toContain("football");
    expect(names).not.toContain("futbol");
    // "pool" is also the word for the player pool; never a sport name to guard.
    expect(names).not.toContain("pool");
    expect(notLiveSportNames(WITH_BASKETBALL)).not.toContain("basketball");
    expect(new Set(names).size).toBe(names.length);
    expect(POOL_SPORTS.length).toBeGreaterThan(liveSports().length);
  });

  it("sportChoiceKey: one key per sport, Other by its name, case-blind", () => {
    expect(sportChoiceKey({ sport: "padel", otherName: "" })).toBe("padel:");
    expect(sportChoiceKey({ sport: OTHER_SPORT, otherName: "Frisbee" })).toBe("other:frisbee");
  });
});
