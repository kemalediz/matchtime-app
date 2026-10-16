/**
 * QUIET HOURS, every club gate reads the club's own setting (2026-10-16).
 *
 * Each gate that held a club's message for the shared message hours now
 * takes the club's `QuietHours`. Pinned for each one, at the same instants:
 *   - without the club's hours (or with the default): today's behaviour;
 *   - OFF: never held, at 23:30 or 03:00;
 *   - a club's own window, 21:00 to 10:30: held at 21:30 and at 10:00,
 *     sent at 20:59 and at 10:30.
 * The platform gates (billing, setup DMs, the owner's DMs) are not club
 * messages and keep the default; they are pinned in their own files.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_QUIET_HOURS, type QuietHours } from "../message-hours";
import { isAdminGroupPostHour } from "../admin-channel-rules";
import { adminNoticeSendAfter } from "../rolling-squad-rules";
import { decidePickRound, isPickHour } from "../organiser-pick-rules";
import { isSociableChaseHour, shouldChaseRecruit } from "../recruit-chase";
import { decideSignupListPost, isDaytime, listOpenDue } from "../month-signup-rules";
import { claimsDigestDue, duePaymentReminder, groupReminderDue } from "../month-payment-rules";
import { monthCloseDue } from "../month-close-rules";
import { decideListPost } from "../monthly-week-rules";
import { deadlineSummaryDue, dropOutReminderDue, listPublishDue } from "../weekly-deadlines";
import { seedNudgePrecheck } from "../seed-nudge-rules";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OFF: QuietHours = { ...DEFAULT_QUIET_HOURS, enabled: false };
const EARLY: QuietHours = { enabled: true, from: "21:00", to: "10:30" };

// Winter: London is UTC, so the ISO times read as London.
const AT_2330 = new Date("2026-12-01T23:30:00Z");
const AT_0300 = new Date("2026-12-02T03:00:00Z");
const AT_1000 = new Date("2026-12-02T10:00:00Z");
const AT_1030 = new Date("2026-12-02T10:30:00Z");
const AT_2059 = new Date("2026-12-01T20:59:00Z");
const AT_2130 = new Date("2026-12-01T21:30:00Z");

/** [instant, default allows, OFF allows, EARLY allows] */
const GRID: Array<[string, Date, boolean, boolean, boolean]> = [
  ["23:30", AT_2330, false, true, false],
  ["03:00", AT_0300, false, true, false],
  ["10:00", AT_1000, true, true, false],
  ["10:30", AT_1030, true, true, true],
  ["20:59", AT_2059, true, true, true],
  ["21:30", AT_2130, true, true, false],
];

function grid(name: string, gate: (now: Date, quiet?: QuietHours) => boolean) {
  describe(name, () => {
    for (const [label, now, def, off, early] of GRID) {
      it(`${label}: default ${def}, off ${off}, 21:00 to 10:30 ${early}`, () => {
        expect(gate(now)).toBe(def);
        expect(gate(now, DEFAULT_QUIET_HOURS)).toBe(def);
        expect(gate(now, OFF)).toBe(off);
        expect(gate(now, EARLY)).toBe(early);
      });
    }
  });
}

grid("admin group posts (isAdminGroupPostHour)", (now, q) => isAdminGroupPostHour(now, q));
grid("admin notice hold (adminNoticeSendAfter: null means send now)", (now, q) => adminNoticeSendAfter(now, q) === null);
grid("organiser picks (isPickHour)", (now, q) => isPickHour(now, q));
grid("recruit chases (isSociableChaseHour)", (now, q) => isSociableChaseHour(now, q));
grid("the monthly squad's waking hours (isDaytime)", (now, q) => isDaytime(now, q));

describe("the admin notice is held until the club's quiet hours end", () => {
  it("21:30 with 21:00 to 10:30 waits for 10:30 tomorrow; off sends at once", () => {
    expect(adminNoticeSendAfter(AT_2130, EARLY)?.toISOString()).toBe("2026-12-02T10:30:00.000Z");
    expect(adminNoticeSendAfter(AT_2330, OFF)).toBeNull();
    expect(adminNoticeSendAfter(AT_2330)?.toISOString()).toBe("2026-12-02T09:00:00.000Z");
  });
});

describe("decidePickRound passes the club's quiet hours", () => {
  const base = {
    kickoff: new Date(AT_2330.getTime() + 2 * DAY),
    openPlaces: 1,
    waitingUserIds: ["u1"],
    confirmed: 9,
    pastePending: false,
    dropOutDeadline: null,
    openOffers: 0,
    openRound: null,
    lastClosedRound: null,
    dropsSince: 1,
  };
  it("waits at 23:30 by default, opens at 23:30 with quiet hours off, waits at 21:30 with 21:00 to 10:30", () => {
    expect(decidePickRound({ ...base, now: AT_2330 })).toEqual({ action: "wait", why: "quiet hours" });
    expect(decidePickRound({ ...base, now: AT_2330, quiet: OFF }).action).not.toBe("wait");
    expect(decidePickRound({ ...base, now: AT_2130, quiet: EARLY })).toEqual({ action: "wait", why: "quiet hours" });
  });
});

describe("shouldChaseRecruit passes the club's quiet hours", () => {
  const input = {
    now: AT_2330,
    invitedAt: new Date(AT_2330.getTime() - 2 * DAY),
    hasResponded: false,
    squadShort: true,
    matchLive: true,
    subscribed: true,
    alreadyChased: false,
  };
  it("not at 23:30 by default; yes with quiet hours off", () => {
    expect(shouldChaseRecruit(input)).toBe(false);
    expect(shouldChaseRecruit({ ...input, quiet: OFF })).toBe(true);
  });
});

