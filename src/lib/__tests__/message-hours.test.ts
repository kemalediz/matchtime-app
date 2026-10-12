/**
 * The shared daytime window for held messages: 09:00 (inclusive) to 23:00
 * (exclusive) London. A message that arrives outside it waits for the next
 * 09:00 London. Owner decision, 2026-10-12.
 */
import { describe, expect, it } from "vitest";
import {
  MESSAGE_HOURS_FROM_HOUR,
  MESSAGE_HOURS_FROM_TIME,
  MESSAGE_HOURS_TO_HOUR,
  inMessageHours,
  messageHoursSendAfter,
} from "../message-hours";

const at = (iso: string) => new Date(iso);
const after = (iso: string) => messageHoursSendAfter(at(iso))?.toISOString() ?? null;

describe("the one pair of hours", () => {
  it("is 09:00 to 23:00", () => {
    expect(MESSAGE_HOURS_FROM_HOUR).toBe(9);
    expect(MESSAGE_HOURS_TO_HOUR).toBe(23);
    expect(MESSAGE_HOURS_FROM_TIME).toBe("09:00");
  });
});

describe("the edges, winter (GMT, London is UTC)", () => {
  it("08:59 is outside and waits for 09:00 the same day", () => {
    expect(inMessageHours(at("2026-12-01T08:59:00Z"))).toBe(false);
    expect(after("2026-12-01T08:59:00Z")).toBe("2026-12-01T09:00:00.000Z");
    expect(after("2026-12-01T08:59:59.999Z")).toBe("2026-12-01T09:00:00.000Z");
  });

  it("09:00 is inside: send at once", () => {
    expect(inMessageHours(at("2026-12-01T09:00:00Z"))).toBe(true);
    expect(after("2026-12-01T09:00:00Z")).toBeNull();
  });

  it("22:59 is inside: send at once", () => {
    expect(inMessageHours(at("2026-12-01T22:59:00Z"))).toBe(true);
    expect(after("2026-12-01T22:59:59.999Z")).toBeNull();
  });

  it("23:00 is outside and waits for 09:00 the next day", () => {
    expect(inMessageHours(at("2026-12-01T23:00:00Z"))).toBe(false);
    expect(after("2026-12-01T23:00:00Z")).toBe("2026-12-02T09:00:00.000Z");
    expect(after("2026-12-01T23:59:59Z")).toBe("2026-12-02T09:00:00.000Z");
  });

  it("midnight is outside and waits for 09:00 that same new day", () => {
    expect(inMessageHours(at("2026-12-02T00:00:00Z"))).toBe(false);
    expect(after("2026-12-02T00:00:00Z")).toBe("2026-12-02T09:00:00.000Z");
  });

  it("the old window's edges are now inside (09:30, 20:00, 21:30)", () => {
    for (const iso of ["2026-12-01T09:30:00Z", "2026-12-01T20:00:00Z", "2026-12-01T21:30:00Z"]) {
      expect(inMessageHours(at(iso))).toBe(true);
      expect(after(iso)).toBeNull();
    }
  });
});

describe("the edges, summer (BST, London is UTC+1)", () => {
  it("08:59 London (07:59 UTC) waits for 09:00 London (08:00 UTC)", () => {
    expect(inMessageHours(at("2026-07-01T07:59:00Z"))).toBe(false);
    expect(after("2026-07-01T07:59:00Z")).toBe("2026-07-01T08:00:00.000Z");
  });

  it("09:00 and 22:59 London are inside", () => {
    expect(after("2026-07-01T08:00:00Z")).toBeNull();
    expect(after("2026-07-01T21:59:00Z")).toBeNull();
  });

  it("23:00 London (22:00 UTC) waits for 09:00 London the next day", () => {
    expect(inMessageHours(at("2026-07-01T22:00:00Z"))).toBe(false);
    expect(after("2026-07-01T22:00:00Z")).toBe("2026-07-02T08:00:00.000Z");
  });

  it("midnight London (23:00 UTC the day before) waits for 09:00 London that day", () => {
    expect(after("2026-06-30T23:00:00Z")).toBe("2026-07-01T08:00:00.000Z");
  });
});

