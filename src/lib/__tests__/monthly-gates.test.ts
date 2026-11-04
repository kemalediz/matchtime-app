/**
 * THE MONTH PHASE, AS A GATE (club summary, slice B2). One table: every
 * phase of a monthly club's game, and a weekly club's, against the flow
 * every consumer reads (the scheduler's posts, the deadline summary, the
 * unpaid list, "Squad complete") and the players' group IN hold.
 */
import { describe, expect, it } from "vitest";
import { monthFlowOf, monthNotStartedOf, stillToPlay } from "../monthly-gates";
import type { MonthPhase } from "../club-summary/types";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const at = (phase: MonthPhase) => ({ phase });

describe("monthFlowOf", () => {
  const rows: Array<[string, Parameters<typeof monthFlowOf>[0], ReturnType<typeof monthFlowOf>]> = [
    ["a weekly club is weekly, whatever it is handed", { mode: "weekly", month: null, stillToPlay: true }, "weekly"],
    ["a weekly club with a stray month fact is still weekly", { mode: "weekly", month: at("running"), stillToPlay: true }, "weekly"],
    ["monthly, no month yet: pending (no weekly post ever, D2)", { mode: "monthly", month: at("none"), stillToPlay: true }, "month-pending"],
    ["monthly, no month fact at all (a match the summary lacks): pending, never weekly", { mode: "monthly", month: null, stillToPlay: true }, "month-pending"],
    ["monthly, held for the organiser: pending", { mode: "monthly", month: at("held"), stillToPlay: true }, "month-pending"],
    ["monthly, in sign-up (open or priced): pending", { mode: "monthly", month: at("signup"), stillToPlay: true }, "month-pending"],
    ["monthly, running: the month", { mode: "monthly", month: at("running"), stillToPlay: true }, "month"],
    ["monthly, running, played: the month", { mode: "monthly", month: at("running"), stillToPlay: false }, "month"],
    ["monthly, closed, played: the month (its after-match gates outlive the close)", { mode: "monthly", month: at("closed"), stillToPlay: false }, "month"],
    ["monthly, closed, a game still to play: pending", { mode: "monthly", month: at("closed"), stillToPlay: true }, "month-pending"],
  ];
  it.each(rows)("%s", (_, input, want) => {
    expect(monthFlowOf(input)).toBe(want);
  });
});

describe("monthNotStartedOf: the players' group IN hold", () => {
  it("only a monthly club whose game has no month yet, or one held for its organiser", () => {
    const phases: MonthPhase[] = ["none", "held", "signup", "running", "closed"];
    expect(phases.filter((p) => monthNotStartedOf({ mode: "monthly", month: at(p) }))).toEqual(["none", "held"]);
    expect(monthNotStartedOf({ mode: "weekly", month: null })).toBe(false);
    expect(monthNotStartedOf({ mode: "weekly", month: at("none") })).toBe(false);
  });

  it("an unknown month (no fact) is not 'not started': the engine runs as before", () => {
    expect(monthNotStartedOf({ mode: "monthly", month: null })).toBe(false);
  });
});

describe("stillToPlay", () => {
  it("a live match not yet kicked off", () => {
    expect(stillToPlay({ status: "UPCOMING", date: new Date("2026-11-09T20:00:00Z") }, NOW)).toBe(true);
    expect(stillToPlay({ status: "TEAMS_PUBLISHED", date: new Date("2026-11-09T20:00:00Z") }, NOW)).toBe(true);
    expect(stillToPlay({ status: "UPCOMING", date: new Date("2026-11-02T20:00:00Z") }, NOW)).toBe(false);
    expect(stillToPlay({ status: "COMPLETED", date: new Date("2026-11-09T20:00:00Z") }, NOW)).toBe(false);
    expect(stillToPlay({ status: "CANCELLED", date: new Date("2026-11-09T20:00:00Z") }, NOW)).toBe(false);
  });
});
