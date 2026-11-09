/**
 * A weekly game's kickoff changed on /admin/activities: where each of its
 * games still to be played goes (Kemal, 2026-11-09: Monday night vets went
 * from 20:30 to 20:15 and tonight's and next week's games stayed at 20:30).
 * Pure: no database, no clock.
 */
import { describe, expect, it } from "vitest";
import { planActivityKickoffMove } from "../activity-kickoff-move-rules";
import { londonDateTimeToUtc, nextLondonKickoff } from "../london-time";
import { hasMatchForSlot } from "../match-slot";

const H = 3600_000;
const at = (date: string, time: string) => londonDateTimeToUtc(date, time);
// Monday 9 November 2026 (GMT), the vets' game.
const MON = at("2026-11-09", "20:30");
const MORNING = at("2026-11-09", "09:00");
const game = (date: Date, deadlineHours = 5) => ({ date, attendanceDeadline: new Date(date.getTime() - deadlineHours * H) });
const MONDAY = 1;

describe("planActivityKickoffMove: a new time", () => {
  it("20:30 to 20:15: the same London date at the new time, the sign-up deadline moving with it", () => {
    const plan = planActivityKickoffMove({
      match: game(MON),
      before: { dayOfWeek: MONDAY, time: "20:30" },
      after: { dayOfWeek: MONDAY, time: "20:15" },
      now: MORNING,
    });
    expect(plan).toEqual({ move: true, kickoff: at("2026-11-09", "20:15"), attendanceDeadline: at("2026-11-09", "15:15") });
  });

  it("in British Summer Time the London wall clock is kept, not the UTC hour", () => {
    const june = at("2026-06-15", "20:30"); // 19:30Z
    const plan = planActivityKickoffMove({
      match: game(june),
      before: { dayOfWeek: MONDAY, time: "20:30" },
      after: { dayOfWeek: MONDAY, time: "21:00" },
      now: at("2026-06-15", "09:00"),
    });
    expect(plan.move && plan.kickoff.toISOString()).toBe("2026-06-15T20:00:00.000Z");
  });

  it("on the day the clocks go back (Sunday 25 October 2026) the new time is read in GMT", () => {
    const sunday = at("2026-10-25", "20:30");
    const plan = planActivityKickoffMove({
      match: game(sunday),
      before: { dayOfWeek: 0, time: "20:30" },
      after: { dayOfWeek: 0, time: "19:00" },
      now: at("2026-10-25", "08:00"),
    });
    expect(plan.move && plan.kickoff.toISOString()).toBe("2026-10-25T19:00:00.000Z");
  });

  it("the deadline keeps the gap the game already had (a deadline change applies to new games only)", () => {
    const plan = planActivityKickoffMove({
      match: game(MON, 24),
      before: { dayOfWeek: MONDAY, time: "20:30" },
      after: { dayOfWeek: MONDAY, time: "21:30" },
      now: at("2026-11-08", "09:00"),
    });
    expect(plan.move && plan.attendanceDeadline).toEqual(at("2026-11-08", "21:30"));
  });

  it("nothing about the kickoff changed: no move", () => {
    const plan = planActivityKickoffMove({
      match: game(MON),
      before: { dayOfWeek: MONDAY, time: "20:30" },
      after: { dayOfWeek: MONDAY, time: "20:30" },
      now: MORNING,
    });
    expect(plan).toEqual({ move: false, reason: "unchanged" });
  });

  it("a game an organiser set to another time by hand (a block booking at 20:00) is left where it is", () => {
    const plan = planActivityKickoffMove({
      match: game(at("2026-11-09", "20:00")),
      before: { dayOfWeek: MONDAY, time: "20:30" },
      after: { dayOfWeek: MONDAY, time: "20:15" },
      now: MORNING,
    });
    expect(plan).toEqual({ move: false, reason: "set-by-hand" });
  });

  it("a new time alone moves a game on another weekday that sits on the old time (its date is kept)", () => {
    const plan = planActivityKickoffMove({
      match: game(at("2026-11-10", "20:30")), // a Tuesday, for a Monday activity
      before: { dayOfWeek: MONDAY, time: "20:30" },
      after: { dayOfWeek: MONDAY, time: "20:15" },
      now: MORNING,
    });
    expect(plan.move && plan.kickoff).toEqual(at("2026-11-10", "20:15"));
  });

  it("a game that has kicked off is never moved", () => {
    const plan = planActivityKickoffMove({
      match: game(MON),
      before: { dayOfWeek: MONDAY, time: "20:30" },
      after: { dayOfWeek: MONDAY, time: "21:00" },
      now: at("2026-11-09", "20:31"),
    });
    expect(plan).toEqual({ move: false, reason: "started" });
  });

  it("a new kickoff that is already past (tonight at 20:20, moved to 20:15) leaves the game where it is", () => {
    const plan = planActivityKickoffMove({
      match: game(MON),
      before: { dayOfWeek: MONDAY, time: "20:30" },
      after: { dayOfWeek: MONDAY, time: "20:15" },
      now: at("2026-11-09", "20:20"),
    });
    expect(plan).toEqual({ move: false, reason: "into-the-past" });
  });

  it("an unreadable stored time changes nothing and never throws", () => {
    const plan = planActivityKickoffMove({
      match: game(MON),
      before: { dayOfWeek: MONDAY, time: "half eight" },
      after: { dayOfWeek: MONDAY, time: "20:15" },
      now: MORNING,
    });
    expect(plan).toEqual({ move: false, reason: "unreadable-time" });
  });
});

