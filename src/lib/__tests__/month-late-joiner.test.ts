/**
 * A LATE JOINER'S PARTIAL COMMITMENT (2026-11-16). Somebody who joins a
 * month already under way covers only the games LEFT (`applySignup`
 * writes `gamesCovered: gamesLeft`), so the games he commits to are
 * counted against those, never against the month's total:
 *
 *   - the reader is given the games still to play, with their dates, and
 *     whether the sender is on each month's list, and its prompt counts a
 *     joiner's games against the games left;
 *   - the code guard (`fitLateJoinGames`): a count that does not fit the
 *     games left (above them, or equal to them although the reader read a
 *     partial commitment) is never stored as "every game". He is asked
 *     once by DM which of the games left he will play.
 *
 * Pure: no database and no model.
 */
import { describe, expect, it } from "vitest";
import { fitLateJoinGames } from "../squad-month-rules";
import {
  buildMonthlyReaderUserTurn,
  MONTHLY_READER_SYSTEM,
  monthHeadLine,
  type MonthlyReaderContext,
  type MonthlyReaderInput,
} from "../monthly-reader-prompt";
import { t } from "../i18n/t";

describe("fitLateJoinGames: a late joiner's commitment against the games left", () => {
  it("above the games left: asked, nothing stored", () => {
    // "except the last week" read against a five-game month (4) when only 3 are left.
    expect(fitLateJoinGames(4, 3)).toEqual({ kind: "ask" });
  });

  it("equal to the games left although the reader read a partial commitment: asked, never 'every game'", () => {
    // The reader only gives a count for FEWER than all; a count that comes
    // out at every game left is a misreading, not a full commitment.
    expect(fitLateJoinGames(3, 3)).toEqual({ kind: "ask" });
  });

  it("a partial commitment that fits: stored as it is", () => {
    expect(fitLateJoinGames(2, 3)).toEqual({ kind: "some", games: 2 });
    expect(fitLateJoinGames(1, 4)).toEqual({ kind: "some", games: 1 });
  });

  it("a full commitment (no count): every game left", () => {
    expect(fitLateJoinGames(null, 3)).toEqual({ kind: "all" });
  });

  it("one game left: any count is asked about", () => {
    expect(fitLateJoinGames(1, 1)).toEqual({ kind: "ask" });
  });
});

const CTX: MonthlyReaderContext = {
  orgId: "org-vets",
  members: [
    { ref: "p1", userId: "u-davide", name: "Davide De Souza", aliases: [], organiser: true },
    { ref: "p2", userId: "u-will", name: "Will Frost", aliases: [], organiser: false },
  ],
  months: [
    monthHeadLine({
      label: "November 2026",
      monthNumber: 11,
      state: "under way",
      games: [
        { day: "Mon 2 Nov", played: true },
        { day: "Mon 9 Nov", played: true },
        { day: "Mon 16 Nov", played: false },
        { day: "Mon 23 Nov", played: false },
        { day: "Mon 30 Nov", played: false },
      ],
    }),
  ],
  lists: [{ label: "November 2026", userIds: ["u-davide"] }],
  week: null,
};
const input = (userId: string, name: string): MonthlyReaderInput => ({
  body: "I'm in for November except the last week",
  sender: { userId, name, organiser: false },
  history: [],
  reply: null,
  now: new Date("2026-11-12T12:00:00Z"),
});

describe("the reader's context: the games left, with their dates, and whether the sender is on the month", () => {
  it("a month's line names the games still to play and their dates", () => {
    expect(CTX.months[0]).toBe(
      "  November 2026 (month 11): under way. 5 games: Mon 2 Nov (played), Mon 9 Nov (played), Mon 16 Nov, Mon 23 Nov, Mon 30 Nov; 3 still to play: Mon 16 Nov, Mon 23 Nov, Mon 30 Nov.",
    );
  });

  it("a month with nothing left says so", () => {
    expect(monthHeadLine({ label: "October 2026", monthNumber: 10, state: "under way", games: [{ day: "Mon 26 Oct", played: true }] })).toBe(
      "  October 2026 (month 10): under way. 1 game: Mon 26 Oct (played); none still to play.",
    );
  });

  it("the sender not on the month yet is told as a fact; one on it too", () => {
    expect(buildMonthlyReaderUserTurn(input("u-will", "Will Frost"), CTX)).toContain("The sender is not on the November 2026 list yet.");
    expect(buildMonthlyReaderUserTurn(input("u-davide", "Davide De Souza"), CTX)).toContain("The sender is on the November 2026 list.");
  });

  it("a sender who is nobody of the club gets no such line", () => {
    const turn = buildMonthlyReaderUserTurn(input("u-nobody", "Stranger"), CTX);
    expect(turn).not.toContain("The sender is");
  });
});

describe("the prompt counts a late joiner's games against the games left", () => {
  it("defines the games count ONCE, for a sign-up and a list line alike", () => {
    expect(MONTHLY_READER_SYSTEM).toContain("HOW MANY GAMES");
    expect(MONTHLY_READER_SYSTEM.match(/HOW MANY GAMES/g)!.length).toBeGreaterThanOrEqual(2);
    // The old wording counted every joiner against the month's total.
    expect(MONTHLY_READER_SYSTEM).not.toContain('"except the last week" of five is 4; "4 games" is 4), else 0.');
  });

  it("teaches a late joiner and an early joiner side by side, English and Turkish", () => {
    expect(MONTHLY_READER_SYSTEM).toContain("still to play");
    expect(MONTHLY_READER_SYSTEM).toContain("son hafta hariç");
    expect(MONTHLY_READER_SYSTEM).toContain("sadece iki maç");
    expect(MONTHLY_READER_SYSTEM).toMatch(/not the 23rd/);
  });

  it("stays above Haiku 5.5's cacheable minimum, with no long dashes", () => {
    expect(MONTHLY_READER_SYSTEM.length / 4).toBeGreaterThan(512);
    expect(MONTHLY_READER_SYSTEM).not.toMatch(/[–—]/);
  });
});

describe("the one DM question: which of the games left will he play (English and Turkish)", () => {
  it("English", () => {
    expect(t("en").msu_dm_join_which({ month: "November", games: 3, dates: ["Mon 16 Nov", "Mon 23 Nov", "Mon 30 Nov"] })).toBe(
      "📋 November has 3 games left: Mon 16 Nov, Mon 23 Nov and Mon 30 Nov. Which of them will you play? Reply and I'll put you on the list for those.",
    );
    expect(t("en").msu_dm_join_which({ month: "November", games: 1, dates: ["Mon 30 Nov"] })).toBe(
      "📋 November has 1 game left: Mon 30 Nov. Will you play it? Reply and I'll put you on the list for it.",
    );
  });

  it("Turkish", () => {
    expect(t("tr").msu_dm_join_which({ month: "Kasım", games: 3, dates: ["16 Kasım Pazartesi", "23 Kasım Pazartesi", "30 Kasım Pazartesi"] })).toBe(
      "📋 Kasım ayında 3 maç kaldı: 16 Kasım Pazartesi, 23 Kasım Pazartesi ve 30 Kasım Pazartesi. Hangilerinde oynayacaksın? Yanıt ver, seni o maçlar için listeye ekleyeyim.",
    );
    expect(t("tr").msu_dm_join_which({ month: "Kasım", games: 1, dates: ["30 Kasım Pazartesi"] })).toBe(
      "📋 Kasım ayında 1 maç kaldı: 30 Kasım Pazartesi. Oynayacak mısın? Yanıt ver, seni o maç için listeye ekleyeyim.",
    );
  });
});
