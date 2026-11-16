/**
 * A PLAYER'S GAMES COUNT, AGAINST THE GAMES HE COVERS (2026-11-16). One
 * rule for everybody: a regular's count is checked against his row's
 * games; anybody joining or becoming a regular now (a newcomer, a
 * pay-as-you-go or bench player, somebody coming back) covers the games
 * still to play. The reader is told what the sender covers, and the code
 * guard (`fitGamesCommitted`) never stores a count that does not fit: he
 * is asked which of the games he covers he will play.
 *
 * Pure: no database and no model.
 */
import { describe, expect, it } from "vitest";
import { fitGamesCommitted, joinerGamesFromAnswer } from "../squad-month-rules";
import {
  buildMonthlyReaderUserTurn,
  MONTHLY_READER_SYSTEM,
  monthHeadLine,
  type MonthlyReaderContext,
  type MonthlyReaderInput,
} from "../monthly-reader-prompt";
import { t } from "../i18n/t";

describe("fitGamesCommitted: a count against the games he covers", () => {
  it("above what he covers: asked, nothing stored", () => {
    // "except the last week" read against a five-game month (4) when he covers 3.
    expect(fitGamesCommitted(4, 3)).toEqual({ kind: "ask" });
  });

  it("equal to what he covers although the reader read a partial commitment: asked, never 'every game'", () => {
    expect(fitGamesCommitted(3, 3)).toEqual({ kind: "ask" });
  });

  it("a partial count that fits: stored as it is", () => {
    expect(fitGamesCommitted(2, 3)).toEqual({ kind: "some", games: 2 });
    expect(fitGamesCommitted(4, 5)).toEqual({ kind: "some", games: 4 });
  });

  it("no count: every game he covers", () => {
    expect(fitGamesCommitted(null, 3)).toEqual({ kind: "all" });
  });

  it("one game covered: a count of 1 is that one game, so every game; anything else is asked", () => {
    expect(fitGamesCommitted(1, 1)).toEqual({ kind: "all" });
    expect(fitGamesCommitted(2, 1)).toEqual({ kind: "ask" });
  });

  it("nothing a count could be: asked", () => {
    expect(fitGamesCommitted(0, 3)).toEqual({ kind: "ask" });
    expect(fitGamesCommitted(1.5, 3)).toEqual({ kind: "ask" });
  });
});

describe("joinerGamesFromAnswer: an answer read against the games the question listed", () => {
  it("no game listed has been played since: the answer as it is", () => {
    expect(joinerGamesFromAnswer({ kind: "some", games: 2 }, 3, 0)).toEqual({ kind: "some", games: 2 });
  });

  it("a listed game played before he answered counts towards his games ('all but the last one' of 3, the first played: 1 more)", () => {
    expect(joinerGamesFromAnswer({ kind: "some", games: 2 }, 3, 1)).toEqual({ kind: "some", games: 1 });
  });

  it("3 of 4 listed, the first played since: 2 of the 3 he now covers", () => {
    expect(joinerGamesFromAnswer({ kind: "some", games: 3 }, 4, 1)).toEqual({ kind: "some", games: 2 });
  });

  it("only games already played: nothing to join", () => {
    expect(joinerGamesFromAnswer({ kind: "some", games: 1 }, 3, 1)).toEqual({ kind: "none" });
  });

  it("every game, or a count that does not fit, passes through", () => {
    expect(joinerGamesFromAnswer({ kind: "all" }, 3, 1)).toEqual({ kind: "all" });
    expect(joinerGamesFromAnswer({ kind: "ask" }, 3, 1)).toEqual({ kind: "ask" });
  });
});

const NOV = [
  { day: "Mon 2 Nov", played: true },
  { day: "Mon 9 Nov", played: true },
  { day: "Mon 16 Nov", played: false },
  { day: "Mon 23 Nov", played: false },
  { day: "Mon 30 Nov", played: false },
];
const CTX: MonthlyReaderContext = {
  orgId: "org-vets",
  members: [
    { ref: "p1", userId: "u-davide", name: "Davide De Souza", aliases: [], organiser: true },
    { ref: "p2", userId: "u-will", name: "Will Frost", aliases: [], organiser: false },
    { ref: "p3", userId: "u-late", name: "Lee Late", aliases: [], organiser: false },
  ],
  months: [monthHeadLine({ label: "November 2026", monthNumber: 11, state: "under way", games: NOV })],
  cover: [
    {
      label: "November 2026",
      games: NOV,
      regulars: [
        { userId: "u-davide", covered: 5 },
        { userId: "u-late", covered: 3 },
      ],
    },
  ],
  week: null,
};
const input = (userId: string, name: string, over: Partial<MonthlyReaderInput> = {}): MonthlyReaderInput => ({
  body: "I'm in for November except the last week",
  sender: { userId, name, organiser: false },
  history: [],
  reply: null,
  now: new Date("2026-11-12T12:00:00Z"),
  ...over,
});