describe("planActivityKickoffMove: a new day of the week", () => {
  it("Monday to Wednesday: the Wednesday of the same week (Monday to Sunday), at the new time", () => {
    const plan = planActivityKickoffMove({
      match: game(MON),
      before: { dayOfWeek: MONDAY, time: "20:30" },
      after: { dayOfWeek: 3, time: "20:15" },
      now: MORNING,
    });
    expect(plan).toEqual({ move: true, kickoff: at("2026-11-11", "20:15"), attendanceDeadline: at("2026-11-11", "15:15") });
  });

  it("Monday to Sunday: the Sunday that ends the same week", () => {
    const plan = planActivityKickoffMove({
      match: game(MON),
      before: { dayOfWeek: MONDAY, time: "20:30" },
      after: { dayOfWeek: 0, time: "20:30" },
      now: MORNING,
    });
    expect(plan.move && plan.kickoff).toEqual(at("2026-11-15", "20:30"));
  });

  it("Wednesday to Monday when that Monday has gone: the game is played on its old day", () => {
    const plan = planActivityKickoffMove({
      match: game(at("2026-11-11", "20:30")),
      before: { dayOfWeek: 3, time: "20:30" },
      after: { dayOfWeek: MONDAY, time: "20:30" },
      now: at("2026-11-10", "12:00"),
    });
    expect(plan).toEqual({ move: false, reason: "into-the-past" });
  });

  it("across the clocks going back: Friday 23 October (BST) to Sunday 25 October (GMT), 20:30 London both times", () => {
    const plan = planActivityKickoffMove({
      match: game(at("2026-10-23", "20:30")),
      before: { dayOfWeek: 5, time: "20:30" },
      after: { dayOfWeek: 0, time: "20:30" },
      now: at("2026-10-20", "12:00"),
    });
    expect(plan.move && plan.kickoff.toISOString()).toBe("2026-10-25T20:30:00.000Z");
  });

  it("never into another calendar month (a month's list and price count its own games)", () => {
    // Monday 30 November to Wednesday 2 December: the same week, but December.
    const plan = planActivityKickoffMove({
      match: game(at("2026-11-30", "20:30")),
      before: { dayOfWeek: MONDAY, time: "20:30" },
      after: { dayOfWeek: 3, time: "20:30" },
      now: at("2026-11-20", "12:00"),
    });
    expect(plan).toEqual({ move: false, reason: "other-month" });
  });

  it("a new day: a game not on the old weekday was put there by hand and stays", () => {
    const plan = planActivityKickoffMove({
      match: game(at("2026-11-10", "20:30")), // a Tuesday
      before: { dayOfWeek: MONDAY, time: "20:30" },
      after: { dayOfWeek: 3, time: "20:30" },
      now: MORNING,
    });
    expect(plan).toEqual({ move: false, reason: "set-by-hand" });
  });
});

describe("a moved game is the one the generators find (no second game on the next cron)", () => {
  it("time change: the nightly generator's next kickoff is the moved game's slot", () => {
    const plan = planActivityKickoffMove({
      match: game(at("2026-11-16", "20:30")),
      before: { dayOfWeek: MONDAY, time: "20:30" },
      after: { dayOfWeek: MONDAY, time: "22:30" }, // two hours: beyond the ±90 min tolerance
      now: MORNING,
    });
    if (!plan.move) throw new Error("expected a move");
    const fixture = { orgId: "vets", venue: "Goals", dayOfWeek: MONDAY };
    const next = nextLondonKickoff(MORNING, MONDAY, "22:30");
    expect(next).toEqual(plan.kickoff);
    expect(hasMatchForSlot({ ...fixture, instant: next }, [{ ...fixture, instant: plan.kickoff }])).toBe(true);
  });

  it("day change: the generator's next Wednesday is the moved game", () => {
    const plan = planActivityKickoffMove({
      match: game(MON),
      before: { dayOfWeek: MONDAY, time: "20:30" },
      after: { dayOfWeek: 3, time: "20:30" },
      now: MORNING,
    });
    if (!plan.move) throw new Error("expected a move");
    const fixture = { orgId: "vets", venue: "Goals", dayOfWeek: 3 };
    const next = nextLondonKickoff(MORNING, 3, "20:30");
    expect(hasMatchForSlot({ ...fixture, instant: next }, [{ ...fixture, instant: plan.kickoff }])).toBe(true);
  });
});
