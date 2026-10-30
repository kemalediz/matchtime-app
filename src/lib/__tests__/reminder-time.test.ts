/**
 * WHEN A REMINDER IS SENT (2026-10-30, "no string parsing"): the admin
 * extractor states a London "YYYY-MM-DD HH:MM" (`remindAt`); this file
 * turns it into an instant, DST-safe, and refuses anything malformed. No
 * word of the person's message is read here any more.
 */
import { describe, expect, it } from "vitest";
import { reminderInstant } from "../reminder-time";

describe("reminderInstant", () => {
  it("a London wall-clock time in summer is an hour behind in UTC", () => {
    const r = reminderInstant("2026-09-09 18:00", "en");
    expect(r.ok && r.at.toISOString()).toBe("2026-09-09T17:00:00.000Z");
    expect(r.ok && r.whenLabel).toBe("Wed 9 Sep at 18:00");
  });

  it("in winter London is UTC", () => {
    const r = reminderInstant("2026-11-03 09:00", "en");
    expect(r.ok && r.at.toISOString()).toBe("2026-11-03T09:00:00.000Z");
  });

  it("across the clocks-go-back night the wall clock is kept", () => {
    const before = reminderInstant("2026-10-24 18:00");
    const after = reminderInstant("2026-10-25 18:00");
    expect(before.ok && before.at.toISOString()).toBe("2026-10-24T17:00:00.000Z");
    expect(after.ok && after.at.toISOString()).toBe("2026-10-25T18:00:00.000Z");
  });

  it("labels in the group's language", () => {
    const r = reminderInstant("2026-09-10 09:00", "tr");
    expect(r.ok && r.whenLabel).toBe("10 Eylül Perşembe 09:00");
  });

  it.each(["", "tomorrow at 6", "2026-09-10", "2026-13-01 09:00", "2026-02-30 09:00", "2026-09-10 25:00", "18:00"])(
    "refuses %j: not the extractor's YYYY-MM-DD HH:MM, or not a real date",
    (v) => {
      expect(reminderInstant(v).ok).toBe(false);
    },
  );

  it("the label carries no dashes", () => {
    const r = reminderInstant("2026-09-10 09:00", "en");
    expect(r.ok && r.whenLabel).not.toMatch(/[–—]/);
  });
});

describe("the clocks-go-forward gap (review of #476)", () => {
  it("a time that does not exist in London moves to the next valid time, and says so", () => {
    // 2027-03-28: 01:00 GMT jumps to 02:00 BST, so 01:30 never happens.
    const r = reminderInstant("2027-03-28 01:30", "en");
    expect(r.ok && r.shiftedForClocks).toBe(true);
    expect(r.ok && r.at.toISOString()).toBe("2027-03-28T01:00:00.000Z"); // 02:00 BST
    expect(r.ok && r.whenLabel).toBe("Sun 28 Mar at 02:00");
  });

  it("an ordinary time is not shifted", () => {
    const r = reminderInstant("2027-03-28 09:00", "en");
    expect(r.ok && r.shiftedForClocks).toBe(false);
  });
});
