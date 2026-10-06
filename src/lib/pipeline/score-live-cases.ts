/**
 * THE SCORE EXTRACTOR'S LIVE CHECK: the cases (2026-10-07).
 *
 * The score extractor prompt was rewritten whole when it became
 * team-aware, so the live check has to cover EVERY behaviour the old
 * prompt handled as well as the new ones (CLAUDE.md, "rewrite a prompt").
 * The first block is the club's own history: every way Sutton FC has
 * reported a result since April 2026, read from `AnalyzedMessage`.
 *
 * Each case says what must come OUT of the pipeline for that message:
 * the recorded result, or that the bot asks. `facts` is what a correct
 * extraction looks like; `__tests__/score-live-cases.test.ts` proves, for
 * free, that those facts resolve to the stated outcome, so the plan is
 * self-consistent before a penny is spent.
 *
 * `scripts/live-check-score-extractor.ts` runs each case ONCE against
 * the real model. IT NEEDS KEMAL'S APPROVAL, EVERY TIME (CLAUDE.md).
 * Nothing in this file calls a model.
 */
import type { ScoreFacts } from "./types";

export interface ScoreLiveCase {
  id: string;
  /** What the case is there to prove. */
  why: string;
  body: string;
  tagged?: boolean;
  /** The sender's side in the played match. Default: on neither. */
  senderTeam?: "RED" | "YELLOW";
  /** [red, yellow]. Default ["Red", "Yellow"]. */
  labels?: [string, string];
  /** MatchTime's last post, as the extractor is shown it. */
  lastBotPost?: string;
  /** A correct extraction. Team wording may differ live ("Yellows" for
   *  "yellows"); the live check grades the OUTCOME, not these strings. */
  facts: Omit<ScoreFacts, "kind">;
  expect: { red: number; yellow: number } | "ask";
  /** Must the extractor flag it as a correction? Default false. */
  correction?: boolean;
}

const ASK_SCORE =
  "🏁 *Tuesday 7-a-side*: hope it was a good one. What was the final score? I'll use it to keep next week's teams balanced.";
const WRONG_ACK = "Got it 👍 *Red* won 9 - 6 against Yellow. Recorded.";

