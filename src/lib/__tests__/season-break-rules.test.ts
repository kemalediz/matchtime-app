/**
 * A season break (2026-10-29, Vets MNF: "no football in December, back in
 * January"): the pure rules.
 */
import { describe, expect, it } from "vitest";
import { carryFromMonthStart, isBreakMonth, prepareSeasonBreak } from "../squad-month-rules";

const NOW = new Date("2026-10-29T12:00:00Z");

describe("isBreakMonth", () => {
  it("reads a month start or a month key", () => {
    expect(isBreakMonth(["2026-12"], "2026-12-01")).toBe(true);
    expect(isBreakMonth(["2026-12"], "2026-11-01")).toBe(false);
    expect(isBreakMonth(null, "2026-12-01")).toBe(false);
  });
});

describe("prepareSeasonBreak", () => {
  it("keeps this month and later, in order, once each", () => {
    expect(prepareSeasonBreak(["2027-01", "2026-12", "2026-12"], NOW)).toEqual({ ok: true, value: ["2026-12", "2027-01"] });
  });
  it("drops months already past rather than refusing them", () => {
    expect(prepareSeasonBreak(["2026-09", "2026-12"], NOW)).toEqual({ ok: true, value: ["2026-12"] });
  });
  it("refuses anything that is not a month, or more than a year ahead", () => {
    for (const bad of [["December"], ["2026-13"], ["2026-12-01"], [12], "2026-12", ["2027-11"]]) {
      expect(prepareSeasonBreak(bad, NOW)).toEqual({ ok: false, error: "bad-months" });
    }
  });
  it("an empty list clears the break", () => {
    expect(prepareSeasonBreak([], NOW)).toEqual({ ok: true, value: [] });
  });
});

describe("carryFromMonthStart", () => {
  it("is the month before, as always", () => {
    expect(carryFromMonthStart("2026-12-01", [])).toBe("2026-11-01");
  });
  it("January after a December break carries November's regulars", () => {
    expect(carryFromMonthStart("2027-01-01", ["2026-12"])).toBe("2026-11-01");
  });
  it("steps back over several break months", () => {
    expect(carryFromMonthStart("2027-03-01", ["2027-01", "2027-02"])).toBe("2026-12-01");
  });
});