describe("the spring clock change, Sun 29 Mar 2026 (01:00 to 01:59 London does not exist)", () => {
  it("Saturday 23:30 GMT waits for Sunday 09:00 BST", () => {
    expect(after("2026-03-28T23:30:00Z")).toBe("2026-03-29T08:00:00.000Z");
  });

  it("the last second before the missing hour (00:59:59 GMT) waits for 09:00 BST", () => {
    expect(after("2026-03-29T00:59:59Z")).toBe("2026-03-29T08:00:00.000Z");
  });

  it("the first instant after it (02:00 BST) waits for 09:00 BST", () => {
    expect(after("2026-03-29T01:00:00Z")).toBe("2026-03-29T08:00:00.000Z");
  });

  it("that day's window is 09:00 to 23:00 BST, 23 hours after the Saturday's 09:00", () => {
    expect(inMessageHours(at("2026-03-29T07:59:00Z"))).toBe(false);
    expect(inMessageHours(at("2026-03-29T08:00:00Z"))).toBe(true);
    expect(inMessageHours(at("2026-03-29T21:59:00Z"))).toBe(true);
    expect(inMessageHours(at("2026-03-29T22:00:00Z"))).toBe(false);
    expect(after("2026-03-29T22:00:00Z")).toBe("2026-03-30T08:00:00.000Z");
  });
});

describe("the autumn clock change, Sun 25 Oct 2026 (01:00 to 01:59 London happens twice)", () => {
  it("Saturday 23:30 BST waits for Sunday 09:00 GMT", () => {
    expect(after("2026-10-24T22:30:00Z")).toBe("2026-10-25T09:00:00.000Z");
  });

  it("01:30 the first time (BST) waits for 09:00 GMT", () => {
    expect(after("2026-10-25T00:30:00Z")).toBe("2026-10-25T09:00:00.000Z");
  });

  it("01:30 the second time (GMT) waits for the same 09:00 GMT", () => {
    expect(after("2026-10-25T01:30:00Z")).toBe("2026-10-25T09:00:00.000Z");
  });

  it("that day's window is 09:00 to 23:00 GMT (08:00 UTC is still 08:00 London)", () => {
    expect(inMessageHours(at("2026-10-25T08:00:00Z"))).toBe(false);
    expect(after("2026-10-25T08:00:00Z")).toBe("2026-10-25T09:00:00.000Z");
    expect(inMessageHours(at("2026-10-25T09:00:00Z"))).toBe(true);
    expect(inMessageHours(at("2026-10-25T22:59:00Z"))).toBe(true);
    expect(after("2026-10-25T23:00:00Z")).toBe("2026-10-26T09:00:00.000Z");
  });
});

describe("23:30 on the last day of a month rolls into the next month", () => {
  it("31 October (GMT) to 1 November", () => {
    expect(after("2026-10-31T23:30:00Z")).toBe("2026-11-01T09:00:00.000Z");
  });

  it("31 July (BST) to 1 August", () => {
    expect(after("2026-07-31T22:30:00Z")).toBe("2026-08-01T08:00:00.000Z");
  });

  it("31 December to 1 January of the next year", () => {
    expect(after("2026-12-31T23:30:00Z")).toBe("2027-01-01T09:00:00.000Z");
  });

  it("28 February to 1 March, and 29 February in a leap year", () => {
    expect(after("2027-02-28T23:30:00Z")).toBe("2027-03-01T09:00:00.000Z");
    expect(after("2028-02-28T23:30:00Z")).toBe("2028-02-29T09:00:00.000Z");
    expect(after("2028-02-29T23:30:00Z")).toBe("2028-03-01T09:00:00.000Z");
  });
});

describe("the wait is never longer than the night", () => {
  it("every quarter hour of a year: null inside, else a 09:00 London at most 11 hours away", () => {
    const start = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 366 * 96; i++) {
      const now = new Date(start + i * 15 * 60_000);
      const send = messageHoursSendAfter(now);
      if (inMessageHours(now)) {
        expect(send).toBeNull();
        continue;
      }
      expect(send).not.toBeNull();
      const wait = send!.getTime() - now.getTime();
      expect(wait).toBeGreaterThan(0);
      // 23:00 to 09:00 is 10 hours, 11 on the night the clocks go back.
      expect(wait).toBeLessThanOrEqual(11 * 60 * 60_000);
      expect(inMessageHours(send!)).toBe(true);
      expect(inMessageHours(new Date(send!.getTime() - 1))).toBe(false);
    }
    // 35,000 instants, each a few time zone conversions: seconds when the
    // whole suite runs beside it, so it gets room.
  }, 60_000);
});
