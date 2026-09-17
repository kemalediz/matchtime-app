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
import {
  dayLabel,
  dayOfMonthLabel,
  historyDateLabel,
  kickoffLabel,
  longDayTimeLabel,
  squadCompleteLabel,
  timeLabel,
  weekdayLabel,
} from "../dates";
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

describe("the DM Q&A's pieces: weekday, day of month, history date (2026-09-17)", () => {
  // The DM Q&A model once called a Friday match "Cumartesi" (1 of 30
  // live answers). It was translating dates it was handed in English.
  // These labels let the context hand it every piece already written.
  it("weekdayLabel: the full weekday name", () => {
    expect(weekdayLabel("en", FRI)).toBe("Friday");
    expect(weekdayLabel("tr", FRI)).toBe("Cuma");
    expect(weekdayLabel("tr", TUE)).toBe("Salı");
    expect(weekdayLabel("tr", JAN)).toBe("Cumartesi");
  });
  it("dayOfMonthLabel: day and month, no weekday", () => {
    expect(dayOfMonthLabel("en", FRI)).toBe("18 September");
    expect(dayOfMonthLabel("tr", FRI)).toBe("18 Eylül");
    expect(dayOfMonthLabel("tr", JAN)).toBe("3 Ocak");
  });
  it("historyDateLabel: English is the Intl en-GB form the history block always used", () => {
    // match-history.ts: Intl.DateTimeFormat("en-GB", {day:"2-digit",
    // month:"short", year:"numeric"}). "Sept", with a leading zero.
    expect(historyDateLabel("en", new Date("2026-09-04T20:00:00.000Z"))).toBe("04 Sept 2026");
    expect(historyDateLabel("en", JAN)).toBe("03 Jan 2026");
  });
  it("historyDateLabel: Turkish carries the weekday, so the model never works one out", () => {
    expect(historyDateLabel("tr", new Date("2026-09-04T20:00:00.000Z"))).toBe("4 Eylül 2026 Cuma");
    expect(historyDateLabel("tr", JAN)).toBe("3 Ocak 2026 Cumartesi");
  });
  it("is London wall-clock: 23:30 London on a Friday is still Friday", () => {
    // 22:30Z on Fri 18 Sep is 23:30 BST, Friday.
    const late = new Date("2026-09-18T22:30:00.000Z");
    expect(weekdayLabel("tr", late)).toBe("Cuma");
    // 23:30Z is 00:30 BST on Saturday.
    expect(weekdayLabel("tr", new Date("2026-09-18T23:30:00.000Z"))).toBe("Cumartesi");
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
