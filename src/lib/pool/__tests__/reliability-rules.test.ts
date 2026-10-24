/**
 * Slice L7: no-shows, the result of a guest's game, the no-show and report
 * pauses, the flag on a club marking too many no-shows, report text, and
 * retention. Pure.
 */
import { describe, expect, it } from "vitest";
import {
  POOL_RELIABILITY,
  clubsMarkingTooMany,
  countableGuestGames,
  standingPause,
  finalGuestResult,
  noShowMarkRefusal,
  noShowMarkWindow,
  pausesForNoShows,
  pausesForReports,
  reportTextOf,
  safetyRecordPurgeBefore,
  selfResumeFrom,
} from "../reliability-rules";

const H = 3600_000;
const DAY = 24 * H;
const KICKOFF = new Date("2026-11-03T20:00:00Z");
const at = (hours: number) => new Date(KICKOFF.getTime() + hours * H);

describe("the no-show window: from kickoff until 24 hours after it", () => {
  it("opens at kickoff and closes 24 hours later", () => {
    expect(POOL_RELIABILITY.markWindowHours).toBe(24);
    expect(noShowMarkWindow(KICKOFF)).toEqual({ opensAt: KICKOFF, closesAt: at(24) });
  });

  const base = { result: "booked" as const, settled: false, attendance: "CONFIRMED" as const, matchStatus: "COMPLETED" as const, kickoff: KICKOFF };

  it("a confirmed guest can be marked a no-show inside the window, and put back to played", () => {
    expect(noShowMarkRefusal({ ...base, noShow: true, now: at(2) })).toBeNull();
    expect(noShowMarkRefusal({ ...base, result: "no-show", noShow: false, now: at(23.9) })).toBeNull();
    // Marking what is already marked is harmless (a double tap).
    expect(noShowMarkRefusal({ ...base, result: "no-show", noShow: true, now: at(3) })).toBeNull();
  });

  it("not before kickoff, not after the window", () => {
    expect(noShowMarkRefusal({ ...base, noShow: true, now: at(-0.1) })).toBe("not-started");
    expect(noShowMarkRefusal({ ...base, noShow: true, now: at(24) })).toBe("closed");
    expect(noShowMarkRefusal({ ...base, noShow: true, now: at(2), settled: true })).toBe("closed");
  });

  it("only a guest who held a place: not the bench, not one who pulled out, not a cancelled game", () => {
    expect(noShowMarkRefusal({ ...base, attendance: "BENCH", noShow: true, now: at(2) })).toBe("not-playing");
    expect(noShowMarkRefusal({ ...base, result: "late-cancel", noShow: true, now: at(2) })).toBe("not-playing");
    expect(noShowMarkRefusal({ ...base, result: "withdrawn", noShow: false, now: at(2) })).toBe("not-playing");
    expect(noShowMarkRefusal({ ...base, matchStatus: "CANCELLED", noShow: true, now: at(2) })).toBe("cancelled");
  });
});

describe("the result of a guest's game, once the window has closed", () => {
  const base = { result: "booked" as const, attendance: "CONFIRMED" as const, matchStatus: "COMPLETED" as const, kickoff: KICKOFF };

  it("is not decided while the organisers can still mark a no-show", () => {
    expect(finalGuestResult({ ...base, now: at(23) })).toBeNull();
  });

  it("a confirmed guest nobody marked played", () => {
    expect(finalGuestResult({ ...base, now: at(24) })).toEqual({ result: "played" });
  });

  it("a marked no-show, a late cancel and a pull-out stay as they were", () => {
    for (const result of ["no-show", "late-cancel", "withdrawn"] as const) expect(finalGuestResult({ ...base, result, now: at(30) })).toEqual({ result });
  });

  it("a place given up with no recorded result was given up in time (benefit of the doubt)", () => {
    expect(finalGuestResult({ ...base, attendance: "DROPPED", now: at(30) })).toEqual({ result: "withdrawn" });
    expect(finalGuestResult({ ...base, attendance: null, now: at(30) })).toEqual({ result: "withdrawn" });
  });

  it("a bench place never called up and a cancelled game are not games: settled, still booked", () => {
    expect(finalGuestResult({ ...base, attendance: "BENCH", now: at(30) })).toEqual({ result: "booked" });
    expect(finalGuestResult({ ...base, matchStatus: "CANCELLED", now: at(30) })).toEqual({ result: "booked" });
  });
});

