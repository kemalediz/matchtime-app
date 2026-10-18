/**
 * Who may enter a match's score on the dashboard (FNF, 2026-10-18).
 *
 * The club owner of FNF opened Fri 16 Oct (COMPLETED, no score) and
 * found nowhere to enter the result: the match page only linked to the
 * score box for a match that was still to be played. The rule here is
 * the one the match page, the teams page and the result lists share:
 * any match that has been played (kickoff passed, or already COMPLETED)
 * and was not cancelled.
 */
import { describe, it, expect } from "vitest";
import {
  canEnterScore,
  hasScore,
  scoreEntryAction,
  parseScoreInput,
  validateScorePair,
  scorePanelHref,
  shouldOpenScorePanel,
} from "../score-entry";

const NOW = new Date("2026-10-18T12:00:00Z");
const PAST = new Date("2026-10-16T19:30:00Z");
const FUTURE = new Date("2026-10-23T19:30:00Z");

const m = (status: string, date: Date, redScore: number | null = null, yellowScore: number | null = null) => ({
  status,
  date,
  redScore,
  yellowScore,
});

describe("canEnterScore", () => {
  it("a COMPLETED match with no score can take one (the FNF match)", () => {
    expect(canEnterScore(m("COMPLETED", PAST), NOW)).toBe(true);
  });

  it("every live status counts once kickoff has passed, teams published or not", () => {
    for (const s of ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"]) {
      expect(canEnterScore(m(s, PAST), NOW), s).toBe(true);
    }
  });

  it("a match still to be played cannot take a score", () => {
    for (const s of ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"]) {
      expect(canEnterScore(m(s, FUTURE), NOW), s).toBe(false);
    }
  });

  it("a cancelled match never takes a score, past or future", () => {
    expect(canEnterScore(m("CANCELLED", PAST), NOW)).toBe(false);
    expect(canEnterScore(m("CANCELLED", FUTURE), NOW)).toBe(false);
  });

  it("kickoff exactly now counts as played", () => {
    expect(canEnterScore(m("TEAMS_GENERATED", NOW), NOW)).toBe(true);
  });

  it("accepts the date as a string (the teams page reads it from JSON)", () => {
    expect(canEnterScore({ status: "TEAMS_GENERATED", date: PAST.toISOString() }, NOW)).toBe(true);
    expect(canEnterScore({ status: "TEAMS_GENERATED", date: FUTURE.toISOString() }, NOW)).toBe(false);
  });
});

describe("hasScore", () => {
  it("needs both sides", () => {
    expect(hasScore(m("COMPLETED", PAST, 3, 2))).toBe(true);
    expect(hasScore(m("COMPLETED", PAST, 0, 0))).toBe(true);
    expect(hasScore(m("COMPLETED", PAST, 3, null))).toBe(false);
    expect(hasScore(m("COMPLETED", PAST))).toBe(false);
  });
});

describe("scoreEntryAction", () => {
  it("enter for a played match with no score, edit once it has one", () => {
    expect(scoreEntryAction(m("COMPLETED", PAST), NOW)).toBe("enter");
    expect(scoreEntryAction(m("COMPLETED", PAST, 4, 4), NOW)).toBe("edit");
  });

  it("nothing for a match that cannot take a score", () => {
    expect(scoreEntryAction(m("UPCOMING", FUTURE), NOW)).toBeNull();
    expect(scoreEntryAction(m("CANCELLED", PAST), NOW)).toBeNull();
  });
});

// ── The score panel on the match page (Kemal, 2026-10-18) ──────────────
// "Enter score" / "Edit score" open a panel on the match page itself
// instead of sending the admin to the teams page, which shows no date.

describe("parseScoreInput", () => {
  it("reads a whole number, 0 or more, with spaces around it", () => {
    expect(parseScoreInput("4")).toBe(4);
    expect(parseScoreInput("0")).toBe(0);
    expect(parseScoreInput(" 12 ")).toBe(12);
    expect(parseScoreInput("007")).toBe(7);
  });

  it("refuses anything that is not a whole number of goals", () => {
    for (const raw of ["", "  ", "-1", "1.5", "2,0", "abc", "4a", "+3", "1e2", "Infinity", "99999999999999999999"]) {
      expect(parseScoreInput(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe("validateScorePair", () => {
  it("both sides valid: the numbers updateMatchScore takes", () => {
    expect(validateScorePair("4", "2")).toEqual({ ok: true, redScore: 4, yellowScore: 2 });
    expect(validateScorePair("0", "0")).toEqual({ ok: true, redScore: 0, yellowScore: 0 });
  });

  it("names the first side that is wrong, so the panel can focus it", () => {
    expect(validateScorePair("", "2")).toEqual({ ok: false, field: "red" });
    expect(validateScorePair("3", "-1")).toEqual({ ok: false, field: "yellow" });
    expect(validateScorePair("x", "y")).toEqual({ ok: false, field: "red" });
  });
});

describe("scorePanelHref", () => {
  it("opens the match page with the score panel open", () => {
    expect(scorePanelHref("m1")).toBe("/matches/m1?score=1");
  });
});

describe("shouldOpenScorePanel", () => {
  it("opens on ?score=1 only", () => {
    expect(shouldOpenScorePanel("1")).toBe(true);
    expect(shouldOpenScorePanel(["1"])).toBe(true);
    expect(shouldOpenScorePanel(undefined)).toBe(false);
    expect(shouldOpenScorePanel("0")).toBe(false);
  });
});