describe("the monthly squad", () => {
  it("opening the list", () => {
    const p = { now: AT_2330, opensAt: new Date(AT_2330.getTime() - DAY), firstKickoff: new Date(AT_2330.getTime() + 5 * DAY) };
    expect(listOpenDue(p)).toBe(false);
    expect(listOpenDue({ ...p, quiet: OFF })).toBe(true);
  });
  it("the sign-up list post", () => {
    const p = { now: AT_2330, open: true, endsAt: new Date(AT_2330.getTime() + DAY), hash: "a", lastShownHash: null, lastPostAt: null };
    expect(decideSignupListPost(p)).toBe(false);
    expect(decideSignupListPost({ ...p, quiet: OFF })).toBe(true);
    expect(decideSignupListPost({ ...p, now: AT_2130, quiet: EARLY })).toBe(false);
  });
  it("payment DMs, the group count and the collector's digest", () => {
    const payByAt = new Date(AT_2330.getTime() + 12 * HOUR);
    const sent = { r1At: null, r2At: null, lateDays: [] };
    expect(duePaymentReminder({ now: AT_2330, payByAt, sent })).toBeNull();
    expect(duePaymentReminder({ now: AT_2330, payByAt, sent, quiet: OFF })).toBe("r1");
    expect(groupReminderDue({ now: AT_2330, payByAt, sent: false, unpaid: 2 })).toBe(false);
    expect(groupReminderDue({ now: AT_2330, payByAt, sent: false, unpaid: 2, quiet: OFF })).toBe(true);
    expect(claimsDigestDue({ now: AT_2330, sentToday: false, waiting: 1 })).toBe(false);
    expect(claimsDigestDue({ now: AT_2330, sentToday: false, waiting: 1, quiet: OFF })).toBe(true);
    expect(claimsDigestDue({ now: AT_2130, sentToday: false, waiting: 1, quiet: EARLY })).toBe(false);
  });
  it("the month close", () => {
    const lastKickoff = new Date("2026-11-30T20:00:00Z");
    expect(monthCloseDue({ now: AT_2330, lastKickoff })).toBe(false);
    expect(monthCloseDue({ now: AT_2330, lastKickoff, quiet: OFF })).toBe(true);
  });
});

describe("the monthly match list post (decideListPost)", () => {
  const matchDate = new Date("2026-12-02T20:00:00Z");
  const base = { matchDate, hash: "h2", lastShownHash: "h1", lastPostAt: null, live: true, nextUpcoming: true, teamsOut: false };
  it("a changed list: held at 23:30 by default, posted with quiet hours off", () => {
    expect(decideListPost({ ...base, now: AT_2330 })).toBeNull();
    expect(decideListPost({ ...base, now: AT_2330, quiet: OFF })).toBe("change");
    expect(decideListPost({ ...base, now: AT_1000, quiet: EARLY })).toBeNull();
  });
  it("the morning post waits for the club's day start: 10:30 for 21:00 to 10:30, 09:00 with quiet hours off", () => {
    const same = { ...base, hash: "h1", lastPostAt: new Date("2026-12-01T19:00:00Z") };
    expect(decideListPost({ ...same, now: AT_1000, quiet: EARLY })).toBeNull();
    expect(decideListPost({ ...same, now: AT_1030, quiet: EARLY })).toBe("morning");
    // Off: 03:00 is not the morning, and 09:00 is.
    expect(decideListPost({ ...same, now: AT_0300, quiet: OFF })).toBeNull();
    expect(decideListPost({ ...same, now: new Date("2026-12-02T09:00:00Z"), quiet: OFF })).toBe("morning");
  });
});

describe("the weekly deadline posts", () => {
  const kickoff = new Date("2026-12-03T20:00:00Z");
  it("the drop-out summary and the list publish", () => {
    const deadline = new Date("2026-12-01T21:00:00Z");
    expect(deadlineSummaryDue(AT_2330, deadline, kickoff)).toBe(false);
    expect(deadlineSummaryDue(AT_2330, deadline, kickoff, OFF)).toBe(true);
    expect(deadlineSummaryDue(AT_2130, deadline, kickoff, EARLY)).toBe(false);
    expect(listPublishDue(AT_2330, deadline, kickoff)).toBe(false);
    expect(listPublishDue(AT_2330, deadline, kickoff, OFF)).toBe(true);
  });
  it("the drop-out reminder is never sent inside the club's quiet hours", () => {
    // Deadline 22:30: the reminder is due from 19:30.
    const deadline = new Date("2026-12-01T22:30:00Z");
    expect(dropOutReminderDue(AT_2130, deadline)).toBe(true);
    expect(dropOutReminderDue(AT_2130, deadline, EARLY)).toBe(false);
    expect(dropOutReminderDue(AT_2059, deadline, EARLY)).toBe(true);
  });
});

describe("the seed nudge", () => {
  const i = {
    now: AT_2330,
    live: true,
    squadMode: "weekly",
    teamBalancing: true,
    liveAt: new Date("2026-11-20T12:00:00Z"),
    alreadyNudged: false,
    match: { date: new Date(AT_2330.getTime() + 20 * HOUR), status: "UPCOMING" },
  };
  it("outside hours by default at 23:30, due with quiet hours off", () => {
    expect(seedNudgePrecheck(i)).toEqual({ due: false, reason: "outside-hours" });
    expect(seedNudgePrecheck({ ...i, quiet: OFF })).toBeNull();
    expect(seedNudgePrecheck({ ...i, now: AT_2130, quiet: EARLY })).toEqual({ due: false, reason: "outside-hours" });
  });
});
