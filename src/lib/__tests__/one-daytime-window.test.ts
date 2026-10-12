/**
 * ONE DAYTIME WINDOW (owner decision, 2026-10-13).
 *
 * Every gate that used to send only between 08:00 and 22:00 London now
 * sends between 09:00 (inclusive) and 23:00 (exclusive), the window of
 * `message-hours.ts`. Each moved gate is run here over the same edges:
 * 08:59, 09:00, 22:59 and 23:00, in winter and in summer, and on both
 * clock change days.
 *
 * The gates behind a database import (the owner's DM, the AI cap notice)
 * are pinned on the same edges in their own files, owner-dm.test.ts and
 * ai-cap-notice.test.ts.
 */
import { describe, expect, it } from "vitest";
import { inMessageHours, messageHoursSendAfter, MESSAGE_HOURS_FROM_TIME } from "../message-hours";
import { isAdminGroupPostHour } from "../admin-channel-rules";
import { t } from "../i18n/t";
import { decideSignupListPost, isDaytime, listOpenDue } from "../month-signup-rules";
import { monthCloseDue } from "../month-close-rules";
import { claimsDigestDue, duePaymentReminder, groupReminderDue } from "../month-payment-rules";
import { decideListPost } from "../monthly-week-rules";
import { decidePickRound, isPickHour } from "../organiser-pick-rules";
import { isSociableChaseHour } from "../recruit-chase";
import { adminNoticeSendAfter } from "../rolling-squad-rules";
import {
  NO_WEEKLY_DEADLINES,
  SETTING_EARLIEST,
  SETTING_LATEST,
  deadlineSummaryDue,
  dropOutReminderAt,
  listPublishDue,
  validateWeeklyDeadlines,
} from "../weekly-deadlines";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (iso: string) => new Date(iso);

/** [label, instant, inside the window?, the next 09:00 London when outside] */
const EDGES: Array<[string, string, boolean, string | null]> = [
  // Winter: London is UTC.
  ["winter 08:59", "2026-12-01T08:59:00Z", false, "2026-12-01T09:00:00.000Z"],
  ["winter 09:00", "2026-12-01T09:00:00Z", true, null],
  ["winter 22:59", "2026-12-01T22:59:00Z", true, null],
  ["winter 23:00", "2026-12-01T23:00:00Z", false, "2026-12-02T09:00:00.000Z"],
  ["winter 08:00 (inside the old window)", "2026-12-01T08:00:00Z", false, "2026-12-01T09:00:00.000Z"],
  ["winter 22:00 (outside the old window)", "2026-12-01T22:00:00Z", true, null],
  // Summer: London is UTC+1.
  ["summer 08:59", "2026-07-01T07:59:00Z", false, "2026-07-01T08:00:00.000Z"],
  ["summer 09:00", "2026-07-01T08:00:00Z", true, null],
  ["summer 22:59", "2026-07-01T21:59:00Z", true, null],
  ["summer 23:00", "2026-07-01T22:00:00Z", false, "2026-07-02T08:00:00.000Z"],
  // Sun 29 Mar 2026: 01:00 to 01:59 London does not exist.
  ["spring change, Saturday 23:30 GMT", "2026-03-28T23:30:00Z", false, "2026-03-29T08:00:00.000Z"],
  ["spring change, 00:59 GMT, the last minute before the missing hour", "2026-03-29T00:59:00Z", false, "2026-03-29T08:00:00.000Z"],
  ["spring change, 02:00 BST, the first minute after it", "2026-03-29T01:00:00Z", false, "2026-03-29T08:00:00.000Z"],
  ["spring change, 08:59 BST", "2026-03-29T07:59:00Z", false, "2026-03-29T08:00:00.000Z"],
  ["spring change, 09:00 BST", "2026-03-29T08:00:00Z", true, null],
  ["spring change, 22:59 BST", "2026-03-29T21:59:00Z", true, null],
  ["spring change, 23:00 BST", "2026-03-29T22:00:00Z", false, "2026-03-30T08:00:00.000Z"],
  // Sun 25 Oct 2026: 01:00 to 01:59 London happens twice.
  ["autumn change, Saturday 23:30 BST", "2026-10-24T22:30:00Z", false, "2026-10-25T09:00:00.000Z"],
  ["autumn change, 01:30 the first time (BST)", "2026-10-25T00:30:00Z", false, "2026-10-25T09:00:00.000Z"],
  ["autumn change, 01:30 the second time (GMT)", "2026-10-25T01:30:00Z", false, "2026-10-25T09:00:00.000Z"],
  ["autumn change, 08:59 GMT", "2026-10-25T08:59:00Z", false, "2026-10-25T09:00:00.000Z"],
  ["autumn change, 09:00 GMT", "2026-10-25T09:00:00Z", true, null],
  ["autumn change, 22:59 GMT", "2026-10-25T22:59:00Z", true, null],
  ["autumn change, 23:00 GMT", "2026-10-25T23:00:00Z", false, "2026-10-26T09:00:00.000Z"],
];

