/**
 * Which match an organiser's "cancel the session" or "it's back on" in HQ
 * is about (2026-10-22): the next one still to come, or the one on the day
 * named. Pure; no database.
 */
import { describe, expect, it } from "vitest";
import { PAST_CANCEL_WINDOW_DAYS, bareWeekdayClash, isPastGame, notPlayedDoor, pickHqMatch, withinPastCancelWindow } from "../match-cancel-rules";

// Thursday 22 Oct 2026, 15:00 London (14:00 UTC).
const NOW = new Date("2026-10-22T14:00:00Z");
const m = (id: string, iso: string, status = "UPCOMING") => ({ id, date: new Date(iso), status });
const FRI = m("fri", "2026-10-23T19:30:00Z");
const NEXT_FRI = m("fri2", "2026-10-30T20:30:00Z");
const PAST = m("past", "2026-10-16T19:30:00Z", "COMPLETED");

describe("pickHqMatch: cancel", () => {
  it("no day named: the next match still to come", () => {
    expect(pickHqMatch([NEXT_FRI, FRI, PAST], NOW, "cancel", "")?.id).toBe("fri");
  });
  it("never a completed, cancelled or already kicked-off match", () => {
    const today = m("today", "2026-10-22T13:00:00Z");
    expect(pickHqMatch([PAST, today, { ...FRI, status: "CANCELLED" }, NEXT_FRI], NOW, "cancel", "")?.id).toBe("fri2");
  });
  it("teams made or published still count as to come", () => {
    expect(pickHqMatch([{ ...FRI, status: "TEAMS_PUBLISHED" }], NOW, "cancel", null)?.id).toBe("fri");
  });
  it("a named weekday: that day's match", () => {
    expect(pickHqMatch([FRI, NEXT_FRI], NOW, "cancel", "Friday")?.id).toBe("fri");
    expect(pickHqMatch([FRI, NEXT_FRI], NOW, "cancel", "cuma")?.id).toBe("fri");
  });
  it("next week: the first match from next Monday", () => {
    expect(pickHqMatch([FRI, NEXT_FRI], NOW, "cancel", "next week")?.id).toBe("fri2");
  });
  it("tomorrow", () => {
    expect(pickHqMatch([FRI, NEXT_FRI], NOW, "cancel", "tomorrow")?.id).toBe("fri");
  });
  it("a day with no match: none, never a different match", () => {
    expect(pickHqMatch([FRI, NEXT_FRI], NOW, "cancel", "Tuesday")).toBeNull();
  });
  it("words that name no day: the next match", () => {
    expect(pickHqMatch([FRI, NEXT_FRI], NOW, "cancel", "this week")?.id).toBe("fri");
  });
  it("nothing to come: none", () => {
    expect(pickHqMatch([PAST], NOW, "cancel", "")).toBeNull();
  });
});

describe("pickHqMatch: restore", () => {
  it("the next cancelled match still to come", () => {
    const c = { ...FRI, status: "CANCELLED" };
    expect(pickHqMatch([c, NEXT_FRI], NOW, "restore", "")?.id).toBe("fri");
  });
  it("a cancelled match already past is never put back on", () => {
    const c = m("old", "2026-10-22T10:00:00Z", "CANCELLED");
    expect(pickHqMatch([c, FRI], NOW, "restore", "")).toBeNull();
  });
  it("a match that is not cancelled is not restored", () => {
    expect(pickHqMatch([FRI], NOW, "restore", "Friday")).toBeNull();
  });
});

