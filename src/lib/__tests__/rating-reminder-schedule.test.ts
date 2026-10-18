/**
 * AT MOST TWO RATING REMINDERS (Kemal, 2026-10-18).
 *
 * The first rating DM goes the morning after the match (6b). Before this
 * change 6d then reminded the player at 18:00 London EVERY day of the
 * five-day rating window, up to five nudges. The owner's rule now:
 *
 *   reminder 1  18:00 London on the day AFTER the first DM was sent;
 *   reminder 2  18:00 London two days after reminder 1, the last one,
 *               and only while the rating window is still open;
 *   then stop.
 *
 * The count comes from what was actually sent (the reminder keys carry
 * their London day), never from the calendar alone, so a missed run
 * shifts the schedule rather than firing two at once or a third one.
 */
import { describe, it, expect } from "vitest";
import {
  dueRatingReminder,
  ratingReminderKey,
  sentRatingReminderDays,
  RATING_REMINDER_MAX,
} from "../rating-reminder-schedule";

/** Tue 22 Sept 2026, 21:30 London (BST). */
const KICKOFF = new Date("2026-09-22T20:30:00.000Z");
/** Wed 23 Sept, 08:06 London: the first rating DM. */
const FIRST_DM = new Date("2026-09-23T07:06:00.000Z");
const WINDOW = 120;

/** 18:10 London on 2026-09-<day>. */
const at1810 = (day: number) => new Date(`2026-09-${String(day).padStart(2, "0")}T17:10:00.000Z`);

const due = (now: Date, sent: string[] = [], over: Partial<Parameters<typeof dueRatingReminder>[0]> = {}) =>
  dueRatingReminder({ matchAt: KICKOFF, windowHours: WINDOW, firstDmAt: FIRST_DM, sentReminderDays: sent, now, ...over });

describe("the normal week", () => {
  it("nothing on the day of the first DM, even at 18:00", () => {
    expect(due(at1810(23))).toBeNull();
  });
  it("reminder 1 at 18:00 the day after the first DM", () => {
    expect(due(at1810(24))).toBe(1);
  });
  it("nothing the day after reminder 1", () => {
    expect(due(at1810(25), ["2026-09-24"])).toBeNull();
  });
  it("reminder 2 two days after reminder 1", () => {
    expect(due(at1810(26), ["2026-09-24"])).toBe(2);
  });
  it("nothing after the second reminder, ever", () => {
    expect(due(at1810(27), ["2026-09-24", "2026-09-26"])).toBeNull();
    expect(RATING_REMINDER_MAX).toBe(2);
  });
});

describe("only in the 18:00 hour", () => {
  it("17:59 and 19:00 London are not reminder time", () => {
    expect(due(new Date("2026-09-24T16:59:00.000Z"))).toBeNull();
    expect(due(new Date("2026-09-24T18:00:00.000Z"))).toBeNull();
  });
  it("18:00 and 18:59 London are", () => {
    expect(due(new Date("2026-09-24T17:00:00.000Z"))).toBe(1);
    expect(due(new Date("2026-09-24T17:59:00.000Z"))).toBe(1);
  });
});

describe("missed runs shift the schedule, never double it", () => {
  it("bot down on the day reminder 1 was due: it goes the next day, alone", () => {
    expect(due(at1810(25))).toBe(1);
  });
  it("and reminder 2 then waits two days from when reminder 1 really went", () => {
    expect(due(at1810(26), ["2026-09-25"])).toBeNull();
    expect(due(at1810(27), ["2026-09-25"])).toBe(2);
  });
  it("bot down on the day reminder 2 was due: it goes the next day if the window is still open", () => {
    expect(due(at1810(27), ["2026-09-24"])).toBe(2);
  });
  it("a reminder already sent today blocks another one today", () => {
    expect(due(at1810(26), ["2026-09-26"])).toBeNull();
  });
  it("a first DM that went late (the evening after the match) still waits for the next day", () => {
    const lateDm = new Date("2026-09-23T17:30:00.000Z"); // 18:30 London on the 23rd
    expect(due(at1810(23), [], { firstDmAt: lateDm })).toBeNull();
    expect(due(at1810(24), [], { firstDmAt: lateDm })).toBe(1);
  });
  it("history from the old daily reminders counts: two already sent means none more", () => {
    expect(due(at1810(26), ["2026-09-24", "2026-09-25"])).toBeNull();
  });
});

describe("the rating window", () => {
  it("no reminder without a first DM", () => {
    expect(due(at1810(24), [], { firstDmAt: null })).toBeNull();
  });
  it("reminder 2 is skipped when the window has closed by then", () => {
    // Saturday 17:00 London kickoff: the 120h window shuts at 17:00 on
    // the Thursday, so an 18:10 reminder that day would link to a closed page.
    const sat = new Date("2026-09-19T16:00:00.000Z");
    const dm = new Date("2026-09-20T07:06:00.000Z");
    const opts = { matchAt: sat, firstDmAt: dm };
    expect(due(at1810(21), [], opts)).toBe(1);
    expect(due(at1810(23), ["2026-09-21"], opts)).toBe(2); // Wed: still open
    // Reminder 1 delayed to Tue by a missed run; reminder 2 would be Thu.
    expect(due(at1810(24), ["2026-09-22"], opts)).toBeNull();
  });
  it("respects a club's own (shorter) window", () => {
    expect(due(at1810(26), ["2026-09-24"], { windowHours: 72 })).toBeNull();
  });
});

describe("keys", () => {
  it("one key per player per London day, the format the history already uses", () => {
    expect(ratingReminderKey("m1", "u1", at1810(24))).toBe("m1:rate-reminder:u1:2026-09-24");
  });
  it("reads back the days sent for that player only", () => {
    const keys = [
      "m1:rate-reminder:u1:2026-09-26",
      "m1:rate-reminder:u1:2026-09-24",
      "m1:rate-reminder:u2:2026-09-25",
      "m2:rate-reminder:u1:2026-09-25",
      "m1:rate-dm:u1",
    ];
    expect(sentRatingReminderDays(keys, "m1", "u1")).toEqual(["2026-09-24", "2026-09-26"]);
  });
});
