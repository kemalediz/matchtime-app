/**
 * Monthly squad, slice 5: "on the waiting list BY CHOICE" is read from the
 * attendance log's NOTE, because `AttendanceEvent` has no structured field
 * for it (the schema calls the note "never parsed, never branched on", and
 * this is the one deliberate exception).
 *
 * The seed's priority and the credit rule both depend on it
 * (`loadChoseBench` in monthly-week.ts). So the note is ONE exported
 * constant, written by `registerAttendance` and read by the month, and
 * this test fails if either side stops using it or its text changes.
 * If you are here because you changed the wording: old events in the
 * database still carry the old text. Keep reading the old text too, or
 * add a structured column and backfill it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EXPLICIT_BENCH_NOTE } from "../attendance-events";

const src = (file: string) => readFileSync(path.join(__dirname, "..", file), "utf8");

describe("the bench-by-choice marker", () => {
  it("is the text production events already carry", () => {
    expect(EXPLICIT_BENCH_NOTE).toBe("explicit bench request");
  });

  it("is written by registerAttendance from the constant, not from a second copy of the words", () => {
    const attendance = src("attendance.ts");
    expect(attendance).toContain("EXPLICIT_BENCH_NOTE");
    expect(attendance).not.toContain('"explicit bench request"');
  });

  it("is read by the month from the same constant", () => {
    const month = src("monthly-week.ts");
    expect(month).toContain('import { EXPLICIT_BENCH_NOTE, recordAttendanceEvent } from "./attendance-events"');
    expect(month).not.toContain('"explicit bench request"');
  });
});
