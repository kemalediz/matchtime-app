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
import { commitmentFromAnswer, commitmentFromCount, coverFor, fitGamesCommitted } from "../squad-month-rules";
import {
  buildMonthlyReaderUserTurn,
  MONTHLY_READER_SYSTEM,
  monthCoversLine,
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

describe("fitGamesCommitted: a regular cannot commit to fewer games than he has already played", () => {
  it("a full-month regular who has played 2 typing '1 game': does not fit, asked", () => {
    expect(fitGamesCommitted(1, 5, 2)).toEqual({ kind: "ask" });
  });

  it("more than the games played and below his cover: fits", () => {
    expect(fitGamesCommitted(3, 5, 2)).toEqual({ kind: "some", games: 3 });
    expect(fitGamesCommitted(4, 5, 2)).toEqual({ kind: "some", games: 4 });
  });

  it("exactly the games played, with games left: no game still to play in it, so asked", () => {
    expect(fitGamesCommitted(2, 5, 2)).toEqual({ kind: "ask" });
  });

  it("no count is every game, whatever he has played", () => {
    expect(fitGamesCommitted(null, 5, 2)).toEqual({ kind: "all" });
  });
});

describe("one rule for the games behind him: a count against his cover as read; an answer about the games left plus the games actually played", () => {
  const K = [2, 9, 16, 23, 30].map((d) => new Date(Date.UTC(2026, 10, d, 20)));
  const afterThird = new Date(Date.UTC(2026, 10, 18, 12)); // three behind him, two still to play
  const afterSecond = new Date(Date.UTC(2026, 10, 12, 12)); // two behind him, three still to play

  it("Mia types '2 games', Max answers 'just the last one' (5-game month, 3 behind, 1 actually played): both store 2", () => {
    const cover = coverFor({ kickoffs: K, rowCovered: 5, now: afterThird });
    const mia = commitmentFromCount({ count: 2, cover, played: 1 });
    const max = commitmentFromAnswer({ answer: 1, listed: cover.remaining.length, played: 1, covers: 5 });
    expect(mia).toEqual({ kind: "some", games: 2 });
    expect(max).toEqual(mia);
  });

  it("'3 only' with 2 covered games behind him and 1 actually played: 3, as read", () => {
    expect(commitmentFromCount({ count: 3, cover: coverFor({ kickoffs: K, rowCovered: 5, now: afterSecond }), played: 1 })).toEqual({ kind: "some", games: 3 });
  });

  it("'except the last week' of his 5 is 4, as read", () => {
    expect(commitmentFromCount({ count: 4, cover: coverFor({ kickoffs: K, rowCovered: 5, now: afterSecond }), played: 2 })).toEqual({ kind: "some", games: 4 });
  });

  it("a count no higher than the games he has actually played, games still left: asked", () => {
    const cover = coverFor({ kickoffs: K, rowCovered: 5, now: afterSecond });
    expect(commitmentFromCount({ count: 2, cover, played: 2 })).toEqual({ kind: "ask" });
    expect(commitmentFromCount({ count: 1, cover, played: 2 })).toEqual({ kind: "ask" });
    expect(commitmentFromAnswer({ answer: 0, listed: 3, played: 2, covers: 5 })).toEqual({ kind: "ask" });
  });

  it("every game still to play is every game; at or above his cover is asked about", () => {
    expect(commitmentFromAnswer({ answer: 3, listed: 3, played: 1, covers: 5 })).toEqual({ kind: "ask" });
    expect(commitmentFromAnswer({ answer: null, listed: 3, played: 1, covers: 5 })).toEqual({ kind: "all" });
    expect(commitmentFromCount({ count: 5, cover: coverFor({ kickoffs: K, rowCovered: 5, now: afterSecond }), played: 2 })).toEqual({ kind: "ask" });
  });

  it("a non-regular covers only the games still to play: his count is from now on, nothing added", () => {
    const joiner = coverFor({ kickoffs: K, rowCovered: null, now: afterSecond });
    expect(commitmentFromCount({ count: 2, cover: joiner, played: 0 })).toEqual({ kind: "some", games: 2 });
  });

  it("games played beyond his cover (a guest before he joined) cannot be stored: asked", () => {
    expect(commitmentFromAnswer({ answer: 1, listed: 2, played: 2, covers: 2 })).toEqual({ kind: "ask" });
  });
});


describe("coverFor: the games he covers, those still to play, and those behind him", () => {
  const K = [2, 9, 16, 23, 30].map((d) => new Date(Date.UTC(2026, 10, d, 20)));
  const now = new Date(Date.UTC(2026, 10, 12, 12)); // after the 9th
  it("not on the month as a regular: the games still to play, none behind him", () => {
    expect(coverFor({ kickoffs: K, rowCovered: null, now })).toEqual({ covers: 3, remaining: K.slice(2), pastCovered: 0, fromRow: false });
  });

  it("a full-month regular: all five, three still to play, two behind him", () => {
    expect(coverFor({ kickoffs: K, rowCovered: 5, now })).toEqual({ covers: 5, remaining: K.slice(2), pastCovered: 2, fromRow: true });
  });

  it("a late joiner covering 3: the month's last three, none behind him", () => {
    expect(coverFor({ kickoffs: K, rowCovered: 3, now })).toEqual({ covers: 3, remaining: K.slice(2), pastCovered: 0, fromRow: true });
  });

  it("a row covering 0: no game at all, never every date", () => {
    expect(coverFor({ kickoffs: K, rowCovered: 0, now })).toEqual({ covers: 0, remaining: [], pastCovered: 0, fromRow: true });
  });

  it("a cover above the games scheduled (a week cancelled since): only the games there are", () => {
    const four = K.slice(0, 4);
    expect(coverFor({ kickoffs: four, rowCovered: 5, now })).toEqual({ covers: 4, remaining: four.slice(2), pastCovered: 2, fromRow: true });
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

  it("a DM answering MatchTime's question says so; a group message does not", () => {
    expect(buildMonthlyReaderUserTurn(input("u-will", "Will Frost", { dm: true }), CTX)).toContain("THE MESSAGE is his DM to MatchTime, answering its question above.");
    expect(buildMonthlyReaderUserTurn(input("u-will", "Will Frost"), CTX)).not.toContain("his DM to MatchTime");
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

  it("a bare 'yes' is a sign-up only as his DM answer to MatchTime's own question", () => {
    expect(MONTHLY_READER_SYSTEM).toMatch(/only in a DM/);
    expect(MONTHLY_READER_SYSTEM).toMatch(/in the group a bare "yes" is not a sign-up/);
  });

  it("an organiser's line about somebody else counts against that person's own games", () => {
    expect(MONTHLY_READER_SYSTEM).toContain("Games each regular on it covers");
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
    expect(t("en").msu_dm_games_which({ month: "November", games: 3, played: 0, dates: ["Mon 16 Nov", "Mon 23 Nov", "Mon 30 Nov"] })).toBe(
      "📋 You're on the November list for 3 games: Mon 16 Nov, Mon 23 Nov and Mon 30 Nov. Which of them will you play? Reply and I'll note it.",
    );
    expect(t("tr").msu_dm_games_which({ month: "Kasım", games: 3, played: 0, dates: ["16 Kasım Pazartesi", "23 Kasım Pazartesi", "30 Kasım Pazartesi"] })).toBe(
      "📋 Kasım listesinde 3 maç için varsın: 16 Kasım Pazartesi, 23 Kasım Pazartesi ve 30 Kasım Pazartesi. Hangilerinde oynayacaksın? Yanıt ver, not edeyim.",
    );
  });

  it("a full-month regular with games behind him: only the games still to play are listed, with how many are played", () => {
    expect(t("en").msu_dm_games_which({ month: "November", games: 5, played: 2, dates: ["Mon 16 Nov", "Mon 23 Nov", "Mon 30 Nov"] })).toBe(
      "📋 You're on the November list for 5 games, 2 played already. 3 are left: Mon 16 Nov, Mon 23 Nov and Mon 30 Nov. Which of them will you play? Reply and I'll note it.",
    );
    expect(t("tr").msu_dm_games_which({ month: "Kasım", games: 5, played: 2, dates: ["16 Kasım Pazartesi", "23 Kasım Pazartesi", "30 Kasım Pazartesi"] })).toBe(
      "📋 Kasım listesinde 5 maç için varsın, 2 maç oynandı. Kalan 3 maç: 16 Kasım Pazartesi, 23 Kasım Pazartesi ve 30 Kasım Pazartesi. Hangilerinde oynayacaksın? Yanıt ver, not edeyim.",
    );
  });

  it("the organisers' one line when a count can be neither recorded nor asked about", () => {
    expect(t("en").msu_admin_games_unrecorded({ name: "Mo Many", month: "November", words: "in for November bar the last" })).toBe(
      `I couldn't record Mo Many's November games from "in for November bar the last". Set them on the month page.`,
    );
    expect(t("tr").msu_admin_games_unrecorded({ name: "Mo Many", month: "Kasım", words: "Kasım varım son hafta hariç" })).toBe(
      `Mo Many için Kasım maçlarını "Kasım varım son hafta hariç" mesajından kaydedemedim. Ay sayfasından ayarla.`,
    );
  });

  it("the organisers' line when a question about his games expired unanswered", () => {
    expect(t("en").msu_admin_games_unanswered({ name: "Exa Expired", month: "November" })).toBe("Exa Expired didn't say which November games; set them on the month page.");
    expect(t("tr").msu_admin_games_unanswered({ name: "Exa Expired", month: "Kasım" })).toBe(
      "Exa Expired hangi Kasım maçlarında oynayacağını söylemedi; ay sayfasından ayarla.",
    );
  });

  it("a leaver who paid and comes back is asked as rejoining: the games he paid for, then the games left", () => {
    expect(t("en").msu_dm_rejoin_which({ month: "November", paid: 2, claimed: false, dates: ["Mon 16 Nov", "Mon 23 Nov", "Mon 30 Nov"] })).toBe(
      "📋 You're rejoining November: you paid for 2 games. 3 are left: Mon 16 Nov, Mon 23 Nov and Mon 30 Nov. Which of them will you play? Reply and I'll put you back on the list for those.",
    );
    expect(t("en").msu_dm_rejoin_which({ month: "November", paid: 2, claimed: true, dates: ["Mon 30 Nov"] })).toBe(
      "📋 You're rejoining November: you say you paid for 2 games. 1 is left: Mon 30 Nov. Will you play it? Reply and I'll put you back on the list for it.",
    );
    expect(t("tr").msu_dm_rejoin_which({ month: "Kasım", paid: 2, claimed: false, dates: ["16 Kasım Pazartesi", "23 Kasım Pazartesi", "30 Kasım Pazartesi"] })).toBe(
      "📋 Kasım ayına geri dönüyorsun: 2 maçın ücretini ödedin. Kalan 3 maç: 16 Kasım Pazartesi, 23 Kasım Pazartesi ve 30 Kasım Pazartesi. Hangilerinde oynayacaksın? Yanıt ver, seni o maçlar için listeye geri ekleyeyim.",
    );
    expect(t("tr").msu_dm_rejoin_which({ month: "Kasım", paid: 2, claimed: true, dates: ["30 Kasım Pazartesi"] })).toBe(
      "📋 Kasım ayına geri dönüyorsun: 2 maçın ücretini ödediğini söyledin. Kalan 1 maç: 30 Kasım Pazartesi. Oynayacak mısın? Yanıt ver, seni o maç için listeye geri ekleyeyim.",
    );
  });

  it("for somebody not on the month, the organisers' lines say to ADD him", () => {
    expect(t("en").msu_admin_games_unrecorded_add({ name: "Zak", month: "November", words: "3. Zak 4 only" })).toBe(
      `I couldn't record Zak's November games from "3. Zak 4 only". Add him on the month page.`,
    );
    expect(t("tr").msu_admin_games_unrecorded_add({ name: "Zak", month: "Kasım", words: "3. Zak 4 only" })).toBe(
      `Zak için Kasım maçlarını "3. Zak 4 only" mesajından kaydedemedim. Ay sayfasından onu ekle.`,
    );
    expect(t("en").msu_admin_games_unanswered_add({ name: "Zak", month: "November" })).toBe("Zak didn't say which November games; add him on the month page.");
    expect(t("tr").msu_admin_games_unanswered_add({ name: "Zak", month: "Kasım" })).toBe("Zak hangi Kasım maçlarında oynayacağını söylemedi; ay sayfasından onu ekle.");
  });

  it("an organiser's add held for the player's answer: a short line back to him", () => {
    expect(t("en").mwk_month_add_held({ name: "Zak", asked: true })).toBe("Zak isn't on the list yet: I've asked him which games he'll play.");
    expect(t("en").mwk_month_add_held({ name: "Zak", asked: false })).toBe("Zak isn't on the list yet: I couldn't ask him which games he'll play, so add him on the month page.");
    expect(t("tr").mwk_month_add_held({ name: "Zak", asked: true })).toBe("Zak henüz listede değil: hangi maçlarda oynayacağını kendisine sordum.");
    expect(t("tr").mwk_month_add_held({ name: "Zak", asked: false })).toBe("Zak henüz listede değil: hangi maçlarda oynayacağını soramadım, ay sayfasından onu ekle.");
  });
});
