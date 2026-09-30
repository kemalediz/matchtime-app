/**
 * The drop-out deadline the rolling squad uses (plan 1.5). Slice 3 adds
 * a club-level weekly deadline; until one is set, it is the match's own
 * sign-up deadline (kickoff minus `deadlineHours`), so slice 1 ships on
 * its own.
 */
import { describe, it, expect } from "vitest";
import { dropOutDeadlineFor } from "../weekly-deadlines";
import { weekdayTimeLabel } from "../i18n/dates";

describe("dropOutDeadlineFor", () => {
  it("falls back to the match's attendanceDeadline", () => {
    const attendanceDeadline = new Date("2026-10-09T14:30:00.000Z");
    expect(dropOutDeadlineFor({ date: new Date("2026-10-09T19:30:00.000Z"), attendanceDeadline })).toEqual(
      attendanceDeadline,
    );
  });
});

describe("weekdayTimeLabel: the deadline as a player reads it", () => {
  const mon = new Date("2026-10-05T20:00:00.000Z"); // Mon 21:00 BST
  it("English: Monday 21:00", () => expect(weekdayTimeLabel("en", mon)).toBe("Monday 21:00"));
  it("Turkish: Pazartesi 21:00", () => expect(weekdayTimeLabel("tr", mon)).toBe("Pazartesi 21:00"));
});