describe("the reader's context: the games still to play, and the games the SENDER covers", () => {
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

  it("somebody who is not a regular on the month covers the games still to play", () => {
    expect(buildMonthlyReaderUserTurn(input("u-will", "Will Frost"), CTX)).toContain(
      "THE SENDER COVERS in November 2026: 3 games, Mon 16 Nov, Mon 23 Nov, Mon 30 Nov (not a regular on its list yet: joining now, the games still to play).",
    );
  });

  it("a regular for the whole month covers its games, those played included", () => {
    expect(buildMonthlyReaderUserTurn(input("u-davide", "Davide De Souza"), CTX)).toContain(
      "THE SENDER COVERS in November 2026: 5 games, Mon 2 Nov (played), Mon 9 Nov (played), Mon 16 Nov, Mon 23 Nov, Mon 30 Nov (a regular on its list).",
    );
  });

  it("a regular who joined late covers his row's games, not the month's", () => {
    expect(buildMonthlyReaderUserTurn(input("u-late", "Lee Late"), CTX)).toContain(
      "THE SENDER COVERS in November 2026: 3 games, Mon 16 Nov, Mon 23 Nov, Mon 30 Nov (a regular on its list).",
    );
  });

  it("nothing left to play: he covers none", () => {
    const done: MonthlyReaderContext = { ...CTX, cover: [{ label: "November 2026", games: NOV.map((g) => ({ ...g, played: true })), regulars: [] }] };
    expect(buildMonthlyReaderUserTurn(input("u-will", "Will Frost"), done)).toContain(
      "THE SENDER COVERS in November 2026: no game (not a regular on its list yet, and no game is left to play).",
    );
  });

  it("an answer to MatchTime's question is counted against the games that question listed", () => {
    const dates = [
      { day: "Mon 9 Nov", played: true },
      { day: "Mon 16 Nov", played: false },
      { day: "Mon 23 Nov", played: false },
    ];
    const turn = buildMonthlyReaderUserTurn(input("u-will", "Will Frost", { answering: { label: "November 2026", dates } }), CTX);
    expect(turn).toContain(
      "THE SENDER COVERS in November 2026: 3 games, Mon 9 Nov (played), Mon 16 Nov, Mon 23 Nov (as MatchTime's question to him listed them; count his answer against these).",
    );
    expect(turn).not.toContain("joining now, the games still to play");
  });

  it("a sender who is nobody of the club gets no such line", () => {
    expect(buildMonthlyReaderUserTurn(input("u-nobody", "Stranger"), CTX)).not.toContain("THE SENDER COVERS");
  });
});

describe("the prompt counts every games count against the games he covers", () => {
  it("defines the games count ONCE, around the games he covers", () => {
    expect(MONTHLY_READER_SYSTEM).toContain("HOW MANY GAMES");
    expect(MONTHLY_READER_SYSTEM).toContain("THE SENDER COVERS");
    // The old wording counted every joiner against the month's total.
    expect(MONTHLY_READER_SYSTEM).not.toContain('"except the last week" of five is 4; "4 games" is 4), else 0.');
  });

  it("teaches a joiner, a pay-as-you-go player becoming a regular, a late regular and the answer to the question, English and Turkish", () => {
    expect(MONTHLY_READER_SYSTEM).toContain("son hafta hariç");
    expect(MONTHLY_READER_SYSTEM).toContain("sadece iki maç");
    expect(MONTHLY_READER_SYSTEM).toMatch(/not the 23rd/);
    expect(MONTHLY_READER_SYSTEM).toMatch(/pay-as-you-go player becoming a regular/);
    expect(MONTHLY_READER_SYSTEM).toMatch(/a plain "yes" or "ok"/);
  });

  it("stays above Haiku 5.5's cacheable minimum, with no long dashes", () => {
    expect(MONTHLY_READER_SYSTEM.length / 4).toBeGreaterThan(512);
    expect(MONTHLY_READER_SYSTEM).not.toMatch(/[–—]/);
  });
});

describe("the one DM question: which of the games he covers will he play (English and Turkish)", () => {
  it("joining: English", () => {
    expect(t("en").msu_dm_join_which({ month: "November", games: 3, dates: ["Mon 16 Nov", "Mon 23 Nov", "Mon 30 Nov"] })).toBe(
      "📋 November has 3 games left: Mon 16 Nov, Mon 23 Nov and Mon 30 Nov. Which of them will you play? Reply and I'll put you on the list for those.",
    );
    expect(t("en").msu_dm_join_which({ month: "November", games: 1, dates: ["Mon 30 Nov"] })).toBe(
      "📋 November has 1 game left: Mon 30 Nov. Will you play it? Reply and I'll put you on the list for it.",
    );
  });

  it("joining: Turkish", () => {
    expect(t("tr").msu_dm_join_which({ month: "Kasım", games: 3, dates: ["16 Kasım Pazartesi", "23 Kasım Pazartesi", "30 Kasım Pazartesi"] })).toBe(
      "📋 Kasım ayında 3 maç kaldı: 16 Kasım Pazartesi, 23 Kasım Pazartesi ve 30 Kasım Pazartesi. Hangilerinde oynayacaksın? Yanıt ver, seni o maçlar için listeye ekleyeyim.",
    );
  });

  it("a regular already on the month: English and Turkish", () => {
    expect(t("en").msu_dm_games_which({ month: "November", games: 3, dates: ["Mon 16 Nov", "Mon 23 Nov", "Mon 30 Nov"] })).toBe(
      "📋 You're on the November list for 3 games: Mon 16 Nov, Mon 23 Nov and Mon 30 Nov. Which of them will you play? Reply and I'll note it.",
    );
    expect(t("tr").msu_dm_games_which({ month: "Kasım", games: 3, dates: ["16 Kasım Pazartesi", "23 Kasım Pazartesi", "30 Kasım Pazartesi"] })).toBe(
      "📋 Kasım listesinde 3 maç için varsın: 16 Kasım Pazartesi, 23 Kasım Pazartesi ve 30 Kasım Pazartesi. Hangilerinde oynayacaksın? Yanıt ver, not edeyim.",
    );
  });
});
