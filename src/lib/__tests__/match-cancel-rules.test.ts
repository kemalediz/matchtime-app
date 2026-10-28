/**
 * Which match an organiser's "cancel the session" or "it's back on" in HQ
 * is about (2026-10-22): the next one still to come, or the one on the day
 * named. Pure; no database.
 */
import { describe, expect, it } from "vitest";
import { PAST_CANCEL_WINDOW_DAYS, isPastGame, notPlayedDoor, pickHqMatch, withinPastCancelWindow } from "../match-cancel-rules";

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

  it("an already cancelled game is not picked to cancel; a game still kicking off today but later is not the past", () => {
    expect(pickHqMatch([{ ...TUE, status: "CANCELLED" }], WED, "cancel", "", true)).toBeNull();
    const tonight = m("tonight", "2026-10-28T21:15:00Z");
    expect(pickHqMatch([tonight], WED, "cancel", "today", true)).toBeNull();
    expect(pickHqMatch([tonight], new Date("2026-10-28T23:00:00Z"), "cancel", "today", true)?.id).toBe("tonight");
  });

  it("put back: a cancelled past match inside the window, only when the words point at the past", () => {
    const c = { ...TUE, status: "CANCELLED" };
    expect(pickHqMatch([c, NEXT_TUE], WED, "restore", "", true)?.id).toBe("tue");
    expect(pickHqMatch([c, NEXT_TUE], WED, "restore", "Tuesday", true)?.id).toBe("tue");
    expect(pickHqMatch([c, NEXT_TUE], WED, "restore", "")).toBeNull();
    expect(pickHqMatch([{ ...OLD_TUE, status: "CANCELLED" }], WED, "restore", "", true)).toBeNull();
    expect(pickHqMatch([TUE], WED, "restore", "", true)).toBeNull();
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
  it("cancelled and past, inside the window: 'It did happen'", () => {
    expect(notPlayedDoor({ ...tue, status: "CANCELLED" }, WED)).toBe("restore");
  });
  it("nothing for a scored game, one still to come, or one past the window", () => {
    expect(notPlayedDoor({ ...tue, redScore: 3, yellowScore: 2 }, WED)).toBeNull();
    expect(notPlayedDoor({ ...tue, date: new Date("2026-11-03T21:15:00Z"), status: "UPCOMING" }, WED)).toBeNull();
    expect(notPlayedDoor(tue, new Date("2026-11-04T10:00:00Z"))).toBeNull();
    expect(notPlayedDoor({ ...tue, status: "CANCELLED" }, new Date("2026-11-04T10:00:00Z"))).toBeNull();
  });
});
