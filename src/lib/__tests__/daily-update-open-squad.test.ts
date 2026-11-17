/**
 * THE DAILY 17:00 UPDATE FOR AN OPEN SQUAD (2026-11-17, open-squad.ts).
 *
 * No places, so there is never "a place open" to chase and never a full
 * squad with a thin bench. The scheduler passes `open` as how many are
 * short of the game's minimum (`placesToFill`), so the post goes out only
 * while the game cannot be played, and never asks for benchers.
 */
import { describe, it, expect } from "vitest";
import { decideDailyUpdate, type DailyUpdateFacts } from "@/lib/daily-update-rules";

const BASE: DailyUpdateFacts = {
  audience: "group",
  squad: "weekly",
  isMatchDay: false,
  teamsOut: false,
  weeklyRhythmDay: false,
  beforeDeadline: true,
  open: 0,
  bench: 0,
  squadLockedToday: false,
  openSquad: true,
};
const decide = (over: Partial<DailyUpdateFacts>) => decideDailyUpdate({ ...BASE, ...over });

describe("open squad", () => {
  it("below the minimum: the chase (weekly), or the month's list with no bench ask", () => {
    expect(decide({ open: 2 })).toEqual({ post: "chase" });
    expect(decide({ squad: "month", open: 2 })).toEqual({ post: "month-list", benchAsk: false });
  });

  it("at or above the minimum: nothing, on any day, to anyone", () => {
    expect(decide({})).toEqual({ post: null, why: "enough-players" });
    expect(decide({ squad: "month" })).toEqual({ post: null, why: "enough-players" });
    expect(decide({ isMatchDay: true })).toEqual({ post: null, why: "enough-players" });
    expect(decide({ audience: "organisers" })).toEqual({ post: null, why: "enough-players" });
  });

  it("match day with the teams made still gets the line-ups", () => {
    expect(decide({ isMatchDay: true, teamsOut: true })).toEqual({ post: "line-ups" });
  });

  it("after the deadline, or a month not on the game yet: nothing", () => {
    expect(decide({ open: 3, beforeDeadline: false })).toEqual({ post: null, why: "after-deadline" });
    expect(decide({ squad: "no-month", open: 3 })).toEqual({ post: null, why: "no-month-list" });
  });

  it("off: a full weekly squad with an empty bench still gets its post, as before", () => {
    expect(decide({ openSquad: false })).toEqual({ post: "squad-full" });
  });
});