describe("the no-show pause: 2 no-shows in his last 5 guest games", () => {
  const g = (days: number, result: "played" | "no-show" | "late-cancel" | "withdrawn" | "booked") => ({ kickoff: new Date(KICKOFF.getTime() + days * DAY), result });

  it("pauses on the second no-show within his last five counted games", () => {
    expect(POOL_RELIABILITY.noShowPause).toEqual({ noShows: 2, lastGames: 5 });
    expect(pausesForNoShows([g(0, "no-show"), g(7, "played"), g(14, "no-show")])).toBe(true);
    expect(pausesForNoShows([g(0, "no-show")])).toBe(false);
  });

  it("a no-show older than his last five counted games no longer counts", () => {
    expect(pausesForNoShows([g(0, "no-show"), g(1, "played"), g(2, "played"), g(3, "played"), g(4, "played"), g(5, "no-show")])).toBe(false);
    expect(pausesForNoShows([g(0, "no-show"), g(2, "played"), g(3, "played"), g(4, "played"), g(5, "no-show")])).toBe(true);
  });

  it("late cancels are misses on the record but not no-shows; pulled out in time and booked are not games", () => {
    expect(pausesForNoShows([g(0, "late-cancel"), g(1, "late-cancel"), g(2, "no-show")])).toBe(false);
    expect(pausesForNoShows([g(0, "no-show"), g(1, "withdrawn"), g(2, "booked"), g(3, "withdrawn"), g(4, "booked"), g(5, "withdrawn"), g(6, "booked"), g(9, "no-show")])).toBe(true);
  });
});

describe("resuming a pause from the manage page", () => {
  const paused = new Date("2026-11-01T10:00:00Z");
  it("his own pause and the ignored-offers pause: at once", () => {
    expect(selfResumeFrom({ reason: "self", pausedAt: paused })).toEqual(paused);
    expect(selfResumeFrom({ reason: "ignored", pausedAt: paused })).toEqual(paused);
  });
  it("the no-show pause: 30 days after it began (plan 5.5)", () => {
    expect(POOL_RELIABILITY.noShowResumeAfterDays).toBe(30);
    expect(selfResumeFrom({ reason: "no-shows", pausedAt: paused })).toEqual(new Date(paused.getTime() + 30 * DAY));
  });
  it("reports and the owner: only a person lifts them", () => {
    expect(selfResumeFrom({ reason: "reports", pausedAt: paused })).toBeNull();
    expect(selfResumeFrom({ reason: "admin", pausedAt: paused })).toBeNull();
  });
});

describe("the report pause: reports from two different clubs, pending a person's review", () => {
  const r = (orgId: string, by: "club" | "player" = "club", reviewed = false) => ({ orgId, by, reviewed });
  it("two clubs' open reports about him pause him", () => {
    expect(POOL_RELIABILITY.reportPauseClubs).toBe(2);
    expect(pausesForReports([r("a"), r("b")])).toBe(true);
  });
  it("two reports from one club do not; his own reports about clubs never count; reviewed ones are done", () => {
    expect(pausesForReports([r("a"), r("a")])).toBe(false);
    expect(pausesForReports([r("a"), r("b", "player")])).toBe(false);
    expect(pausesForReports([r("a", "club", true), r("b")])).toBe(false);
  });
});

describe("a club marking many no-shows is flagged for the owner (plan 5.5)", () => {
  const now = new Date("2026-11-30T12:00:00Z");
  const m = (orgId: string, userId: string, daysAgo: number) => ({ orgId, userId, at: new Date(now.getTime() - daysAgo * DAY) });
  it("more than 3 different players in 30 days", () => {
    expect(POOL_RELIABILITY.clubFlag).toEqual({ players: 3, days: 30 });
    expect(clubsMarkingTooMany([m("a", "u1", 1), m("a", "u2", 2), m("a", "u3", 3), m("a", "u4", 29)], now)).toEqual([{ orgId: "a", players: 4 }]);
  });
  it("the same player twice, three players, or an old mark: not flagged", () => {
    expect(clubsMarkingTooMany([m("a", "u1", 1), m("a", "u1", 2), m("a", "u2", 3), m("a", "u3", 4)], now)).toEqual([]);
    expect(clubsMarkingTooMany([m("a", "u1", 1), m("a", "u2", 2), m("a", "u3", 3), m("a", "u4", 31)], now)).toEqual([]);
  });
});

describe("report text", () => {
  it("is trimmed, its spacing tidied, and must say something", () => {
    expect(reportTextOf("  He  shouted at\n\n\nplayers  ")).toBe("He shouted at\n\nplayers");
    expect(reportTextOf("  ")).toBeNull();
    expect(reportTextOf("ok")).toBeNull();
    expect(reportTextOf(42)).toBeNull();
  });
  it("is capped", () => {
    expect(reportTextOf("x".repeat(POOL_RELIABILITY.reportTextMax + 50))?.length).toBe(POOL_RELIABILITY.reportTextMax);
  });
});

