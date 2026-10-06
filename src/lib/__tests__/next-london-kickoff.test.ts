/**
 * `nextLondonKickoff`: the one place a weekly game (weekday + London
 * "HH:mm") becomes next week's `Match.date`. Called by the nightly
 * generate-matches cron (00:00 UTC) and the admin "Generate match" button.
 *
 * The clock-change weeks are pinned because the maths this was lifted
 * from counted whole 24-hour days from London midnight. Across the
 * autumn change a London day is 25 hours long, so that count stopped at
 * 23:00 the evening BEFORE the target day and the match was created a
 * day early (a Tuesday game on the Monday).
 */
import { describe, it, expect } from "vitest";
import { nextLondonKickoff, formatLondon } from "@/lib/london-time";

const TUESDAY = 2;
const london = (d: Date) => formatLondon(d, "EEE d MMM yyyy HH:mm");

describe("nextLondonKickoff", () => {
  it("summer: the cron at 00:00 UTC on a Tuesday (01:00 London) makes next Tuesday's game", () => {
    const k = nextLondonKickoff(new Date("2026-07-07T00:00:00.000Z"), TUESDAY, "21:30");
    expect(k.toISOString()).toBe("2026-07-14T20:30:00.000Z");
    expect(london(k)).toBe("Tue 14 Jul 2026 21:30");
  });

  it("winter: London wall clock is UTC", () => {
    const k = nextLondonKickoff(new Date("2026-12-01T00:00:00.000Z"), TUESDAY, "21:30");
    expect(k.toISOString()).toBe("2026-12-08T21:30:00.000Z");
  });

  it("the day before the game: tomorrow", () => {
    const k = nextLondonKickoff(new Date("2026-07-06T10:00:00.000Z"), TUESDAY, "20:00");
    expect(london(k)).toBe("Tue 7 Jul 2026 20:00");
  });

  it("the weekday is London's: 23:30 UTC on a Monday in summer is already Tuesday there", () => {
    const k = nextLondonKickoff(new Date("2026-07-06T23:30:00.000Z"), TUESDAY, "20:00");
    expect(london(k)).toBe("Tue 14 Jul 2026 20:00");
  });

  describe("the week the clocks go back (Sunday 25 October 2026)", () => {
    it("the cron on Tuesday 20 October makes TUESDAY 27 October, not Monday 26", () => {
      const k = nextLondonKickoff(new Date("2026-10-20T00:00:00.000Z"), TUESDAY, "21:30");
      expect(london(k)).toBe("Tue 27 Oct 2026 21:30");
      expect(k.toISOString()).toBe("2026-10-27T21:30:00.000Z");
    });

    it("every day of that week gives the same Tuesday", () => {
      for (const day of ["21", "22", "23", "24", "25", "26"]) {
        const k = nextLondonKickoff(new Date(`2026-10-${day}T09:00:00.000Z`), TUESDAY, "21:30");
        expect(london(k), `run on ${day} October`).toBe("Tue 27 Oct 2026 21:30");
      }
    });

    it("a Sunday game on the change day itself", () => {
      const k = nextLondonKickoff(new Date("2026-10-21T09:00:00.000Z"), 0, "10:00");
      expect(london(k)).toBe("Sun 25 Oct 2026 10:00");
    });
  });

  describe("the week the clocks go forward (Sunday 28 March 2027)", () => {
    it("every day of that week gives the right Tuesday, in British Summer Time", () => {
      for (const day of ["23", "24", "25", "26", "27", "28", "29"]) {
        const k = nextLondonKickoff(new Date(`2027-03-${day}T09:00:00.000Z`), TUESDAY, "21:30");
        expect(k.toISOString(), `run on ${day} March`).toBe("2027-03-30T20:30:00.000Z");
      }
    });
  });
});
