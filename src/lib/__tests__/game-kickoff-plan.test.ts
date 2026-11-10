/**
 * ONE GAME TO ANOTHER KICKOFF (Kemal, 2026-11-10: "@Match Time move
 * Monday's game to 8:15"). `planGameKickoff` is the per-game rule the weekly
 * change (#577, `planActivityKickoffMove`) already used inline: where a game
 * goes for a new London time and, optionally, a new weekday in the same
 * Monday-to-Sunday week, its sign-up deadline moving by as much. Now shared
 * by the weekly change and the one-game move. Pure: no database, no clock.
 */
import { describe, expect, it } from "vitest";
import { planGameKickoff } from "../activity-kickoff-move-rules";
import { londonDateTimeToUtc } from "../london-time";

const H = 3600_000;
const at = (date: string, time: string) => londonDateTimeToUtc(date, time);
const game = (date: Date, deadlineHours = 5) => ({ date, attendanceDeadline: new Date(date.getTime() - deadlineHours * H) });
// Monday 16 November 2026 (GMT), the vets' game; now is the Tuesday before.
const MON = at("2026-11-16", "20:30");
const NOW = at("2026-11-10", "10:00");
const [SUNDAY, MONDAY, WEDNESDAY] = [0, 1, 3];

describe("planGameKickoff: one game", () => {
  it("a new time: the same London date at the new time, the deadline moving with it", () => {
    expect(planGameKickoff({ match: game(MON), toDayOfWeek: null, toTime: "20:15", now: NOW })).toEqual({
      move: true,
      kickoff: at("2026-11-16", "20:15"),
      attendanceDeadline: at("2026-11-16", "15:15"),
    });
  });

  it("a new day: that weekday in the same Monday-to-Sunday week, at the time given", () => {
    const plan = planGameKickoff({ match: game(MON), toDayOfWeek: WEDNESDAY, toTime: "20:30", now: NOW });
    expect(plan).toEqual({ move: true, kickoff: at("2026-11-18", "20:30"), attendanceDeadline: at("2026-11-18", "15:30") });
  });

  it("Sunday is the END of the game's week, not the start", () => {
    const plan = planGameKickoff({ match: game(MON), toDayOfWeek: SUNDAY, toTime: "10:00", now: NOW });
    expect(plan.move && plan.kickoff).toEqual(at("2026-11-22", "10:00"));
  });

  it("the game's own day, given again, is the same date", () => {
    const plan = planGameKickoff({ match: game(MON), toDayOfWeek: MONDAY, toTime: "21:00", now: NOW });
    expect(plan.move && plan.kickoff).toEqual(at("2026-11-16", "21:00"));
  });

  it("in British Summer Time the London wall clock is kept", () => {
    const june = at("2026-06-15", "20:30");
    const plan = planGameKickoff({ match: game(june), toDayOfWeek: null, toTime: "21:00", now: at("2026-06-14", "09:00") });
    expect(plan.move && plan.kickoff.toISOString()).toBe("2026-06-15T20:00:00.000Z");
  });

  it("a game that has started stays", () => {
    expect(planGameKickoff({ match: game(MON), toDayOfWeek: null, toTime: "21:00", now: at("2026-11-16", "20:31") })).toEqual({ move: false, reason: "started" });
  });

  it("a new kickoff already gone stays (tonight at 20:20, moved to 20:15)", () => {
    expect(planGameKickoff({ match: game(MON), toDayOfWeek: null, toTime: "20:15", now: at("2026-11-16", "20:20") })).toEqual({ move: false, reason: "into-the-past" });
  });

  it("a new day in another calendar month stays (a monthly club's list counts each month's games)", () => {
    const fri = at("2026-11-27", "20:30"); // Friday; the Monday-to-Sunday week runs to Sunday 29 Nov
    expect(planGameKickoff({ match: game(fri), toDayOfWeek: MONDAY, toTime: "20:30", now: NOW }).move).toBe(true);
    const mon30 = at("2026-11-30", "20:30"); // that week's Wednesday is 2 December
    expect(planGameKickoff({ match: game(mon30), toDayOfWeek: WEDNESDAY, toTime: "20:30", now: NOW })).toEqual({ move: false, reason: "other-month" });
  });

  it("the same kickoff is unchanged", () => {
    expect(planGameKickoff({ match: game(MON), toDayOfWeek: MONDAY, toTime: "20:30", now: NOW })).toEqual({ move: false, reason: "unchanged" });
  });

  it("a time that is not HH:mm changes nothing and never throws", () => {
    expect(planGameKickoff({ match: game(MON), toDayOfWeek: null, toTime: "8.15pm", now: NOW })).toEqual({ move: false, reason: "unreadable-time" });
    expect(planGameKickoff({ match: game(MON), toDayOfWeek: null, toTime: "25:00", now: NOW })).toEqual({ move: false, reason: "unreadable-time" });
  });

  it("a weekday that is not 0 to 6 changes nothing", () => {
    expect(planGameKickoff({ match: game(MON), toDayOfWeek: 9, toTime: "20:30", now: NOW })).toEqual({ move: false, reason: "unreadable-time" });
  });
});
