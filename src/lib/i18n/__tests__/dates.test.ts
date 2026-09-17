/**
 * The per-language date labels.
 *
 * Every English label here is BYTE-IDENTICAL to what the caller
 * formatted before the helper existed (the golden snapshot is the
 * second proof); the Turkish ones are what a Turkish group reads. Both
 * are London wall-clock: locale is what a date LOOKS like, timezone is
 * what it IS, and only the first moves (design section 3).
 *
 * Turkish writes the day before the month and the weekday after
 * ("22 Eylül Salı 21:30"), and the full weekday name rather than the
 * calendar abbreviation ("Salı", not "Sal"), which is how a club
 * announcement is written by hand.
 */
import { describe, it, expect } from "vitest";
import { dayLabel, kickoffLabel, longDayTimeLabel, squadCompleteLabel, timeLabel } from "../dates";
import { joinList } from "../text";

/** Tue 22 Sept 2026, 21:30 London (BST, UTC+1). */
const TUE = new Date("2026-09-22T20:30:00.000Z");
/** Fri 18 Sept 2026, 21:00 London. */
const FRI = new Date("2026-09-18T20:00:00.000Z");
/** Sat 3 Jan 2026, 14:00 London (GMT): a month with a Turkish letter. */
const JAN = new Date("2026-01-03T14:00:00.000Z");

describe("English labels are byte-identical to the patterns they replace", () => {
  it("kickoffLabel: EEE HH:mm", () => {
    expect(kickoffLabel("en", TUE)).toBe("Tue 21:30");
  });
  it("dayLabel: EEE d MMM", () => {
    expect(dayLabel("en", TUE)).toBe("Tue 22 Sep");
  });
  it("longDayTimeLabel: EEEE d MMMM 'at' HH:mm", () => {
    expect(longDayTimeLabel("en", TUE)).toBe("Tuesday 22 September at 21:30");
  });
  it("squadCompleteLabel keeps the Intl en-GB spelling ('Sept', comma stripped)", () => {
    // squad-announce.ts used Intl.DateTimeFormat("en-GB"), which renders
    // "Sept" where date-fns renders "Sep". The English club has read
    // "Sept" on every squad-complete post; it stays that way.
    expect(squadCompleteLabel("en", TUE)).toBe("Tue 22 Sept 21:30");
  });
  it("timeLabel: HH:mm, language-free", () => {
    expect(timeLabel(TUE)).toBe("21:30");
    expect(timeLabel(JAN)).toBe("14:00");
  });
});

describe("Turkish labels", () => {
  it("kickoffLabel: full weekday, then the time", () => {
    expect(kickoffLabel("tr", TUE)).toBe("Salı 21:30");
    expect(kickoffLabel("tr", FRI)).toBe("Cuma 21:00");
  });
  it("dayLabel: day, month, weekday", () => {
    expect(dayLabel("tr", TUE)).toBe("22 Eylül Salı");
    expect(dayLabel("tr", JAN)).toBe("3 Ocak Cumartesi");
  });
  it("longDayTimeLabel: day, month, weekday, time", () => {
    expect(longDayTimeLabel("tr", FRI)).toBe("18 Eylül Cuma 21:00");
  });
  it("squadCompleteLabel matches longDayTimeLabel (no Intl quirk to preserve)", () => {
    expect(squadCompleteLabel("tr", TUE)).toBe("22 Eylül Salı 21:30");
  });
  it("is London wall-clock, not UTC (BST)", () => {
    // 20:30Z is 21:30 in London in September.
    expect(kickoffLabel("tr", TUE)).toContain("21:30");
  });
});

describe("unknown languages fall back to English", () => {
  it("kickoffLabel", () => {
    expect(kickoffLabel("fr" as never, TUE)).toBe("Tue 21:30");
  });
});

describe("joinList", () => {
  it("English: Oxford-free 'A, B and C'", () => {
    expect(joinList("en", [])).toBe("");
    expect(joinList("en", ["Ali"])).toBe("Ali");
    expect(joinList("en", ["Ali", "Veli"])).toBe("Ali and Veli");
    expect(joinList("en", ["Ali", "Veli", "Can"])).toBe("Ali, Veli and Can");
  });
  it("Turkish: 've' joins the last name", () => {
    expect(joinList("tr", [])).toBe("");
    expect(joinList("tr", ["Ali"])).toBe("Ali");
    expect(joinList("tr", ["Ali", "Veli"])).toBe("Ali ve Veli");
    expect(joinList("tr", ["Ali", "Veli", "Can"])).toBe("Ali, Veli ve Can");
  });
});
