/**
 * A PLAYER'S GAMES COUNT, AGAINST THE GAMES HE COVERS (2026-11-16). The
 * reader is told what the sender (and every regular on a list) covers, and
 * counts a TOTAL against it. Every door gives the count to the one setter,
 * whose ONE FIT RULE (`fitGamesCount`) is never a question: at or above
 * his cover is every game; from the games he has played up to below his
 * cover is stored as read; below the games played is the games played.
 * When what is stored is not what was said, the organisers are told once.
 *
 * Pure: no database and no model.
 */
import { describe, expect, it } from "vitest";
import { coverFor, fitGamesCount } from "../squad-month-rules";
import { pastedLineOf } from "../month-signup-rules";
import {
  buildMonthlyReaderUserTurn,
  MONTHLY_READER_SYSTEM,
  monthCoversLine,
  monthHeadLine,
  type MonthlyReaderContext,
  type MonthlyReaderInput,
} from "../monthly-reader-prompt";
import { t } from "../i18n/t";

describe("fitGamesCount: the one fit rule, count N against cover C with P played", () => {
  // [what it is, N, C, P, stored, changed]
  const table: Array<[string, number | null, number, number, number | null, boolean]> = [
    ["no count: every game", null, 5, 2, null, false],
    ["N above C: every game, and told", 6, 5, 0, null, true],
    ["N equal to C: every game, nothing to tell", 5, 5, 2, null, false],
    ["a late joiner, 2 of his 3: as read", 2, 3, 0, 2, false],
    ["'4 only' of a full month, 2 played: as read", 4, 5, 2, 4, false],
    ["Rex: '3 games, that's me done' with 3 played: 3", 3, 5, 3, 3, false],
    ["N equal to P below C: as read", 2, 5, 2, 2, false],
    ["N below P: the games played, and told", 1, 5, 2, 2, true],
    ["N below P, P equal to C: every game, and told", 2, 3, 3, null, true],
    ["one game covered, 'just the one': every game", 1, 1, 0, null, false],
    ["a row covering none: every game (nothing to charge), and told", 2, 0, 0, null, true],
    ["Mia '2 games' with 1 played of 5: 2", 2, 5, 1, 2, false],
    ["'3 only' with 1 played of 5: 3", 3, 5, 1, 3, false],
  ];
  for (const [what, N, C, P, stored, changed] of table) {
    it(what, () => {
      expect(fitGamesCount({ count: N, covers: C, played: P })).toEqual({ games: stored, changed });
    });
  }
});

describe("coverFor: the games a row covers, and those still to play", () => {
  const K = [2, 9, 16, 23, 30].map((d) => new Date(Date.UTC(2026, 10, d, 20)));
  const now = new Date(Date.UTC(2026, 10, 12, 12)); // after the 9th
  it("no regular row: the games still to play", () => {
    expect(coverFor({ kickoffs: K, rowCovered: null, now })).toEqual({ covers: 3, remaining: K.slice(2) });
  });

  it("a full-month regular: all five, three still to play", () => {
    expect(coverFor({ kickoffs: K, rowCovered: 5, now })).toEqual({ covers: 5, remaining: K.slice(2) });
  });

  it("a late joiner covering 3: the month's last three", () => {
    expect(coverFor({ kickoffs: K, rowCovered: 3, now })).toEqual({ covers: 3, remaining: K.slice(2) });
  });

  it("a row covering 0: no game at all, never every date", () => {
    expect(coverFor({ kickoffs: K, rowCovered: 0, now })).toEqual({ covers: 0, remaining: [] });
  });

  it("a cover above the games scheduled (a week cancelled since): only the games there are", () => {
    const four = K.slice(0, 4);
    expect(coverFor({ kickoffs: four, rowCovered: 5, now })).toEqual({ covers: 4, remaining: four.slice(2) });
  });
});

describe("pastedLineOf: the organisers' line quotes his own line of a paste", () => {
  const body = "November\n1. Davide\n7. Dan except the last week\n8. Mo";
  it("his line, found by the name read on it", () => {
    expect(pastedLineOf(body, { name: "Dan" })).toBe("7. Dan except the last week");
  });
  it("no line has the name: the name itself; no name: the whole message", () => {
    expect(pastedLineOf(body, { name: "Zak" })).toBe("Zak");
    expect(pastedLineOf(body, null)).toBe(body);
  });
});