describe("retention (decision L0.3)", () => {
  it("block and report records go 24 months after the profile was deleted", () => {
    const now = new Date("2028-12-01T00:00:00Z");
    expect(safetyRecordPurgeBefore(now)).toEqual(new Date("2026-12-01T00:00:00Z"));
  });
});

// ── Review of #404 ─────────────────────────────────────────────────────

describe("review #404: only final results count toward the pause (finding 1, and 8)", () => {
  const g = (days: number, result: "played" | "no-show", over: { settled?: boolean; cancelled?: boolean } = {}) => ({
    kickoff: new Date(KICKOFF.getTime() + days * 24 * H),
    result,
    settledAt: over.settled === false ? null : new Date(KICKOFF.getTime() + (days + 1) * 24 * H),
    cancelled: over.cancelled ?? false,
  });
  it("a no-show still inside its window (undo-able) is not counted", () => {
    expect(countableGuestGames([g(0, "no-show"), g(5, "no-show", { settled: false })])).toHaveLength(1);
  });
  it("a game whose match was cancelled is never counted, whatever it says", () => {
    expect(countableGuestGames([g(0, "no-show", { cancelled: true }), g(5, "no-show")])).toHaveLength(1);
  });
});

describe("review #404: a cancelled match waits like any other (finding 2), and is reset as not a game (finding 8)", () => {
  const base = { result: "booked" as const, attendance: "CONFIRMED" as const, matchStatus: "CANCELLED" as const, kickoff: KICKOFF };
  it("before the window has closed: not settled, so a restored game can still be played and marked", () => {
    expect(finalGuestResult({ ...base, now: at(-5) })).toBeNull();
    expect(finalGuestResult({ ...base, now: at(23) })).toBeNull();
  });
  it("after the window: settled as not a game, a recorded result cleared", () => {
    expect(finalGuestResult({ ...base, now: at(24) })).toEqual({ result: "booked" });
    expect(finalGuestResult({ ...base, result: "no-show", now: at(30) })).toEqual({ result: "booked" });
    expect(finalGuestResult({ ...base, result: "late-cancel", now: at(30) })).toEqual({ result: "booked" });
  });
});

describe("review #404: a guest taken off after kickoff can still be marked (finding 6)", () => {
  const base = { result: "booked" as const, settled: false, matchStatus: "COMPLETED" as const, kickoff: KICKOFF, noShow: true, now: at(2) };
  it("no attendance row any more (removed after kickoff): markable; the bench still is not", () => {
    expect(noShowMarkRefusal({ ...base, attendance: null })).toBeNull();
    expect(noShowMarkRefusal({ ...base, attendance: "DROPPED" })).toBeNull();
    expect(noShowMarkRefusal({ ...base, attendance: "BENCH" })).toBe("not-playing");
  });
});

describe("review #404: a pause MatchTime decided comes back on a new profile (finding 4)", () => {
  const now = new Date("2026-12-01T12:00:00Z");
  const ns = (daysAgo: number) => ({ kickoff: new Date(now.getTime() - (daysAgo + 1) * 24 * H), result: "no-show" as const, settledAt: new Date(now.getTime() - daysAgo * 24 * H), cancelled: false });
  it("two recent final no-shows: paused for no-shows from the later one's settling, not from now", () => {
    expect(standingPause({ games: [ns(20), ns(10)], openClubReportOrgs: [], now })).toEqual({ reason: "no-shows", pausedAt: new Date(now.getTime() - 10 * 24 * H) });
  });
  it("its 30 days already over: no pause", () => {
    expect(standingPause({ games: [ns(60), ns(40)], openClubReportOrgs: [], now })).toBeNull();
  });
  it("open reports from two clubs: paused for reports, now", () => {
    expect(standingPause({ games: [], openClubReportOrgs: ["a", "b", "a"], now })).toEqual({ reason: "reports", pausedAt: now });
    expect(standingPause({ games: [], openClubReportOrgs: ["a", "a"], now })).toBeNull();
  });
});

describe("review #404: report text counted in characters, as the database does (finding 11)", () => {
  it("emoji count as one character each", () => {
    const text = "😀".repeat(POOL_RELIABILITY.reportTextMax + 10);
    const out = reportTextOf(text)!;
    expect([...out].length).toBe(POOL_RELIABILITY.reportTextMax);
    expect(reportTextOf("😀😀")).toBeNull();
  });
});
