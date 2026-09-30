/**
 * Weekly deadlines, the pure rules (slice 3 of
 * MDs/friday-group-features-plan-2026-09-30.md, sections 3.1 to 3.3).
 *
 * Two club settings: the drop-out deadline (e.g. Monday 21:00) and the
 * list publish time (e.g. Tuesday 20:00). Each resolves, per match, to
 * the LAST occurrence of that weekday and London time strictly before
 * kickoff. Until one is set, the drop-out deadline is the match's own
 * sign-up deadline (kickoff minus `deadlineHours`), which is what slice 1
 * shipped with.
 */
import { describe, it, expect } from "vitest";
import {
  dropOutDeadlineFor,
  weeklyDeadlinesFor,
  lastWeekdayTimeBefore,
  hasWeeklyRhythm,
  dropOutReminderAt,
  dropOutReminderDue,
  deadlineSummaryDue,
  listPublishDue,
  validateWeeklyDeadlines,
  NO_WEEKLY_DEADLINES,
} from "../weekly-deadlines";
import { weekdayTimeLabel } from "../i18n/dates";

/** Fri 9 Oct 2026, 20:30 London (BST, 19:30 UTC). */
const FRI_KICKOFF = new Date("2026-10-09T19:30:00.000Z");
const HAMZAH = {
  dropOutDeadlineDay: 1,
  dropOutDeadlineTime: "21:00",
  listPublishDay: 2,
  listPublishTime: "20:00",
};
const FRIDAY_ACTIVITY = { dayOfWeek: 5, time: "20:30" };

describe("dropOutDeadlineFor", () => {
  const attendanceDeadline = new Date("2026-10-09T14:30:00.000Z");
  it("falls back to the match's attendanceDeadline when the club has no weekly deadline", () => {
    expect(dropOutDeadlineFor({ date: FRI_KICKOFF, attendanceDeadline })).toEqual(attendanceDeadline);
    expect(dropOutDeadlineFor({ date: FRI_KICKOFF, attendanceDeadline }, null)).toEqual(attendanceDeadline);
    expect(dropOutDeadlineFor({ date: FRI_KICKOFF, attendanceDeadline }, NO_WEEKLY_DEADLINES)).toEqual(
      attendanceDeadline,
    );
  });

  it("returns the club's weekly deadline when one is set", () => {
    expect(dropOutDeadlineFor({ date: FRI_KICKOFF, attendanceDeadline }, HAMZAH)).toEqual(
      new Date("2026-10-05T20:00:00.000Z"), // Mon 5 Oct 21:00 BST
    );
  });

  it("a half-set pair (day without time) is treated as unset", () => {
    expect(
      dropOutDeadlineFor({ date: FRI_KICKOFF, attendanceDeadline }, { ...HAMZAH, dropOutDeadlineTime: null }),
    ).toEqual(attendanceDeadline);
  });
});

describe("weeklyDeadlinesFor: the last occurrence strictly before kickoff", () => {
  it("Friday 20:30 match: Monday 21:00 and Tuesday 20:00 of the same week", () => {
    expect(weeklyDeadlinesFor(FRI_KICKOFF, HAMZAH)).toEqual({
      dropOut: new Date("2026-10-05T20:00:00.000Z"),
      listPublish: new Date("2026-10-06T19:00:00.000Z"),
    });
  });

  it("the same weekday at an earlier time is the match day itself", () => {
    expect(lastWeekdayTimeBefore(FRI_KICKOFF, 5, "12:00")).toEqual(new Date("2026-10-09T11:00:00.000Z"));
  });

  it("the same weekday at a later time resolves to the week before (which validation refuses)", () => {
    expect(lastWeekdayTimeBefore(FRI_KICKOFF, 5, "21:00")).toEqual(new Date("2026-10-02T20:00:00.000Z"));
  });

  it("the October DST weekend: a Saturday before is BST, the Monday after is GMT", () => {
    // Fri 30 Oct 2026 20:30 GMT; clocks went back on Sun 25 Oct.
    const kickoff = new Date("2026-10-30T20:30:00.000Z");
    expect(lastWeekdayTimeBefore(kickoff, 1, "21:00")).toEqual(new Date("2026-10-26T21:00:00.000Z"));
    expect(lastWeekdayTimeBefore(kickoff, 6, "21:00")).toEqual(new Date("2026-10-24T20:00:00.000Z"));
    // Sunday 25 Oct itself, after the change: 10:00 GMT.
    expect(lastWeekdayTimeBefore(kickoff, 0, "10:00")).toEqual(new Date("2026-10-25T10:00:00.000Z"));
  });

  it("nothing set: both null", () => {
    expect(weeklyDeadlinesFor(FRI_KICKOFF, null)).toEqual({ dropOut: null, listPublish: null });
  });

  it("the label a player reads", () => {
    const { dropOut } = weeklyDeadlinesFor(FRI_KICKOFF, HAMZAH);
    expect(weekdayTimeLabel("en", dropOut!)).toBe("Monday 21:00");
    expect(weekdayTimeLabel("tr", dropOut!)).toBe("Pazartesi 21:00");
  });
});