describe("the organisers' line when the fit rule changed a count (English and Turkish)", () => {
  const p = { name: "Dan", month: "November", said: 6, covers: 3, played: 1, stored: 3, words: "Dan 6 games" };
  it("English", () => {
    expect(t("en").msu_admin_games_fitted(p)).toBe(
      `📋 Dan said 6 games of November ("Dan 6 games") but covers 3 (played 1); I recorded 3. Change it on the month page if that's wrong.`,
    );
    expect(t("en").msu_admin_games_fitted({ ...p, said: 1, words: "" })).toBe(
      "📋 Dan said 1 game of November but covers 3 (played 1); I recorded 3. Change it on the month page if that's wrong.",
    );
  });
  it("Turkish", () => {
    expect(t("tr").msu_admin_games_fitted(p)).toBe(
      `📋 Dan, November için 6 maç dedi ("Dan 6 games"), ama 3 maçı kapsıyor (1 maç oynadı); 3 olarak kaydettim. Yanlışsa ay sayfasından değiştir.`,
    );
  });
  it("no long dashes", () => {
    expect(t("en").msu_admin_games_fitted(p) + t("tr").msu_admin_games_fitted(p)).not.toMatch(/[–—]/);
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

  it("a sender who is nobody of the club gets no such line", () => {
    expect(buildMonthlyReaderUserTurn(input("u-nobody", "Stranger"), CTX)).not.toContain("THE SENDER COVERS");
  });

  it("a regular whose row covers 0 games covers no game, never every date", () => {
    const zero: MonthlyReaderContext = { ...CTX, cover: [{ label: "November 2026", games: NOV, regulars: [{ userId: "u-will", covered: 0 }] }] };
    const turn = buildMonthlyReaderUserTurn(input("u-will", "Will Frost"), zero);
    expect(turn).toContain("THE SENDER COVERS in November 2026: no game (a regular on its list).");
  });

  it("a cover above the games scheduled (a week cancelled since): the games there are", () => {
    const over: MonthlyReaderContext = { ...CTX, cover: [{ label: "November 2026", games: NOV.slice(0, 4), regulars: [{ userId: "u-will", covered: 5 }] }] };
    expect(buildMonthlyReaderUserTurn(input("u-will", "Will Frost"), over)).toContain(
      "THE SENDER COVERS in November 2026: 4 games, Mon 2 Nov (played), Mon 9 Nov (played), Mon 16 Nov, Mon 23 Nov (a regular on its list).",
    );
  });

  it("every regular's cover is on the month, so an organiser's line about him is counted against HIS games", () => {
    expect(
      monthCoversLine([
        { name: "Davide De Souza", ref: "p1", covered: 5 },
        { name: "Lee Late", ref: "p3", covered: 3 },
      ]),
    ).toBe("  Games each regular on it covers: Davide De Souza (p1) 5, Lee Late (p3) 3.");
    expect(monthCoversLine([])).toBeNull();
  });
});

describe("the prompt counts every games count against the games he covers", () => {
  it("defines the games count ONCE, around the games he covers", () => {
    expect(MONTHLY_READER_SYSTEM).toContain("HOW MANY GAMES");
    expect(MONTHLY_READER_SYSTEM).toContain("THE SENDER COVERS");
    // The old wording counted every joiner against the month's total.
    expect(MONTHLY_READER_SYSTEM).not.toContain('"except the last week" of five is 4; "4 games" is 4), else 0.');
  });

  it("teaches a joiner, a pay-as-you-go player becoming a regular and a late regular, English and Turkish", () => {
    expect(MONTHLY_READER_SYSTEM).toContain("son hafta hariç");
    expect(MONTHLY_READER_SYSTEM).toContain("sadece iki maç");
    expect(MONTHLY_READER_SYSTEM).toMatch(/not the 23rd/);
    expect(MONTHLY_READER_SYSTEM).toMatch(/pay-as-you-go player becoming a regular/);
  });

  it("has nothing of a question about his games: a bare 'yes' is a sign-up only as main has it", () => {
    expect(MONTHLY_READER_SYSTEM).not.toMatch(/only in a DM/);
    expect(MONTHLY_READER_SYSTEM).not.toMatch(/a plain "yes" or "ok"/);
    expect(MONTHLY_READER_SYSTEM).not.toMatch(/which games he will play/);
  });

  it("an organiser's line about somebody else counts against that person's own games", () => {
    expect(MONTHLY_READER_SYSTEM).toContain("Games each regular on it covers");
  });

  it("stays above Haiku 5.5's cacheable minimum, with no long dashes", () => {
    expect(MONTHLY_READER_SYSTEM.length / 4).toBeGreaterThan(512);
    expect(MONTHLY_READER_SYSTEM).not.toMatch(/[–—]/);
  });
});