/** Every yes/no gate, each made to depend on the hour alone. */
const GATES: Array<[string, (now: Date) => boolean]> = [
  ["message-hours: inMessageHours", inMessageHours],
  ["admin-channel-rules: isAdminGroupPostHour (admin group posts)", isAdminGroupPostHour],
  ["month-signup-rules: isDaytime (monthly squad posts and DMs)", isDaytime],
  ["organiser-pick-rules: isPickHour (pick messages)", isPickHour],
  ["recruit-chase: isSociableChaseHour (chase DMs)", isSociableChaseHour],
  [
    "weekly-deadlines: deadlineSummaryDue (the organisers' summary)",
    (now) => deadlineSummaryDue(now, new Date(now.getTime() - HOUR), new Date(now.getTime() + 2 * DAY)),
  ],
  [
    "weekly-deadlines: listPublishDue (the final list)",
    (now) => listPublishDue(now, new Date(now.getTime() - HOUR), new Date(now.getTime() + 2 * DAY)),
  ],
  [
    "monthly-week-rules: decideListPost (a changed list)",
    (now) =>
      decideListPost({
        now,
        matchDate: new Date(now.getTime() + 3 * DAY),
        hash: "new",
        lastShownHash: "old",
        lastPostAt: null,
        live: true,
        nextUpcoming: true,
        teamsOut: false,
      }) === "change",
  ],
  [
    "month-signup-rules: decideSignupListPost (the sign-up list)",
    (now) =>
      decideSignupListPost({ now, open: true, endsAt: new Date(now.getTime() + 3 * DAY), hash: "new", lastShownHash: null, lastPostAt: null }),
  ],
  [
    "month-signup-rules: listOpenDue (opening the month's list)",
    (now) => listOpenDue({ now, opensAt: new Date(now.getTime() - DAY), firstKickoff: new Date(now.getTime() + 3 * DAY) }),
  ],
  ["month-close-rules: monthCloseDue (the month's close)", (now) => monthCloseDue({ now, lastKickoff: new Date(now.getTime() - 3 * DAY) })],
  [
    "month-payment-rules: duePaymentReminder (the first payment DM)",
    (now) => duePaymentReminder({ now, payByAt: new Date(now.getTime() + 12 * HOUR), sent: { r1At: null, r2At: null, lateDays: [] } }) === "r1",
  ],
  [
    "month-payment-rules: groupReminderDue (the group's count)",
    (now) => groupReminderDue({ now, payByAt: new Date(now.getTime() + 12 * HOUR), sent: false, unpaid: 3 }),
  ],
  [
    "organiser-pick-rules: decidePickRound (a pick round opens)",
    (now) =>
      decidePickRound({
        now,
        kickoff: new Date(now.getTime() + 2 * DAY),
        openPlaces: 1,
        waitingUserIds: ["u1"],
        dropOutDeadline: null,
        openOffers: 0,
        openRound: null,
        lastClosedRound: null,
        dropsSince: 0,
      }).action !== "wait",
  ],
];

describe("every 08:00 to 22:00 gate now opens 09:00 to 23:00 London", () => {
  for (const [name, gate] of GATES) {
    describe(name, () => {
      for (const [label, iso, inside] of EDGES) {
        it(`${label}: ${inside ? "sends" : "holds"}`, () => {
          expect(gate(at(iso))).toBe(inside);
        });
      }
    });
  }
});

describe("rolling-squad-rules: adminNoticeSendAfter holds a notice for the next 09:00 London", () => {
  for (const [label, iso, , next] of EDGES) {
    it(`${label}: ${next ?? "at once"}`, () => {
      expect(adminNoticeSendAfter(at(iso))?.toISOString() ?? null).toBe(next);
      expect(messageHoursSendAfter(at(iso))?.toISOString() ?? null).toBe(next);
    });
  }
});