describe("hasWeeklyRhythm (D4: the 17:00 post stops off match day)", () => {
  it("only with both a drop-out deadline and a publish time", () => {
    expect(hasWeeklyRhythm(HAMZAH)).toBe(true);
    expect(hasWeeklyRhythm({ ...HAMZAH, listPublishDay: null, listPublishTime: null })).toBe(false);
    expect(hasWeeklyRhythm({ ...HAMZAH, dropOutDeadlineDay: null, dropOutDeadlineTime: null })).toBe(false);
    expect(hasWeeklyRhythm(null)).toBe(false);
    expect(hasWeeklyRhythm(undefined)).toBe(false);
  });
});

describe("D1: the drop-out reminder, 3 hours before, not before 09:00", () => {
  const MON_21 = new Date("2026-10-05T20:00:00.000Z");
  it("Monday 21:00 deadline: reminder at 18:00", () => {
    expect(dropOutReminderAt(MON_21)).toEqual(new Date("2026-10-05T17:00:00.000Z"));
  });

  it("an early deadline is clamped to 09:00", () => {
    // Mon 10:30 BST: 07:30 is too early, 09:00 leaves 90 minutes.
    expect(dropOutReminderAt(new Date("2026-10-05T09:30:00.000Z"))).toEqual(new Date("2026-10-05T08:00:00.000Z"));
  });

  it("skipped when the clamp leaves under an hour", () => {
    expect(dropOutReminderAt(new Date("2026-10-05T08:45:00.000Z"))).toBeNull(); // 09:45
    expect(dropOutReminderAt(new Date("2026-10-05T07:00:00.000Z"))).toBeNull(); // 08:00
  });

  it("exactly an hour is enough", () => {
    expect(dropOutReminderAt(new Date("2026-10-05T09:00:00.000Z"))).toEqual(new Date("2026-10-05T08:00:00.000Z"));
  });

  it("due from the reminder until the deadline, not before, not after", () => {
    expect(dropOutReminderDue(new Date("2026-10-05T16:59:00.000Z"), MON_21)).toBe(false);
    expect(dropOutReminderDue(new Date("2026-10-05T17:00:00.000Z"), MON_21)).toBe(true);
    expect(dropOutReminderDue(new Date("2026-10-05T19:59:00.000Z"), MON_21)).toBe(true);
    expect(dropOutReminderDue(MON_21, MON_21)).toBe(false);
  });
});

describe("D2: the deadline summary, first tick after the deadline, 08:00 to 21:59", () => {
  const MON_21 = new Date("2026-10-05T20:00:00.000Z");
  it("due at and after the deadline", () => {
    expect(deadlineSummaryDue(new Date("2026-10-05T19:59:00.000Z"), MON_21, FRI_KICKOFF)).toBe(false);
    expect(deadlineSummaryDue(new Date("2026-10-05T20:05:00.000Z"), MON_21, FRI_KICKOFF)).toBe(true);
  });

  it("a tick that slips past 22:00 waits until 08:00", () => {
    expect(deadlineSummaryDue(new Date("2026-10-05T21:10:00.000Z"), MON_21, FRI_KICKOFF)).toBe(false); // 22:10
    expect(deadlineSummaryDue(new Date("2026-10-06T06:30:00.000Z"), MON_21, FRI_KICKOFF)).toBe(false); // 07:30
    expect(deadlineSummaryDue(new Date("2026-10-06T07:00:00.000Z"), MON_21, FRI_KICKOFF)).toBe(true); // 08:00
  });

  it("never at or after kickoff", () => {
    expect(deadlineSummaryDue(FRI_KICKOFF, MON_21, FRI_KICKOFF)).toBe(false);
  });
});

describe("D3: the list, first tick after publish time, before kickoff", () => {
  const TUE_20 = new Date("2026-10-06T19:00:00.000Z");
  it("due at and after publish time", () => {
    expect(listPublishDue(new Date("2026-10-06T18:59:00.000Z"), TUE_20, FRI_KICKOFF)).toBe(false);
    expect(listPublishDue(new Date("2026-10-06T19:05:00.000Z"), TUE_20, FRI_KICKOFF)).toBe(true);
  });
  it("quiet hours hold it", () => {
    expect(listPublishDue(new Date("2026-10-06T21:30:00.000Z"), TUE_20, FRI_KICKOFF)).toBe(false); // 22:30
  });
  it("never at or after kickoff", () => {
    expect(listPublishDue(new Date("2026-10-09T19:31:00.000Z"), TUE_20, FRI_KICKOFF)).toBe(false);
  });
});

