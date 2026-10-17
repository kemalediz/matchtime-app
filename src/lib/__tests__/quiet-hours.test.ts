/**
 * QUIET HOURS, a club setting (owner decision, Kemal, 2026-10-16).
 *
 * The shared message hours (09:00 to 22:59 London) become a club's own
 * choice: on or off, and From and To times, London. The default for every
 * club is ON, 23:00 to 09:00, which is exactly the window before the
 * setting existed. Off: nothing a club sends is held.
 *
 * `message-hours.ts` stays the ONE definition: `inMessageHours` and
 * `messageHoursSendAfter` take the club's quiet hours, and without them
 * mean the default.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUIET_HOURS,
  MESSAGE_HOURS_FROM_TIME,
  QUIET_HOURS_DEFAULT_FROM,
  inMessageHours,
  inQuietHours,
  messageHoursDayStart,
  messageHoursSendAfter,
  normaliseQuietTime,
  quietHoursOf,
  validateQuietHours,
  type QuietHours,
} from "../message-hours";

const at = (iso: string) => new Date(iso);
const OFF: QuietHours = { enabled: false, from: QUIET_HOURS_DEFAULT_FROM, to: MESSAGE_HOURS_FROM_TIME };
const EARLY: QuietHours = { enabled: true, from: "21:00", to: "10:30" };
const DAYTIME: QuietHours = { enabled: true, from: "01:00", to: "07:00" };

describe("the default", () => {
  it("is ON, 23:00 to 09:00: the window before the setting existed", () => {
    expect(DEFAULT_QUIET_HOURS).toEqual({ enabled: true, from: "23:00", to: "09:00" });
    expect(QUIET_HOURS_DEFAULT_FROM).toBe("23:00");
  });

  it("matches the old window minute for minute across a whole winter and summer day", () => {
    for (const day of ["2026-12-01", "2026-07-01", "2026-03-29", "2026-10-25"]) {
      const start = at(`${day}T00:00:00Z`).getTime();
      for (let t = start - 2 * 3600_000; t < start + 26 * 3600_000; t += 15 * 60_000) {
        const now = new Date(t);
        const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hourCycle: "h23" }).format(now));
        const old = h >= 9 && h < 23;
        expect(inMessageHours(now, DEFAULT_QUIET_HOURS)).toBe(old);
        expect(inMessageHours(now)).toBe(old);
        expect(messageHoursSendAfter(now, DEFAULT_QUIET_HOURS)).toEqual(messageHoursSendAfter(now));
      }
    }
  });
});

describe("off: nothing is held", () => {
  it("every minute is inside the message hours, and nothing waits", () => {
    for (const iso of ["2026-12-01T23:30:00Z", "2026-12-02T03:00:00Z", "2026-07-01T22:30:00Z", "2026-12-01T12:00:00Z"]) {
      expect(inMessageHours(at(iso), OFF)).toBe(true);
      expect(inQuietHours(at(iso), OFF)).toBe(false);
      expect(messageHoursSendAfter(at(iso), OFF)).toBeNull();
    }
  });
});

describe("a club's own times", () => {
  it("21:00 to 10:30 (winter, London is UTC)", () => {
    expect(inMessageHours(at("2026-12-01T20:59:00Z"), EARLY)).toBe(true);
    expect(inMessageHours(at("2026-12-01T21:00:00Z"), EARLY)).toBe(false);
    expect(messageHoursSendAfter(at("2026-12-01T21:00:00Z"), EARLY)?.toISOString()).toBe("2026-12-02T10:30:00.000Z");
    expect(messageHoursSendAfter(at("2026-12-02T03:00:00Z"), EARLY)?.toISOString()).toBe("2026-12-02T10:30:00.000Z");
    expect(inMessageHours(at("2026-12-02T10:29:00Z"), EARLY)).toBe(false);
    expect(inMessageHours(at("2026-12-02T10:30:00Z"), EARLY)).toBe(true);
    expect(messageHoursSendAfter(at("2026-12-02T10:30:00Z"), EARLY)).toBeNull();
  });

  it("21:00 to 10:30 in summer (London is UTC+1)", () => {
    expect(inMessageHours(at("2026-07-01T19:59:00Z"), EARLY)).toBe(true);
    expect(inMessageHours(at("2026-07-01T20:00:00Z"), EARLY)).toBe(false);
    expect(messageHoursSendAfter(at("2026-07-01T20:00:00Z"), EARLY)?.toISOString()).toBe("2026-07-02T09:30:00.000Z");
  });

  it("a window that does not cross midnight, 01:00 to 07:00", () => {
    expect(inMessageHours(at("2026-12-01T00:59:00Z"), DAYTIME)).toBe(true);
    expect(inMessageHours(at("2026-12-01T01:00:00Z"), DAYTIME)).toBe(false);
    expect(messageHoursSendAfter(at("2026-12-01T04:00:00Z"), DAYTIME)?.toISOString()).toBe("2026-12-01T07:00:00.000Z");
    expect(inMessageHours(at("2026-12-01T23:30:00Z"), DAYTIME)).toBe(true);
  });

  it("the next day is a London calendar day on the autumn clock change (25 hours)", () => {
    // Sat 24 Oct 2026 23:30 BST is 22:30 UTC; Sunday 25 Oct is GMT.
    expect(messageHoursSendAfter(at("2026-10-24T22:30:00Z"), DEFAULT_QUIET_HOURS)?.toISOString()).toBe("2026-10-25T09:00:00.000Z");
    expect(messageHoursSendAfter(at("2026-10-24T22:30:00Z"), EARLY)?.toISOString()).toBe("2026-10-25T10:30:00.000Z");
  });

  it("and on the spring clock change (23 hours)", () => {
    // Sat 28 Mar 2026 23:30 GMT; Sunday 29 Mar is BST.
    expect(messageHoursSendAfter(at("2026-03-28T23:30:00Z"), EARLY)?.toISOString()).toBe("2026-03-29T09:30:00.000Z");
  });
});

describe("the club's day start (when a post tied to the morning may go)", () => {
  it("is when quiet hours end, or 09:00 with quiet hours off", () => {
    expect(messageHoursDayStart(DEFAULT_QUIET_HOURS)).toBe("09:00");
    expect(messageHoursDayStart(EARLY)).toBe("10:30");
    expect(messageHoursDayStart(OFF)).toBe("09:00");
    expect(messageHoursDayStart()).toBe("09:00");
  });
});

describe("reading the Organisation row", () => {
  it("absent columns, a missing row or bad values mean the default", () => {
    expect(quietHoursOf(null)).toEqual(DEFAULT_QUIET_HOURS);
    expect(quietHoursOf(undefined)).toEqual(DEFAULT_QUIET_HOURS);
    expect(quietHoursOf({})).toEqual(DEFAULT_QUIET_HOURS);
    expect(quietHoursOf({ quietHoursEnabled: true, quietHoursFrom: "25:00", quietHoursTo: "09:00" })).toEqual(DEFAULT_QUIET_HOURS);
    // The same time twice is no window at all: the default, never "always quiet".
    expect(quietHoursOf({ quietHoursEnabled: true, quietHoursFrom: "10:00", quietHoursTo: "10:00" })).toEqual(DEFAULT_QUIET_HOURS);
  });

  it("reads the club's own values", () => {
    expect(quietHoursOf({ quietHoursEnabled: false, quietHoursFrom: "23:00", quietHoursTo: "09:00" })).toEqual(OFF);
    expect(quietHoursOf({ quietHoursEnabled: true, quietHoursFrom: "21:00", quietHoursTo: "10:30" })).toEqual(EARLY);
    expect(quietHoursOf({ quietHoursEnabled: true, quietHoursFrom: "9:05", quietHoursTo: "7:00" })).toEqual({ enabled: true, from: "09:05", to: "07:00" });
  });
});

describe("normaliseQuietTime and validateQuietHours", () => {
  it("accepts HH:MM in 24 hours, padding a one digit hour", () => {
    expect(normaliseQuietTime("09:00")).toBe("09:00");
    expect(normaliseQuietTime("7:30")).toBe("07:30");
    expect(normaliseQuietTime(" 23:59 ")).toBe("23:59");
    for (const bad of ["24:00", "12:60", "noon", "", null, undefined, 9, "1230"]) expect(normaliseQuietTime(bad)).toBeNull();
  });

  it("off needs no times; on needs two different valid times", () => {
    expect(validateQuietHours({ enabled: false })).toEqual({ ok: true, value: { enabled: false } });
    expect(validateQuietHours({ enabled: true, from: "22:00", to: "8:00" })).toEqual({ ok: true, value: { enabled: true, from: "22:00", to: "08:00" } });
    expect(validateQuietHours({ enabled: true, from: "22:00", to: "22:00" })).toEqual({ ok: false, error: "same-time" });
    expect(validateQuietHours({ enabled: true, from: "nope", to: "08:00" })).toEqual({ ok: false, error: "bad-time" });
    expect(validateQuietHours({ enabled: "yes" as unknown as boolean })).toEqual({ ok: false, error: "bad-time" });
  });
});