export const SCORE_LIVE_CASES: ScoreLiveCase[] = [
  // ── What the old prompt handled: the club's real reports ───────────
  { id: "H1", why: "history: 'to <team>', winner written second", body: "5-3 to Yellows", lastBotPost: ASK_SCORE, facts: { first: 5, second: 3, winner: "Yellows" }, expect: { red: 3, yellow: 5 } },
  { id: "H2", why: "history: 'to reds'", body: "5-4 to reds", lastBotPost: ASK_SCORE, facts: { first: 5, second: 4, winner: "reds" }, expect: { red: 5, yellow: 4 } },
  { id: "H3", why: "history: tagged, large numbers", body: "15-12 to Reds @Match Time", tagged: true, facts: { first: 15, second: 12, winner: "Reds" }, expect: { red: 15, yellow: 12 } },
  { id: "H4", why: "history: the winner's number written SECOND", body: "4-6 to Yellows", facts: { first: 4, second: 6, winner: "Yellows" }, expect: { red: 4, yellow: 6 } },
  { id: "H5", why: "history: '<team> wins' after the score", body: "6-5 Yellow wins", facts: { first: 6, second: 5, winner: "Yellow" }, expect: { red: 5, yellow: 6 } },
  { id: "H6", why: "history: singular team word", body: "9-6 to yellow", facts: { first: 9, second: 6, winner: "yellow" }, expect: { red: 6, yellow: 9 } },
  { id: "H7", why: "history: a draw, bare", body: "7-7", lastBotPost: ASK_SCORE, facts: { first: 7, second: 7 }, expect: { red: 7, yellow: 7 } },
  { id: "H8", why: "history: a draw in a sentence", body: "Final score was 8-8", facts: { first: 8, second: 8 }, expect: { red: 8, yellow: 8 } },
  { id: "H9", why: "history: bare scoreline with a winner and no team", body: "10-7 :))", facts: { first: 10, second: 7 }, expect: "ask" },
  { id: "H10", why: "the unit suites' canonical message", body: "Red won 5-3", facts: { first: 5, second: 3, winner: "Red" }, expect: { red: 5, yellow: 3 } },

  // ── The incident ───────────────────────────────────────────────────
  { id: "I1", why: "2026-10-06 message 1: a story with two scorelines, the final one counts", body: "it was 6-6 until 15 minutes then suddenly it turned to 9-6 to yellows. Let's see if you can understand this @Match Time", tagged: true, senderTeam: "RED", facts: { first: 9, second: 6, winner: "yellows" }, expect: { red: 6, yellow: 9 } },
  { id: "I2", why: "2026-10-06 message 2: the correction that was dropped", body: "@Match Time no Yellow 9 - 6 Red", tagged: true, senderTeam: "RED", lastBotPost: WRONG_ACK, facts: { first: 9, second: 6, firstTeam: "Yellow", secondTeam: "Red", correction: true }, expect: { red: 6, yellow: 9 }, correction: true },

  // ── New: a team beside each number, and the sender's own side ──────
  { id: "N1", why: "each number labelled", body: "Red 6 Yellow 9", facts: { first: 6, second: 9, firstTeam: "Red", secondTeam: "Yellow" }, expect: { red: 6, yellow: 9 } },
  { id: "N2", why: "'we won' from a Yellow player", body: "we won 5-3", senderTeam: "YELLOW", facts: { first: 5, second: 3, winner: "us" }, expect: { red: 3, yellow: 5 } },
  { id: "N3", why: "'lost' from a Red player, own number first", body: "lost 3-5", senderTeam: "RED", facts: { first: 3, second: 5, loser: "us" }, expect: { red: 3, yellow: 5 } },
  { id: "N4", why: "a named winner and the sender as loser", body: "reds battered us 7-2", senderTeam: "YELLOW", facts: { first: 7, second: 2, winner: "reds", loser: "us" }, expect: { red: 7, yellow: 2 } },
  { id: "N5", why: "a club that renamed its teams", body: "4-2 to the Tigers", labels: ["Lions", "Tigers"], facts: { first: 4, second: 2, winner: "the Tigers" }, expect: { red: 2, yellow: 4 } },

  // ── New: corrections ───────────────────────────────────────────────
  { id: "C1", why: "a correction with no team must be asked about", body: "no it was 9-7", lastBotPost: WRONG_ACK, facts: { first: 9, second: 7, correction: true }, expect: "ask", correction: true },
  { id: "C2", why: "a correcting draw", body: "@Match Time wrong, it finished 9-9", tagged: true, lastBotPost: WRONG_ACK, facts: { first: 9, second: 9, correction: true }, expect: { red: 9, yellow: 9 }, correction: true },
  { id: "C3", why: "a first report is NOT a correction even right after the bot asked", body: "9-6 to yellows", lastBotPost: ASK_SCORE, facts: { first: 9, second: 6, winner: "yellows" }, expect: { red: 6, yellow: 9 } },

  // ── Turkish ────────────────────────────────────────────────────────
  { id: "T1", why: "Turkish: winner named", body: "sarılar 9-6 kazandı", labels: ["Kırmızı", "Sarı"], facts: { first: 9, second: 6, winner: "sarılar" }, expect: { red: 6, yellow: 9 } },
  { id: "T2", why: "Turkish: each number labelled", body: "kırmızı 6 sarı 9", labels: ["Kırmızı", "Sarı"], facts: { first: 6, second: 9, firstTeam: "kırmızı", secondTeam: "sarı" }, expect: { red: 6, yellow: 9 } },
  { id: "T3", why: "Turkish: 'we won' is in the verb", body: "5-3 kazandık", labels: ["Kırmızı", "Sarı"], senderTeam: "RED", facts: { first: 5, second: 3, winner: "us" }, expect: { red: 5, yellow: 3 } },
  { id: "T4", why: "Turkish: 'we lost'", body: "3-5 kaybettik", labels: ["Kırmızı", "Sarı"], senderTeam: "YELLOW", facts: { first: 3, second: 5, loser: "us" }, expect: { red: 5, yellow: 3 } },
  { id: "T5", why: "Turkish: a draw", body: "7-7 berabere", labels: ["Kırmızı", "Sarı"], facts: { first: 7, second: 7 }, expect: { red: 7, yellow: 7 } },
  { id: "T6", why: "Turkish: a correction", body: "@Match Time yanlış, kırmızı 6 sarı 9", tagged: true, labels: ["Kırmızı", "Sarı"], lastBotPost: "Tamam 👍 *Kırmızı* 9 - 6 kazandı, rakip Sarı. Kaydettim.", facts: { first: 6, second: 9, firstTeam: "kırmızı", secondTeam: "sarı", correction: true }, expect: { red: 6, yellow: 9 }, correction: true },
];