describe("validateWeeklyDeadlines (settings)", () => {
  it("accepts the Friday group's Monday 21:00 and Tuesday 20:00", () => {
    expect(validateWeeklyDeadlines(HAMZAH, [FRIDAY_ACTIVITY])).toBeNull();
  });

  it("accepts nothing set, and each pair on its own", () => {
    expect(validateWeeklyDeadlines(NO_WEEKLY_DEADLINES, [FRIDAY_ACTIVITY])).toBeNull();
    expect(
      validateWeeklyDeadlines({ ...NO_WEEKLY_DEADLINES, dropOutDeadlineDay: 1, dropOutDeadlineTime: "21:00" }, [
        FRIDAY_ACTIVITY,
      ]),
    ).toBeNull();
    expect(
      validateWeeklyDeadlines({ ...NO_WEEKLY_DEADLINES, listPublishDay: 2, listPublishTime: "20:00" }, [
        FRIDAY_ACTIVITY,
      ]),
    ).toBeNull();
  });

  it("refuses half a pair", () => {
    expect(validateWeeklyDeadlines({ ...HAMZAH, dropOutDeadlineTime: null }, [FRIDAY_ACTIVITY])).toBe("incomplete");
    expect(validateWeeklyDeadlines({ ...HAMZAH, listPublishDay: null }, [FRIDAY_ACTIVITY])).toBe("incomplete");
  });

  it("refuses a malformed day or time", () => {
    expect(validateWeeklyDeadlines({ ...HAMZAH, dropOutDeadlineDay: 7 }, [FRIDAY_ACTIVITY])).toBe("bad-value");
    expect(validateWeeklyDeadlines({ ...HAMZAH, dropOutDeadlineTime: "9pm" }, [FRIDAY_ACTIVITY])).toBe("bad-value");
    expect(validateWeeklyDeadlines({ ...HAMZAH, listPublishTime: "24:00" }, [FRIDAY_ACTIVITY])).toBe("bad-value");
  });

  it("refuses times outside 08:00 to 21:30", () => {
    expect(validateWeeklyDeadlines({ ...HAMZAH, dropOutDeadlineTime: "07:59" }, [FRIDAY_ACTIVITY])).toBe(
      "outside-hours",
    );
    expect(validateWeeklyDeadlines({ ...HAMZAH, listPublishTime: "21:31" }, [FRIDAY_ACTIVITY])).toBe("outside-hours");
    expect(
      validateWeeklyDeadlines({ ...HAMZAH, dropOutDeadlineTime: "08:00", listPublishTime: "21:30" }, [FRIDAY_ACTIVITY]),
    ).toBeNull();
  });

  it("refuses a drop-out deadline at or after the list publish time", () => {
    expect(
      validateWeeklyDeadlines({ ...HAMZAH, dropOutDeadlineDay: 3, dropOutDeadlineTime: "21:00" }, [FRIDAY_ACTIVITY]),
    ).toBe("order");
    expect(
      validateWeeklyDeadlines({ ...HAMZAH, dropOutDeadlineDay: 2, dropOutDeadlineTime: "20:00" }, [FRIDAY_ACTIVITY]),
    ).toBe("order");
  });

  it("refuses a time on match day at or after kickoff (it would fall in the week before)", () => {
    expect(
      validateWeeklyDeadlines({ ...NO_WEEKLY_DEADLINES, listPublishDay: 5, listPublishTime: "21:00" }, [
        FRIDAY_ACTIVITY,
      ]),
    ).toBe("after-kickoff");
    expect(
      validateWeeklyDeadlines({ ...NO_WEEKLY_DEADLINES, dropOutDeadlineDay: 5, dropOutDeadlineTime: "20:30" }, [
        FRIDAY_ACTIVITY,
      ]),
    ).toBe("after-kickoff");
    expect(
      validateWeeklyDeadlines({ ...NO_WEEKLY_DEADLINES, dropOutDeadlineDay: 5, dropOutDeadlineTime: "12:00" }, [
        FRIDAY_ACTIVITY,
      ]),
    ).toBeNull();
  });

  it("checks every active activity of the club", () => {
    expect(validateWeeklyDeadlines(HAMZAH, [FRIDAY_ACTIVITY, { dayOfWeek: 2, time: "19:00" }])).toBe("after-kickoff");
  });

  it("order is judged per activity: a Monday and Tuesday pair can wrap across a Tuesday match", () => {
    // Tuesday 21:30 match: Mon 21:00 then Tue 20:00, fine.
    expect(validateWeeklyDeadlines(HAMZAH, [{ dayOfWeek: 2, time: "21:30" }])).toBeNull();
    // Wednesday 21:00 match, drop-out Thu 10:00 (6 days before) and
    // publish Tue 20:00 (the day before): fine.
    expect(
      validateWeeklyDeadlines({ ...HAMZAH, dropOutDeadlineDay: 4, dropOutDeadlineTime: "10:00" }, [
        { dayOfWeek: 3, time: "21:00" },
      ]),
    ).toBeNull();
    // Same pair against a Friday match: Thu 10:00 is after Tue 20:00.
    expect(
      validateWeeklyDeadlines({ ...HAMZAH, dropOutDeadlineDay: 4, dropOutDeadlineTime: "10:00" }, [FRIDAY_ACTIVITY]),
    ).toBe("order");
  });
});
