/**
 * The automatic ask, pure (cross-club ask, slice S5, D4).
 * From the club's London time on match day until the cut-off, with a place
 * open and the club's own bench empty, each partner asked once per match,
 * never a partner whose own overlapping game is short. The time is a
 * London wall clock, so it holds across the October clock change.
 */
import { describe, expect, it } from "vitest";
import { askWindows, autoAskAt, autoAskDue, gamesOverlap, type AutoAskInput } from "../partner-ask-rules";

const H = 3600_000;

describe("autoAskAt: the club's London time on match day", () => {
  it("summer time (BST): 16:00 London is 15:00 UTC", () => {
    const kickoff = new Date("2026-10-23T19:30:00Z"); // Fri 23 Oct 20:30 BST
    expect(autoAskAt(kickoff, "16:00").toISOString()).toBe("2026-10-23T15:00:00.000Z");
  });
  it("after the clocks go back (25 Oct 2026): 16:00 London is 16:00 UTC", () => {
    const kickoff = new Date("2026-10-30T20:30:00Z"); // Fri 30 Oct 20:30 GMT
    expect(autoAskAt(kickoff, "16:00").toISOString()).toBe("2026-10-30T16:00:00.000Z");
  });
  it("on the day of the change itself (Sun 25 Oct): still the wall clock", () => {
    const kickoff = new Date("2026-10-25T19:00:00Z"); // Sun 25 Oct 19:00 GMT
    expect(autoAskAt(kickoff, "12:30").toISOString()).toBe("2026-10-25T12:30:00.000Z");
    const before = new Date("2026-10-24T19:00:00Z"); // Sat 24 Oct 20:00 BST
    expect(autoAskAt(before, "12:30").toISOString()).toBe("2026-10-24T11:30:00.000Z");
  });
});

describe("autoAskDue", () => {
  const kickoff = new Date("2026-10-30T20:30:00Z");
  const askAt = autoAskAt(kickoff, "16:00");
  const { postBy } = askWindows(kickoff, 4); // 16:30
  const base = (over: Partial<AutoAskInput> = {}): AutoAskInput => ({
    now: new Date(askAt.getTime() + 60_000),
    askAt,
    postBy,
    placesOpen: 1,
    waitingCount: 0,
    askedBefore: false,
    partnerOwnGameShort: false,
    ...over,
  });

  it("from the time until the cut-off, with a place open and nobody on the bench: due", () => {
    expect(autoAskDue(base())).toBe(true);
    expect(autoAskDue(base({ now: askAt }))).toBe(true);
    expect(autoAskDue(base({ now: new Date(askAt.getTime() - 1) }))).toBe(false);
    expect(autoAskDue(base({ now: postBy }))).toBe(false);
  });
  it("a time after the cut-off is never reached", () => {
    const late = autoAskAt(kickoff, "18:00");
    expect(autoAskDue(base({ askAt: late, now: new Date(late.getTime() + 1) }))).toBe(false);
  });
  it("the club's own bench first: anybody waiting, no ask", () => {
    expect(autoAskDue(base({ waitingCount: 1 }))).toBe(false);
  });
  it("no place open, no ask", () => {
    expect(autoAskDue(base({ placesOpen: 0 }))).toBe(false);
  });
  it("each partner once per match", () => {
    expect(autoAskDue(base({ askedBefore: true }))).toBe(false);
  });
  it("never a partner whose own overlapping game is short", () => {
    expect(autoAskDue(base({ partnerOwnGameShort: true }))).toBe(false);
  });
});

describe("gamesOverlap: an hour either side of each game", () => {
  const at = (iso: string) => new Date(iso);
  it("20:30 and 21:00 the same evening overlap", () => {
    expect(gamesOverlap({ kickoff: at("2026-10-30T20:30:00Z"), durationMins: 60 }, { kickoff: at("2026-10-30T21:00:00Z"), durationMins: 60 })).toBe(true);
  });
  it("a 60-minute game at 18:00 and one at 21:00: an hour's gap either side still meets", () => {
    // 18:00 game ends 19:00, +1h = 20:00; the 21:00 game's window opens 20:00: touching, not overlapping.
    expect(gamesOverlap({ kickoff: at("2026-10-30T18:00:00Z"), durationMins: 60 }, { kickoff: at("2026-10-30T21:00:00Z"), durationMins: 60 })).toBe(false);
    expect(gamesOverlap({ kickoff: at("2026-10-30T18:00:00Z"), durationMins: 61 }, { kickoff: at("2026-10-30T21:00:00Z"), durationMins: 60 })).toBe(true);
  });
  it("a morning game and an evening game do not", () => {
    expect(gamesOverlap({ kickoff: at("2026-10-30T10:00:00Z"), durationMins: 90 }, { kickoff: at("2026-10-30T20:00:00Z"), durationMins: 60 })).toBe(false);
  });
  it("the window is symmetric", () => {
    const a = { kickoff: at("2026-10-30T20:30:00Z"), durationMins: 60 };
    const b = { kickoff: at("2026-10-30T19:00:00Z"), durationMins: 90 };
    expect(gamesOverlap(a, b)).toBe(gamesOverlap(b, a));
    expect(H).toBe(3600_000);
  });
});
