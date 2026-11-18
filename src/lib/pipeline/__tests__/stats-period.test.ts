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
import { periodSince } from "../stats-period";
import type { StatsPeriod } from "../types";

// Wednesday 23 September 2026, 21:30 London (BST, UTC+1).
const NOW = new Date("2026-09-23T20:30:00.000Z");

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

