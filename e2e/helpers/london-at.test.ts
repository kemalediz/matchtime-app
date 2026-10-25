/**
 * `londonAt(days, h, m)` is "h:m London time, `days` CALENDAR days from
 * London's today". It used to add `days * 24h` of milliseconds to now and
 * read the London date of that, which is a different calendar day whenever
 * the stretch crosses a clock change at the wrong hour. On 2026-10-25 (a
 * 25-hour day) at 00:33 BST, now + 24h is 23:33 GMT on the SAME day, so
 * every `londonAt(1, …)` landed on today: pay-links-quiet-hours expected
 * 09:00 on the 25th where MatchTime rightly said the 26th, and the
 * badges and rate-reminder specs polled one day too early.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { londonAt } from "./constants";

const londonDate = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(d);

afterEach(() => vi.useRealTimers());

describe("londonAt counts calendar days in London, across both clock changes", () => {
  // [label, real now (UTC), expected London date for -1, 0, +1, +2]
  const cases: Array<[string, string, [string, string, string, string]]> = [
    ["25 Oct 00:33 BST (the failing night)", "2026-10-24T23:33:00Z", ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"]],
    ["25 Oct 01:30 BST (first pass)", "2026-10-25T00:30:00Z", ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"]],
    ["25 Oct 01:30 GMT (second pass)", "2026-10-25T01:30:00Z", ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"]],
    ["25 Oct 23:30 GMT", "2026-10-25T23:30:00Z", ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"]],
    ["24 Oct 23:30 BST", "2026-10-24T22:30:00Z", ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]],
    ["29 Mar 00:30 GMT", "2026-03-29T00:30:00Z", ["2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31"]],
    ["29 Mar 03:00 BST (just after the jump)", "2026-03-29T02:00:00Z", ["2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31"]],
    ["29 Mar 23:30 BST", "2026-03-29T22:30:00Z", ["2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31"]],
    ["30 Mar 00:30 BST", "2026-03-29T23:30:00Z", ["2026-03-29", "2026-03-30", "2026-03-31", "2026-04-01"]],
    ["28 Mar 23:30 GMT", "2026-03-28T23:30:00Z", ["2026-03-27", "2026-03-28", "2026-03-29", "2026-03-30"]],
    ["an ordinary noon", "2026-07-15T11:00:00Z", ["2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17"]],
    ["New Year's Eve 23:59", "2026-12-31T23:59:00Z", ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]],
  ];

  it.each(cases)("%s", (_label, now, [yesterday, today, tomorrow, dayAfter]) => {
    vi.useFakeTimers({ now: new Date(now), toFake: ["Date"] });
    expect(londonDate(londonAt(-1, 20, 0))).toBe(yesterday);
    expect(londonDate(londonAt(0, 12, 0))).toBe(today);
    expect(londonDate(londonAt(1, 9, 0))).toBe(tomorrow);
    expect(londonDate(londonAt(2, 18, 30))).toBe(dayAfter);
  });

  it("returns that London wall time on either side of a change", () => {
    vi.useFakeTimers({ now: new Date("2026-10-24T23:33:00Z"), toFake: ["Date"] });
    expect(londonAt(0, 23, 30).toISOString()).toBe("2026-10-25T23:30:00.000Z"); // GMT
    expect(londonAt(1, 9, 0).toISOString()).toBe("2026-10-26T09:00:00.000Z");
    expect(londonAt(-1, 20, 0).toISOString()).toBe("2026-10-24T19:00:00.000Z"); // BST
    vi.setSystemTime(new Date("2026-03-28T23:30:00Z"));
    expect(londonAt(1, 18, 0).toISOString()).toBe("2026-03-29T17:00:00.000Z"); // BST
    expect(londonAt(0, 23, 0).toISOString()).toBe("2026-03-28T23:00:00.000Z"); // GMT
  });
});
