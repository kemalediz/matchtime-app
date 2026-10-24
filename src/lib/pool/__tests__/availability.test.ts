/**
 * Day AND hours (slice L4): a player is available for a game only when his
 * London ranges cover the whole game, kickoff to kickoff + length.
 */
import { describe, expect, it } from "vitest";
import { londonDateTimeToUtc } from "../../london-time";
import { availableFor, gameWindowOf, WEEK_MINS } from "../availability";
import type { AvailabilityRange } from "../rules";

const at = (date: string, time: string) => londonDateTimeToUtc(date, time);
const r = (day: number, from: string, to: string): AvailabilityRange => {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return { day, fromMin: m(from), toMin: m(to) };
};
// 2026-10-27 is a Tuesday (GMT); 2026-07-14 a Tuesday (BST).
const TUE = 2;

describe("gameWindowOf: London week minutes", () => {
  it("a Tuesday 19:00 game is the same window in summer (BST) and winter (GMT)", () => {
    const summer = gameWindowOf(at("2026-07-14", "19:00"), 60);
    const winter = gameWindowOf(at("2026-10-27", "19:00"), 60);
    expect(summer).toEqual({ start: TUE * 1440 + 19 * 60, end: TUE * 1440 + 20 * 60 });
    expect(winter).toEqual(summer);
  });

  it("Saturday 23:30 for an hour wraps past the week's end, never backwards", () => {
    const w = gameWindowOf(at("2026-10-31", "23:30"), 60);
    expect(w.start).toBe(6 * 1440 + 23 * 60 + 30);
    expect(w.end).toBe(WEEK_MINS + 30);
  });

  it("the autumn clock change: 01:30 BST + 60 real minutes is still a full hour of wall clock", () => {
    // 2026-10-25 01:30 BST = 00:30Z; an hour later is 01:30 GMT (the same wall clock).
    const kickoff = new Date("2026-10-25T00:30:00Z");
    const w = gameWindowOf(kickoff, 60);
    expect(w.start).toBe(0 * 1440 + 90);
    expect(w.end - w.start).toBe(60);
  });

  it("the spring clock change: 00:30 GMT + 60 real minutes ends at 02:30 BST (the longer wall span)", () => {
    const kickoff = new Date("2027-03-28T00:30:00Z");
    const w = gameWindowOf(kickoff, 60);
    expect(w).toEqual({ start: 30, end: 150 });
  });
});

describe("availableFor: the ranges cover the whole game", () => {
  const kickoff = at("2026-10-27", "19:00"); // Tuesday
  const table: Array<[string, AvailabilityRange[], number, boolean]> = [
    ["exactly the game", [r(TUE, "19:00", "20:00")], 60, true],
    ["wider than the game", [r(TUE, "18:00", "22:00")], 60, true],
    ["starts one minute late", [r(TUE, "19:01", "22:00")], 60, false],
    ["ends one minute early", [r(TUE, "18:00", "19:59")], 60, false],
    ["the right hours on the wrong day", [r(3, "18:00", "22:00")], 60, false],
    ["no ranges at all", [], 60, false],
    ["two touching ranges (not merged in storage)", [r(TUE, "18:00", "19:30"), r(TUE, "19:30", "21:00")], 60, true],
    ["two ranges with a gap inside the game", [r(TUE, "18:00", "19:20"), r(TUE, "19:30", "21:00")], 60, false],
    ["overlapping ranges, unsorted", [r(TUE, "19:20", "21:00"), r(TUE, "18:00", "19:40")], 60, true],
    ["a 90 minute game needs 90 minutes", [r(TUE, "19:00", "20:00")], 90, false],
    ["multi-range day, the second range fits", [r(TUE, "07:00", "09:00"), r(TUE, "19:00", "21:00")], 90, true],
  ];
  it.each(table)("%s", (_name, ranges, mins, want) => {
    expect(availableFor(ranges, kickoff, mins)).toBe(want);
  });

  it("an overnight game is covered by two ranges on two days (ranges never cross midnight)", () => {
    const late = at("2026-10-27", "23:30");
    expect(availableFor([r(TUE, "22:00", "24:00"), r(3, "00:00", "01:00")], late, 60)).toBe(true);
    expect(availableFor([r(TUE, "22:00", "24:00")], late, 60)).toBe(false);
    expect(availableFor([r(TUE, "22:00", "24:00"), r(3, "00:15", "01:00")], late, 60)).toBe(false);
  });

  it("an overnight game across the week's end (Saturday into Sunday)", () => {
    const late = at("2026-10-31", "23:30");
    expect(availableFor([r(6, "23:00", "24:00"), r(0, "00:00", "02:00")], late, 60)).toBe(true);
    expect(availableFor([r(6, "23:00", "24:00")], late, 60)).toBe(false);
  });

  it("a range ending at 24:00 covers a game ending at midnight", () => {
    expect(availableFor([r(TUE, "22:00", "24:00")], at("2026-10-27", "23:00"), 60)).toBe(true);
  });

  it("a zero or bad length still needs the kickoff minute covered", () => {
    expect(availableFor([r(TUE, "19:00", "19:01")], kickoff, 0)).toBe(true);
    expect(availableFor([r(TUE, "19:01", "20:00")], kickoff, 0)).toBe(false);
  });

  it("property: covering more never makes a player unavailable", () => {
    for (let h = 6; h < 23; h++) {
      const k = at("2026-10-27", `${String(h).padStart(2, "0")}:00`);
      const narrow = [r(TUE, `${String(h).padStart(2, "0")}:00`, `${String(h + 1).padStart(2, "0")}:00`)];
      expect(availableFor(narrow, k, 60)).toBe(true);
      expect(availableFor([...narrow, r(TUE, "00:00", "24:00")], k, 60)).toBe(true);
      expect(availableFor([r(TUE, "00:00", "24:00")], k, 60)).toBe(true);
    }
  });
});