// ── A game that did not happen (2026-10-28, Kemal) ─────────────────────
// Wednesday 28 Oct 2026, 10:00 London (GMT, so 10:00 UTC). Sutton FC's
// Tuesday 5-a-side kicked off yesterday at 21:15 and never happened.
describe("a recent past match: marked as not played, or put back", () => {
  const WED = new Date("2026-10-28T10:00:00Z");
  const TUE = m("tue", "2026-10-27T21:15:00Z", "COMPLETED");
  const OLD_TUE = m("tue-1", "2026-10-20T21:15:00Z", "COMPLETED");
  const NEXT_TUE = m("tue+1", "2026-11-03T21:15:00Z");
  const all = [OLD_TUE, TUE, NEXT_TUE];

  it("the window is 7 days after kickoff, the same for every door", () => {
    expect(PAST_CANCEL_WINDOW_DAYS).toBe(7);
    expect(withinPastCancelWindow(TUE.date, WED)).toBe(true);
    expect(withinPastCancelWindow(TUE.date, new Date("2026-11-03T21:15:00Z"))).toBe(true);
    expect(withinPastCancelWindow(TUE.date, new Date("2026-11-03T21:16:00Z"))).toBe(false);
    // Not yet kicked off: not a past match at all.
    expect(withinPastCancelWindow(NEXT_TUE.date, WED)).toBe(false);
  });

  it("the words point at the past: the most recent match behind, never the one to come", () => {
    expect(pickHqMatch(all, WED, "cancel", "", true)?.id).toBe("tue");
    expect(pickHqMatch(all, WED, "cancel", "Tuesday", true)?.id).toBe("tue");
    expect(pickHqMatch(all, WED, "cancel", "salı", true)?.id).toBe("tue");
    expect(pickHqMatch(all, WED, "cancel", "last Tuesday", true)?.id).toBe("tue");
  });

  it("a day gone by is the past even without the flag: last Tuesday, yesterday, dün, geçen salı", () => {
    expect(pickHqMatch(all, WED, "cancel", "last Tuesday")?.id).toBe("tue");
    expect(pickHqMatch(all, WED, "cancel", "yesterday")?.id).toBe("tue");
    expect(pickHqMatch(all, WED, "cancel", "dün")?.id).toBe("tue");
    expect(pickHqMatch(all, WED, "cancel", "geçen salı")?.id).toBe("tue");
  });

  it("words meaning the upcoming one never pick a past match", () => {
    expect(pickHqMatch(all, WED, "cancel", "")?.id).toBe("tue+1");
    expect(pickHqMatch(all, WED, "cancel", "Tuesday")?.id).toBe("tue+1");
    expect(pickHqMatch(all, WED, "cancel", "next Tuesday")?.id).toBe("tue+1");
    expect(pickHqMatch(all, WED, "cancel", "tomorrow")).toBeNull();
    // Said of the past, a day still to come names nothing.
    expect(pickHqMatch(all, WED, "cancel", "tomorrow", true)).toBeNull();
    expect(pickHqMatch(all, WED, "cancel", "next week", true)).toBeNull();
  });

  it("only inside the window: a match 8 days back is not picked", () => {
    expect(pickHqMatch([OLD_TUE], WED, "cancel", "", true)).toBeNull();
    expect(pickHqMatch([OLD_TUE, NEXT_TUE], new Date("2026-10-27T12:00:00Z"), "cancel", "Tuesday", true)?.id).toBe("tue-1");
  });

  it("a past day with no match: none, never a different match", () => {
    expect(pickHqMatch(all, WED, "cancel", "Monday", true)).toBeNull();
  });

  it("review of #437, 1: a cancelled game is still the last game: picked, so the core says 'already'; never the one before", () => {
    const c = { ...TUE, status: "CANCELLED" };
    expect(pickHqMatch([OLD_TUE, c, NEXT_TUE], WED, "cancel", "", true)?.id).toBe("tue");
    expect(pickHqMatch([OLD_TUE, c, NEXT_TUE], WED, "cancel", "Tuesday", true)?.id).toBe("tue");
    expect(pickHqMatch([OLD_TUE, c], WED, "cancel", "last Tuesday")?.id).toBe("tue");
  });

  it("a game still kicking off today but later is not the past", () => {
    const tonight = m("tonight", "2026-10-28T21:15:00Z");
    expect(pickHqMatch([tonight], WED, "cancel", "today", true)).toBeNull();
    expect(pickHqMatch([tonight], new Date("2026-10-28T23:00:00Z"), "cancel", "today", true)?.id).toBe("tonight");
  });

  it("review of #437, 3: on a Tuesday, 'last Tuesday' is 7 days ago, not today (as pickWaiverMatch reads it)", () => {
    // Tuesday 27 Oct 23:00, after tonight's game: last week's is just over
    // the 7 days, so "last Tuesday" names no game, never tonight's.
    const tueNight = new Date("2026-10-27T23:00:00Z");
    expect(pickHqMatch([OLD_TUE, TUE], tueNight, "cancel", "last Tuesday")).toBeNull();
    expect(pickHqMatch([OLD_TUE, TUE], tueNight, "cancel", "Tuesday", true)?.id).toBe("tue");
    // A Tuesday game earlier in the week of two: on the Tuesday at noon,
    // "last Tuesday" is the one 7 days back.
    const early = m("tue-1b", "2026-10-20T19:00:00Z", "COMPLETED");
    expect(pickHqMatch([early, TUE], new Date("2026-10-27T12:00:00Z"), "cancel", "last Tuesday")?.id).toBe("tue-1b");
  });

  it("put back: only a game marked as NOT PLAYED after kickoff, the most recent one; never an older one", () => {
    const np = { ...TUE, status: "CANCELLED", notPlayed: true };
    expect(pickHqMatch([np, NEXT_TUE], WED, "restore", "", true)?.id).toBe("tue");
    expect(pickHqMatch([np, NEXT_TUE], WED, "restore", "Tuesday", true)?.id).toBe("tue");
    expect(pickHqMatch([np, NEXT_TUE], WED, "restore", "")).toBeNull();
    expect(pickHqMatch([{ ...OLD_TUE, status: "CANCELLED", notPlayed: true }], WED, "restore", "", true)).toBeNull();
    expect(pickHqMatch([TUE], WED, "restore", "", true)).toBeNull();
    // Called off before kickoff (announced to the group): never "it did happen".
    expect(pickHqMatch([{ ...TUE, status: "CANCELLED" }], WED, "restore", "", true)).toBeNull();
    // The last game was played: the older not-played one is not reached for.
    expect(pickHqMatch([{ ...OLD_TUE, status: "CANCELLED", notPlayed: true, date: new Date("2026-10-23T19:00:00Z") }, TUE], WED, "restore", "", true)).toBeNull();
  });

  it("isPastGame: kicked off already", () => {
    expect(isPastGame(TUE.date, WED)).toBe(true);
    expect(isPastGame(NEXT_TUE.date, WED)).toBe(false);
  });
});