describe("month-payment-rules: the collector's digest still starts at 10:00, and now runs to 22:59", () => {
  const due = (iso: string) => claimsDigestDue({ now: at(iso), sentToday: false, waiting: 1 });
  it("09:59 no, 10:00 yes, 22:59 yes, 23:00 no (winter)", () => {
    expect(due("2026-12-01T09:59:00Z")).toBe(false);
    expect(due("2026-12-01T10:00:00Z")).toBe(true);
    expect(due("2026-12-01T22:59:00Z")).toBe(true);
    expect(due("2026-12-01T23:00:00Z")).toBe(false);
  });
});

describe("monthly-week-rules: the match morning post is 09:00 to 11:59 London", () => {
  // Tue 1 Dec 2026, kickoff 20:00 London (GMT). The group has seen this list.
  const MATCH = at("2026-12-01T20:00:00Z");
  const morning = (iso: string, over: Partial<Parameters<typeof decideListPost>[0]> = {}) =>
    decideListPost({
      now: at(iso),
      matchDate: MATCH,
      hash: "same",
      lastShownHash: "same",
      lastPostAt: null,
      live: true,
      nextUpcoming: true,
      teamsOut: false,
      ...over,
    });

  it("08:00 and 08:59: held (it used to post from 08:00)", () => {
    expect(morning("2026-12-01T08:00:00Z")).toBeNull();
    expect(morning("2026-12-01T08:59:00Z")).toBeNull();
  });

  it("09:00 to 11:59: posts once", () => {
    expect(morning("2026-12-01T09:00:00Z")).toBe("morning");
    expect(morning("2026-12-01T11:59:00Z")).toBe("morning");
  });

  it("12:00: the morning is over", () => {
    expect(morning("2026-12-01T12:00:00Z")).toBeNull();
  });

  it("a list posted at 09:05 that morning is the morning post: no second one", () => {
    expect(morning("2026-12-01T10:00:00Z", { lastPostAt: at("2026-12-01T09:05:00Z") })).toBeNull();
  });

  it("a list posted the evening before does not count as this morning's", () => {
    expect(morning("2026-12-01T09:00:00Z", { lastPostAt: at("2026-11-30T22:30:00Z") })).toBe("morning");
  });

  it("the day before the match: no morning post", () => {
    expect(morning("2026-11-30T09:30:00Z")).toBeNull();
  });

  it("summer: 09:00 BST is 08:00 UTC", () => {
    const summer = at("2026-07-07T19:00:00Z");
    expect(morning("2026-07-07T07:59:00Z", { matchDate: summer })).toBeNull();
    expect(morning("2026-07-07T08:00:00Z", { matchDate: summer })).toBe("morning");
  });
});

