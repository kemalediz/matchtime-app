/**
 * Which months an organiser's posted list may START (2026-11-03, Vets MNF):
 * the coming month as before, and now also THIS month when it is already
 * under way and was never started. Davide posted "MNF November" on 3 Nov,
 * the day after November's first Monday, and nothing could open November
 * from it: the door only knew "the next month".
 */
import { describe, it, expect } from "vitest";
import { seedTargets } from "@/lib/month-signup-rules";

// Monday 20:30, the Vets fixture.
const MON = { dayOfWeek: 1, time: "20:30" };

describe("seedTargets", () => {
  it("3 Nov 2026, the day after the first Monday, nothing started: November part-way (1 of 5 played), then December", () => {
    const t = seedTargets({ now: new Date("2026-11-03T09:14:00Z"), ...MON, breakMonths: [], started: new Set() });
    expect(t.map((x) => [x.monthStart, x.games, x.gamesPlayed])).toEqual([
      ["2026-11-01", 5, 1],
      ["2026-12-01", 4, 0],
    ]);
  });

  it("before the month's first game: this month with nothing played, then next month (as before)", () => {
    const t = seedTargets({ now: new Date("2026-11-01T10:00:00Z"), ...MON, breakMonths: [], started: new Set() });
    expect(t.map((x) => [x.monthStart, x.gamesPlayed])).toEqual([
      ["2026-11-01", 0],
      ["2026-12-01", 0],
    ]);
  });

  it("a month already started is never offered again", () => {
    const t = seedTargets({ now: new Date("2026-11-03T09:14:00Z"), ...MON, breakMonths: [], started: new Set(["2026-11-01"]) });
    expect(t.map((x) => x.monthStart)).toEqual(["2026-12-01"]);
  });

  it("a month with every game played is not offered: only the next one", () => {
    const t = seedTargets({ now: new Date("2026-11-30T22:00:00Z"), ...MON, breakMonths: [], started: new Set() });
    expect(t.map((x) => x.monthStart)).toEqual(["2026-12-01"]);
  });

  it("a break month is skipped", () => {
    const t = seedTargets({ now: new Date("2026-11-03T09:14:00Z"), ...MON, breakMonths: ["2026-12"], started: new Set() });
    expect(t.map((x) => x.monthStart)).toEqual(["2026-11-01"]);
  });

  it("each target carries its first kick-off", () => {
    const [nov] = seedTargets({ now: new Date("2026-11-03T09:14:00Z"), ...MON, breakMonths: [], started: new Set() });
    expect(nov.first.toISOString()).toBe("2026-11-02T20:30:00.000Z");
  });
});