describe("notPlayedDoor: the match page's button", () => {
  const WED = new Date("2026-10-28T10:00:00Z");
  const tue = { date: new Date("2026-10-27T21:15:00Z"), status: "COMPLETED", redScore: null, yellowScore: null };
  it("a past game inside the window, not scored: 'This game didn't happen'", () => {
    expect(notPlayedDoor(tue, WED)).toBe("mark");
    expect(notPlayedDoor({ ...tue, status: "TEAMS_PUBLISHED" }, WED)).toBe("mark");
  });
  it("marked as not played, inside the window: 'It did happen'; called off before kickoff: nothing", () => {
    expect(notPlayedDoor({ ...tue, status: "CANCELLED", notPlayed: true }, WED)).toBe("restore");
    expect(notPlayedDoor({ ...tue, status: "CANCELLED", notPlayed: false }, WED)).toBeNull();
  });
  it("nothing for a scored game, one still to come, or one past the window", () => {
    expect(notPlayedDoor({ ...tue, redScore: 3, yellowScore: 2 }, WED)).toBeNull();
    expect(notPlayedDoor({ ...tue, date: new Date("2026-11-03T21:15:00Z"), status: "UPCOMING" }, WED)).toBeNull();
    expect(notPlayedDoor(tue, new Date("2026-11-04T10:00:00Z"))).toBeNull();
    expect(notPlayedDoor({ ...tue, status: "CANCELLED", notPlayed: true }, new Date("2026-11-04T10:00:00Z"))).toBeNull();
  });
});

describe("review of #437, 3: a bare weekday that could be last week's game", () => {
  const WED = new Date("2026-10-28T10:00:00Z");
  const TUE = { id: "tue", date: new Date("2026-10-27T21:15:00Z"), status: "COMPLETED", redScore: null, yellowScore: null };
  const NEXT = { id: "tue+1", date: new Date("2026-11-03T21:15:00Z"), status: "UPCOMING", redScore: null, yellowScore: null };
  it("'cancel Tuesday' on a Wednesday after an unscored Tuesday: ask, naming both games", () => {
    expect(bareWeekdayClash([TUE, NEXT], WED, "Tuesday", false)).toEqual({ past: TUE, next: NEXT });
    expect(bareWeekdayClash([TUE], WED, "salı", false)).toEqual({ past: TUE, next: null });
  });
  it("no question when the words say which, or the past game was played or is already cancelled", () => {
    expect(bareWeekdayClash([TUE, NEXT], WED, "Tuesday", true)).toBeNull();
    expect(bareWeekdayClash([TUE, NEXT], WED, "last Tuesday", false)).toBeNull();
    expect(bareWeekdayClash([TUE, NEXT], WED, "next Tuesday", false)).toBeNull();
    expect(bareWeekdayClash([{ ...TUE, redScore: 3, yellowScore: 1 }, NEXT], WED, "Tuesday", false)).toBeNull();
    expect(bareWeekdayClash([{ ...TUE, status: "CANCELLED" }, NEXT], WED, "Tuesday", false)).toBeNull();
    expect(bareWeekdayClash([TUE, NEXT], WED, "Friday", false)).toBeNull();
    expect(bareWeekdayClash([TUE, NEXT], WED, "", false)).toBeNull();
  });
});
