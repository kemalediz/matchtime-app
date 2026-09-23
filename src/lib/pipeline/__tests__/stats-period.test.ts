/**
 * THE TIME PERIOD OF A STATS QUESTION (2026-09-23).
 *
 * The incident: "@Match Time who has played most matches in the last 1
 * year?" was answered "Most appearances in the last 30 days", three
 * names. `QuestionFacts` had no field for a period, so "the last 1 year"
 * was discarded by construction, exactly as "which table" and "how
 * many" were before #126. The model now names the period; this module
 * turns it into a date, and nothing else does.
 */
import { describe, expect, it } from "vitest";
import { cutsTheRecord, parsePeriodFields, periodKey, periodSince } from "../stats-period";
import type { StatsPeriod } from "../types";

// Wednesday 23 September 2026, 21:30 London (BST, UTC+1).
const NOW = new Date("2026-09-23T20:30:00.000Z");

describe("parsing the extractor's three period fields", () => {
  it("Kemal's question: the last 1 year", () => {
    expect(parsePeriodFields({ period: "last", periodCount: 1, periodUnit: "year" })).toEqual({
      period: { kind: "last", count: 1, unit: "year" },
      problem: null,
    });
  });

  it("'last month' with no number is one month", () => {
    expect(parsePeriodFields({ period: "last", periodCount: -1, periodUnit: "month" }).period).toEqual({
      kind: "last",
      count: 1,
      unit: "month",
    });
  });

  it("this week, month and year are the calendar ones", () => {
    for (const unit of ["week", "month", "year"] as const) {
      expect(parsePeriodFields({ period: "this", periodCount: -1, periodUnit: unit }).period).toEqual({ kind: "this", unit });
    }
  });

  it("season and all time carry no number and no unit", () => {
    expect(parsePeriodFields({ period: "season", periodCount: -1, periodUnit: "none" }).period).toEqual({ kind: "season" });
    expect(parsePeriodFields({ period: "all_time", periodCount: -1, periodUnit: "none" }).period).toEqual({ kind: "all_time" });
  });

  it("'none' is no period, and an absent field (an older payload) is no period", () => {
    expect(parsePeriodFields({ period: "none", periodCount: -1, periodUnit: "none" })).toEqual({ period: null, problem: null });
    expect(parsePeriodFields({})).toEqual({ period: null, problem: null });
  });

  it("a period that cannot be read is dropped LOUDLY, never guessed", () => {
    const noUnit = parsePeriodFields({ period: "last", periodCount: 3, periodUnit: "none" });
    expect(noUnit.period).toBeNull();
    expect(noUnit.problem).toMatch(/unit/);
    const drift = parsePeriodFields({ period: "fortnight", periodCount: 1, periodUnit: "week" });
    expect(drift.period).toBeNull();
    expect(drift.problem).toMatch(/fortnight/);
    // "this day" is not a calendar period anybody asks a table for.
    expect(parsePeriodFields({ period: "this", periodCount: -1, periodUnit: "day" }).period).toBeNull();
  });

  it("the count is floored and capped, never trusted as written", () => {
    expect(parsePeriodFields({ period: "last", periodCount: 2.7, periodUnit: "week" }).period).toEqual({ kind: "last", count: 2, unit: "week" });
    expect(parsePeriodFields({ period: "last", periodCount: 5000, periodUnit: "day" }).period).toEqual({ kind: "last", count: 100, unit: "day" });
  });
});

describe("which periods cut the record", () => {
  it("a rolling or calendar span cuts it; the season, all time and no period do not", () => {
    expect(cutsTheRecord({ kind: "last", count: 1, unit: "year" })).toBe(true);
    expect(cutsTheRecord({ kind: "this", unit: "month" })).toBe(true);
    expect(cutsTheRecord({ kind: "season" })).toBe(false);
    expect(cutsTheRecord({ kind: "all_time" })).toBe(false);
    expect(cutsTheRecord(null)).toBe(false);
    expect(cutsTheRecord(undefined)).toBe(false);
  });
});

describe("the date a period starts from", () => {
  const since = (p: StatsPeriod) => periodSince(p, NOW)?.toISOString() ?? null;

  it("rolling spans count back from now", () => {
    expect(since({ kind: "last", count: 1, unit: "year" })).toBe("2025-09-23T20:30:00.000Z");
    expect(since({ kind: "last", count: 3, unit: "month" })).toBe("2026-06-23T20:30:00.000Z");
    expect(since({ kind: "last", count: 2, unit: "week" })).toBe("2026-09-09T20:30:00.000Z");
    expect(since({ kind: "last", count: 10, unit: "day" })).toBe("2026-09-13T20:30:00.000Z");
  });

  it("calendar spans start at London midnight", () => {
    // 1 September 2026 00:00 BST
    expect(since({ kind: "this", unit: "month" })).toBe("2026-08-31T23:00:00.000Z");
    // Monday 21 September 2026 00:00 BST
    expect(since({ kind: "this", unit: "week" })).toBe("2026-09-20T23:00:00.000Z");
    // 1 January 2026 00:00 GMT
    expect(since({ kind: "this", unit: "year" })).toBe("2026-01-01T00:00:00.000Z");
  });

  it("the season and all time are the whole record: no start date", () => {
    expect(since({ kind: "season" })).toBeNull();
    expect(since({ kind: "all_time" })).toBeNull();
  });
});

describe("the key a period is loaded under", () => {
  it("is stable and distinct per period", () => {
    const keys = [
      periodKey({ kind: "last", count: 1, unit: "year" }),
      periodKey({ kind: "last", count: 12, unit: "month" }),
      periodKey({ kind: "this", unit: "month" }),
      periodKey({ kind: "season" }),
      periodKey({ kind: "all_time" }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(periodKey({ kind: "last", count: 1, unit: "year" })).toBe(periodKey({ kind: "last", count: 1, unit: "year" }));
  });
});