describe("weekly-deadlines: the times an organiser may choose are 09:00 to 22:30", () => {
  // A Friday 23:30 fixture, so no time in the range is "after kickoff".
  const LATE_FRIDAY = [{ dayOfWeek: 5, time: "23:30" }];
  const dropOut = (time: string) =>
    validateWeeklyDeadlines({ ...NO_WEEKLY_DEADLINES, dropOutDeadlineDay: 3, dropOutDeadlineTime: time }, LATE_FRIDAY);
  const publish = (time: string) =>
    validateWeeklyDeadlines({ ...NO_WEEKLY_DEADLINES, listPublishDay: 4, listPublishTime: time }, LATE_FRIDAY);

  it("the bounds are the window's start and half an hour before its end", () => {
    expect(SETTING_EARLIEST).toBe(MESSAGE_HOURS_FROM_TIME);
    expect(SETTING_EARLIEST).toBe("09:00");
    expect(SETTING_LATEST).toBe("22:30");
  });

  it("the refusal names the same two times, in English and in Turkish", () => {
    expect(t("en").wd_err_outside_hours).toBe(`Pick a time between ${SETTING_EARLIEST} and ${SETTING_LATEST}.`);
    expect(t("tr").wd_err_outside_hours).toBe(`${SETTING_EARLIEST} ile ${SETTING_LATEST} arasında bir saat seçin.`);
  });

  it("08:00 and 08:59 are refused, 09:00 is accepted", () => {
    expect(dropOut("08:00")).toBe("outside-hours");
    expect(dropOut("08:59")).toBe("outside-hours");
    expect(dropOut("09:00")).toBeNull();
    expect(publish("08:59")).toBe("outside-hours");
    expect(publish("09:00")).toBeNull();
  });

  it("21:31, 22:00 and 22:30 are accepted now, 22:31 and 23:00 are refused", () => {
    expect(dropOut("21:31")).toBeNull();
    expect(dropOut("22:00")).toBeNull();
    expect(dropOut("22:30")).toBeNull();
    expect(dropOut("22:31")).toBe("outside-hours");
    expect(publish("22:30")).toBeNull();
    expect(publish("23:00")).toBe("outside-hours");
  });

  describe("a time saved under the old 08:00 to 21:30 rule keeps working", () => {
    const SAVED = { ...NO_WEEKLY_DEADLINES, dropOutDeadlineDay: 3, dropOutDeadlineTime: "08:00" };

    it("saving the OTHER row is not refused because of it", () => {
      const next = { ...SAVED, listPublishDay: 4, listPublishTime: "20:00" };
      expect(validateWeeklyDeadlines(next, LATE_FRIDAY, SAVED)).toBeNull();
      // Without the saved row to compare with, the same values are refused.
      expect(validateWeeklyDeadlines(next, LATE_FRIDAY)).toBe("outside-hours");
    });

    it("saving it again unchanged is accepted", () => {
      expect(validateWeeklyDeadlines(SAVED, LATE_FRIDAY, SAVED)).toBeNull();
    });

    it("changing its time to another early one is refused", () => {
      expect(validateWeeklyDeadlines({ ...SAVED, dropOutDeadlineTime: "08:30" }, LATE_FRIDAY, SAVED)).toBe("outside-hours");
    });

    it("changing its DAY while keeping the early time is refused", () => {
      expect(validateWeeklyDeadlines({ ...SAVED, dropOutDeadlineDay: 2 }, LATE_FRIDAY, SAVED)).toBe("outside-hours");
    });

    it("the other checks still apply to it (order with the list publish time)", () => {
      const next = { ...SAVED, listPublishDay: 2, listPublishTime: "20:00" };
      expect(validateWeeklyDeadlines(next, LATE_FRIDAY, SAVED)).toBe("order");
    });

    it("it still resolves, and its posts wait for 09:00", () => {
      // Wed 2 Dec 2026 08:00 London deadline, Friday kickoff.
      const deadline = at("2026-12-02T08:00:00Z");
      const kickoff = at("2026-12-04T23:30:00Z");
      expect(deadlineSummaryDue(at("2026-12-02T08:00:00Z"), deadline, kickoff)).toBe(false);
      expect(deadlineSummaryDue(at("2026-12-02T09:00:00Z"), deadline, kickoff)).toBe(true);
      expect(listPublishDue(at("2026-12-02T08:30:00Z"), deadline, kickoff)).toBe(false);
      expect(listPublishDue(at("2026-12-02T09:00:00Z"), deadline, kickoff)).toBe(true);
    });
  });
});

describe("weekly-deadlines: the drop-out reminder, 3 hours before and not before 09:00", () => {
  it("a 22:30 deadline is reminded at 19:30", () => {
    expect(dropOutReminderAt(at("2026-12-02T22:30:00Z"))?.toISOString()).toBe("2026-12-02T19:30:00.000Z");
  });

  it("an 11:00 deadline is reminded at 09:00, the window's start", () => {
    expect(dropOutReminderAt(at("2026-12-02T11:00:00Z"))?.toISOString()).toBe("2026-12-02T09:00:00.000Z");
  });

  it("a 09:00 deadline (the earliest allowed) and a saved 08:00 one get no reminder: under an hour's notice", () => {
    expect(dropOutReminderAt(at("2026-12-02T09:00:00Z"))).toBeNull();
    expect(dropOutReminderAt(at("2026-12-02T08:00:00Z"))).toBeNull();
  });

  it("every reminder for an allowed deadline falls inside the window", () => {
    for (let h = 9; h <= 22; h++) {
      for (const m of ["00", "30"]) {
        const r = dropOutReminderAt(at(`2026-12-02T${String(h).padStart(2, "0")}:${m}:00Z`));
        if (r) expect(inMessageHours(r)).toBe(true);
      }
    }
  });
});
