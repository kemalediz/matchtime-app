/**
 * The inactivity rule itself, in isolation.
 *
 * Kemal, 2026-09-15, verbatim: "drop inactive players from the table
 * after three months, leave the balancer alone."
 *
 * These tests pin the three things that decision turns on: where the
 * boundary sits, that crossing back over it restores the player's REAL
 * number rather than a reconstructed one, and that the window is
 * measured from today rather than from the club's last fixture.
 */
import { describe, it, expect } from "vitest";
import {
  RANKED_TABLE_INACTIVE_AFTER_MONTHS,
  RANKED_TABLE_COUNTS_BENCH_AS_PLAYED,
  ATTENDANCE_TABLE_FOLLOWS_ACTIVITY_RULE,
  TEAM_OF_SEASON_FOLLOWS_ACTIVITY_RULE,
  VIEWER_IS_EXEMPT_ON_OWN_STATS_PAGE,
  rankedTableCutoff,
  buildRankedRoster,
} from "@/lib/ranked-table-activity";

/** A fixed "today" so the tests never drift with the wall clock. */
const NOW = new Date("2026-09-15T12:00:00.000Z");

describe("RANKED_TABLE_INACTIVE_AFTER_MONTHS", () => {
  it("is three months, the figure Kemal chose", () => {
    expect(RANKED_TABLE_INACTIVE_AFTER_MONTHS).toBe(3);
  });

  it("is at least double Sutton's real 1.5-month summer break", () => {
    // The whole reason the number is 3 and not 2: the club breaks for
    // about six weeks, and a returning player must not have been
    // deleted from the table while the club itself was not playing.
    expect(RANKED_TABLE_INACTIVE_AFTER_MONTHS).toBeGreaterThanOrEqual(3);
  });
});

describe("rankedTableCutoff", () => {
  it("is exactly three calendar months before now", () => {
    expect(rankedTableCutoff(NOW).toISOString()).toBe("2026-06-15T12:00:00.000Z");
  });

  it("does not mutate the date it is handed", () => {
    const before = NOW.toISOString();
    rankedTableCutoff(NOW);
    expect(NOW.toISOString()).toBe(before);
  });
});

describe("the boundary", () => {
  /** 15 Jun 2026 is the cutoff for a 15 Sep 2026 "now". */
  const threeMonthsLessADay = new Date("2026-06-16T12:00:00.000Z");
  const threeMonthsAndADay = new Date("2026-06-14T12:00:00.000Z");

  it("keeps a player whose last match is three months less a day ago", () => {
    const roster = buildRankedRoster(new Map([["p1", threeMonthsLessADay]]), NOW);
    expect(roster.isRanked("p1")).toBe(true);
    expect(roster.hiddenUserIds).toEqual([]);
  });

  it("drops a player whose last match is three months and a day ago", () => {
    const roster = buildRankedRoster(new Map([["p1", threeMonthsAndADay]]), NOW);
    expect(roster.isRanked("p1")).toBe(false);
    expect(roster.hiddenUserIds).toEqual(["p1"]);
  });

  it("keeps a player who played exactly on the cutoff instant", () => {
    // The rule is "no match in the last three months". A match ON the
    // boundary IS in the last three months, so it counts.
    const roster = buildRankedRoster(new Map([["p1", rankedTableCutoff(NOW)]]), NOW);
    expect(roster.isRanked("p1")).toBe(true);
  });

  it("drops a player with no recorded match at all", () => {
    const roster = buildRankedRoster(new Map(), NOW);
    expect(roster.isRanked("ghost")).toBe(false);
  });
});

describe("a returning player", () => {
  it("is ranked again the moment they play once, with nothing recalculated", () => {
    const lastPlayed = new Map([["p1", new Date("2026-04-01T12:00:00.000Z")]]);
    expect(buildRankedRoster(lastPlayed, NOW).isRanked("p1")).toBe(false);

    // One new match. Nothing else about the player changed — this is the
    // point of removal-over-decay: the number was never touched, so
    // there is nothing to restore.
    lastPlayed.set("p1", new Date("2026-09-14T20:00:00.000Z"));
    const after = buildRankedRoster(lastPlayed, NOW);
    expect(after.isRanked("p1")).toBe(true);
    expect(after.hiddenUserIds).toEqual([]);
  });
});

describe("a club-wide break does not empty the table", () => {
  it("keeps everyone who played right up to a six-week shutdown", () => {
    // Sutton's real 2026 break: last match 14 Jul, next 1 Sep (49 days).
    // Probed on live data 2026-09-15. Measured at the very end of the
    // break, a player from the final pre-break fixture is 7 weeks
    // inactive — comfortably inside a 3-month window.
    const endOfBreak = new Date("2026-08-31T12:00:00.000Z");
    const lastPreBreakFixture = new Date("2026-07-14T20:00:00.000Z");
    const roster = buildRankedRoster(new Map([["p1", lastPreBreakFixture]]), endOfBreak);
    expect(roster.isRanked("p1")).toBe(true);
  });

  it("still drops someone who had already gone quiet before the break began", () => {
    // Not a false positive: this player's last game was 21 Apr, which is
    // more than three months before the end of the break regardless of
    // whether the club played in between.
    const endOfBreak = new Date("2026-08-31T12:00:00.000Z");
    const roster = buildRankedRoster(
      new Map([["p1", new Date("2026-04-21T20:00:00.000Z")]]),
      endOfBreak,
    );
    expect(roster.isRanked("p1")).toBe(false);
  });
});

describe("the documented decisions are pinned, so a silent flip fails a test", () => {
  it("does not count a bench slot as having played", () => {
    expect(RANKED_TABLE_COUNTS_BENCH_AS_PLAYED).toBe(false);
  });

  it("applies the rule to the attendance table too", () => {
    expect(ATTENDANCE_TABLE_FOLLOWS_ACTIVITY_RULE).toBe(true);
  });

  it("does NOT apply the rule to Team of the Season", () => {
    expect(TEAM_OF_SEASON_FOLLOWS_ACTIVITY_RULE).toBe(false);
  });

  it("shows a player their own row on their own stats page", () => {
    expect(VIEWER_IS_EXEMPT_ON_OWN_STATS_PAGE).toBe(true);
  });
});

describe("buildRankedRoster reports what it hid, so a surface can say so", () => {
  it("lists the hidden players oldest-absence first with their last date", () => {
    const roster = buildRankedRoster(
      new Map([
        ["recent", new Date("2026-09-08T20:00:00.000Z")],
        ["gone-a-while", new Date("2026-05-26T20:00:00.000Z")],
        ["gone-longest", new Date("2026-04-21T20:00:00.000Z")],
      ]),
      NOW,
    );
    expect(roster.hiddenUserIds).toEqual(["gone-longest", "gone-a-while"]);
    expect(roster.hiddenCount).toBe(2);
    expect(roster.lastPlayed("gone-longest")).toEqual(new Date("2026-04-21T20:00:00.000Z"));
    expect(roster.lastPlayed("never-seen")).toBeNull();
  });

  it("reports nothing hidden when everyone is active", () => {
    const roster = buildRankedRoster(
      new Map([["a", new Date("2026-09-08T20:00:00.000Z")]]),
      NOW,
    );
    expect(roster.hiddenCount).toBe(0);
  });
});
