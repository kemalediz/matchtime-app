/**
 * `londonDayStart`: 00:00 London on the day an instant falls on, the one
 * "today" of the club's next match (club summary, slice B4, decision K5).
 */
import { describe, it, expect } from "vitest";
import { londonDayStart } from "@/lib/london-time";
import { londonMidnight } from "@/lib/club-connect-rules";

describe("londonDayStart", () => {
  it("in BST it is 23:00 UTC the evening before", () => {
    expect(londonDayStart(new Date("2026-07-15T10:00:00.000Z")).toISOString()).toBe("2026-07-14T23:00:00.000Z");
  });

  it("00:30 BST belongs to the new London day, though UTC is still on the old one", () => {
    expect(londonDayStart(new Date("2026-07-14T23:30:00.000Z")).toISOString()).toBe("2026-07-14T23:00:00.000Z");
  });

  it("in GMT it is UTC midnight", () => {
    expect(londonDayStart(new Date("2026-11-11T00:30:00.000Z")).toISOString()).toBe("2026-11-11T00:00:00.000Z");
  });

  it("on the clock-change days: the day starts at London midnight either side", () => {
    // Sun 29 Mar 2026: clocks go forward at 01:00 GMT; midnight is GMT.
    expect(londonDayStart(new Date("2026-03-29T12:00:00.000Z")).toISOString()).toBe("2026-03-29T00:00:00.000Z");
    // Sun 25 Oct 2026: clocks go back at 02:00 BST; midnight is BST.
    expect(londonDayStart(new Date("2026-10-25T12:00:00.000Z")).toISOString()).toBe("2026-10-24T23:00:00.000Z");
  });

  it("is the same rule as the caps' London midnight (one definition)", () => {
    for (const iso of ["2026-07-14T23:30:00.000Z", "2026-11-11T00:30:00.000Z", "2026-10-25T00:30:00.000Z"]) {
      expect(londonMidnight(new Date(iso)).toISOString()).toBe(londonDayStart(new Date(iso)).toISOString());
    }
  });
});
