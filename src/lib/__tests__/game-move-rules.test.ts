/**
 * MOVING A GAME BY WHATSAPP (Kemal, 2026-11-10): what code does with the
 * admin extractor's `move_game` reading. The model says WHICH game (its
 * number in the GAMES TO COME list it was shown), the new day and time, and
 * whether it is the weekly game from now on. Code checks each against what
 * it showed and what a kickoff can be, and either acts, or asks one short
 * question. No words are read here. Pure: no database, no clock.
 */
import { describe, expect, it } from "vitest";
import { gamesToComeLines, moveGameWordsOf, planMoveGame } from "../game-move-rules";
import { londonDateTimeToUtc } from "../london-time";
import type { AdminFacts } from "../pipeline/types";

const at = (date: string, time: string) => londonDateTimeToUtc(date, time);
const MON = { id: "m-mon", date: at("2026-11-16", "20:30"), activityId: "vets", activityName: "Monday Vets" };
const THU = { id: "m-thu", date: at("2026-11-19", "19:00"), activityId: "sevens", activityName: "Thursday 7s" };
const MON2 = { id: "m-mon2", date: at("2026-11-23", "20:30"), activityId: "vets", activityName: "Monday Vets" };
const VETS = [{ id: "vets", name: "Monday Vets" }];
const BOTH = [...VETS, { id: "sevens", name: "Thursday 7s" }];
const facts = (f: Partial<AdminFacts>): AdminFacts => ({ kind: "admin", action: "move_game", ...f });

describe("gamesToComeLines: what the model is shown", () => {
  it("numbers each game from 1 with its London weekday, date, kickoff and name", () => {
    expect(gamesToComeLines([MON, THU])).toEqual([
      "1. Monday 16 November 2026 at 20:30 (Monday Vets)",
      "2. Thursday 19 November 2026 at 19:00 (Thursday 7s)",
    ]);
  });

  it("reads London time in British Summer Time", () => {
    expect(gamesToComeLines([{ ...MON, date: at("2026-06-15", "20:30") }])).toEqual(["1. Monday 15 June 2026 at 20:30 (Monday Vets)"]);
  });
});

describe("moveGameWordsOf: the reading, checked", () => {
  it("carries the game number, the day, the time and every week", () => {
    expect(moveGameWordsOf(facts({ game: 2, newDay: 3, newTime: "20:15", everyWeek: true }))).toEqual({ game: 2, newDay: 3, newTime: "20:15", everyWeek: true });
  });

  it("a one-digit hour is written as two (the model's own format slip, not words)", () => {
    expect(moveGameWordsOf(facts({ newTime: "8:15" })).newTime).toBe("08:15");
  });

  it("a time that is not a time of day, or a day that is not a weekday, is no value at all", () => {
    expect(moveGameWordsOf(facts({ newTime: "8.15pm", newDay: 9 }))).toEqual({ game: null, newDay: null, newTime: null, everyWeek: false, unreadableTime: true });
    expect(moveGameWordsOf(facts({ newTime: "24:00" })).newTime).toBeNull();
  });

  it("nothing said is nothing", () => {
    expect(moveGameWordsOf(facts({}))).toEqual({ game: null, newDay: null, newTime: null, everyWeek: false });
  });
});

describe("planMoveGame: one game", () => {
  it("the game the model picked from the list, to the new time", () => {
    expect(planMoveGame({ game: 1, newDay: null, newTime: "20:15", everyWeek: false }, [MON, THU], BOTH)).toEqual({ kind: "one", game: MON, toDayOfWeek: null, toTime: "20:15" });
  });

  it("a new day alone keeps the game's own kickoff time", () => {
    expect(planMoveGame({ game: 1, newDay: 3, newTime: null, everyWeek: false }, [MON], VETS)).toEqual({ kind: "one", game: MON, toDayOfWeek: 3, toTime: "20:30" });
  });

  it("no game named and only one coming: that one", () => {
    expect(planMoveGame({ game: null, newDay: null, newTime: "20:15", everyWeek: false }, [MON], VETS)).toMatchObject({ kind: "one", game: MON });
  });

  it("no game named and several coming: asks which, never guesses", () => {
    expect(planMoveGame({ game: null, newDay: null, newTime: "20:15", everyWeek: false }, [MON, THU, MON2], BOTH)).toEqual({ kind: "which", options: [MON, THU, MON2], toDayOfWeek: null, toTime: "20:15" });
  });

  it("a number that is not on the list asks which, never guesses", () => {
    expect(planMoveGame({ game: 7, newDay: null, newTime: "20:15", everyWeek: false }, [MON, THU], BOTH).kind).toBe("which");
  });

  it("no new day and no new time: asks what to change it to", () => {
    expect(planMoveGame({ game: 1, newDay: null, newTime: null, everyWeek: false }, [MON], VETS)).toEqual({ kind: "say-what" });
    expect(planMoveGame({ game: 1, newDay: null, newTime: null, everyWeek: false, unreadableTime: true }, [MON], VETS)).toEqual({ kind: "say-what" });
  });

  it("a time given that could not be read is never dropped for the day alone: asks again", () => {
    expect(planMoveGame({ game: 1, newDay: 3, newTime: null, everyWeek: false, unreadableTime: true }, [MON], VETS)).toEqual({ kind: "say-what" });
    expect(planMoveGame({ game: 1, newDay: 3, newTime: null, everyWeek: true, unreadableTime: true }, [MON], VETS)).toEqual({ kind: "say-what" });
  });

  it("no games coming", () => {
    expect(planMoveGame({ game: 1, newDay: null, newTime: "20:15", everyWeek: false }, [], VETS)).toEqual({ kind: "no-games" });
  });
});

describe("planMoveGame: the weekly game, from now on", () => {
  it("the activity of the game the model picked", () => {
    expect(planMoveGame({ game: 2, newDay: null, newTime: "19:30", everyWeek: true }, [MON, THU], BOTH)).toEqual({ kind: "every-week", activityId: "sevens", activityName: "Thursday 7s", time: "19:30" });
  });

  it("no game named, the club's only weekly game", () => {
    expect(planMoveGame({ game: null, newDay: 2, newTime: null, everyWeek: true }, [MON, MON2], VETS)).toEqual({ kind: "every-week", activityId: "vets", activityName: "Monday Vets", dayOfWeek: 2 });
  });

  it("works with no game made yet: the club's only weekly game", () => {
    expect(planMoveGame({ game: null, newDay: null, newTime: "20:15", everyWeek: true }, [], VETS)).toMatchObject({ kind: "every-week", activityId: "vets" });
  });

  it("no game named and two weekly games: asks which, naming each once", () => {
    expect(planMoveGame({ game: null, newDay: null, newTime: "20:15", everyWeek: true }, [MON, THU, MON2], BOTH)).toEqual({
      kind: "which-weekly",
      options: [{ id: "vets", name: "Monday Vets" }, { id: "sevens", name: "Thursday 7s" }],
      toDayOfWeek: null,
      toTime: "20:15",
    });
  });

  it("no new day and no new time: asks what to change it to", () => {
    expect(planMoveGame({ game: null, newDay: null, newTime: null, everyWeek: true }, [MON], VETS)).toEqual({ kind: "say-what" });
  });

  it("no weekly game at all", () => {
    expect(planMoveGame({ game: null, newDay: null, newTime: "20:15", everyWeek: true }, [], [])).toEqual({ kind: "no-games" });
  });
});
