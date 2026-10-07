/**
 * THE SCORE EXTRACTOR'S LIVE CHECK: the cases (2026-10-07, rewritten the
 * same day after the review of PR #214).
 *
 * The score extractor prompt was rewritten whole, twice, so the live
 * check has to cover EVERY behaviour the old prompt handled as well as
 * the new ones (CLAUDE.md, "rewrite a prompt"). The first block is the
 * club's own history: the ways Sutton FC has reported a result since
 * April 2026, read from `AnalyzedMessage`.
 *
 * Each case says what must come OUT of the pipeline for that message: a
 * recorded result, the bot asking which team won, the bot saying what is
 * already recorded, or nothing at all. It is graded by running the
 * extracted facts through the real ENGINE (`runScoreCase`), so a case
 * passes on the outcome, not on the wording of a team field.
 *
 * `facts` is what a correct extraction looks like;
 * `score-live-cases.test.ts` proves, for free, that those facts produce
 * the stated outcome, so the plan is self-consistent before a penny is
 * spent.
 *
 * `scripts/live-check-score-extractor.ts` runs each case ONCE against
 * the real model. IT NEEDS KEMAL'S APPROVAL, EVERY TIME (CLAUDE.md).
 * Nothing in this file calls a model.
 *
 * Not a `.test.ts`, so vitest does not collect it; it sits here because
 * it builds its world from the engine suite's `helpers.ts`.
 */
import { decide } from "../engine";
import type { ScoreFacts, SquadState } from "../types";
import { NOW, msg, world } from "./helpers";

export type ScoreCaseOutcome =
  /** A result is written. */
  | { red: number; yellow: number }
  /** The bot asks which team won. */
  | "ask"
  /** The bot says what is recorded (and how to correct it, or that an
   *  admin can), or asks for the score. Nothing is written. */
  | "told"
  /** Nothing written, nothing said. */
  | "silent";

export interface ScoreLiveCase {
  id: string;
  /** What the case is there to prove. */
  why: string;
  body: string;
  tagged?: boolean;
  /** Who sends it. "red" is Kemal (an admin, on Red); "yellow" is Najib
   *  (a player, on Yellow). Default "red". */
  sender?: "red" | "yellow";
  /** [red, yellow]. Default ["Red", "Yellow"]. */
  labels?: [string, string];
  /** MatchTime's last post, as the extractor is shown it. */
  lastBotPost?: string;
  /** The result already recorded for the match, if any. */
  recorded?: { red: number; yellow: number };
  /** A scoreline the bot has asked about and is waiting on, a minute
   *  ago. `askedBy` is who posted it (default "red", i.e. the sender of
   *  a default case, so an untagged answer from them counts). */
  pending?: { first: number; second: number; askedBy?: "red" | "yellow" };
  /** A correct extraction. `first`/`second` null when the message has no
   *  scoreline. Team wording may differ live ("Yellows" for "yellows"). */
  facts: Omit<ScoreFacts, "kind">;
  expect: ScoreCaseOutcome;
  /** In production the answer to an open question is read WITHOUT the
   *  model (`score-ask.ts`). The case still checks what the extractor
   *  would say, for the times the router sends it there anyway. */
  noModelInProduction?: true;
  /** The router may reasonably call it something other than `score`. */
  anyRoute?: true;
}

const ASK_SCORE =
  "🏁 *Tuesday 7-a-side*: hope it was a good one. What was the final score? I'll use it to keep next week's teams balanced.";
const WRONG_ACK = "Got it 👍 *Red* won 9 - 6 against Yellow. Recorded.";
const WHICH_TEAM = "10 - 7: which team won? Reply with the winning team: Red or Yellow.";
const R96 = { red: 9, yellow: 6 };
const TR: [string, string] = ["Kırmızı", "Sarı"];

const n = (first: number, second: number, over: Partial<ScoreFacts> = {}) => ({ first, second, ...over });
const none = (over: Partial<ScoreFacts> = {}) => ({ first: null, second: null, ...over });

export const SCORE_LIVE_CASES: ScoreLiveCase[] = [
  // ── What the old prompt handled: the club's real reports ───────────
  { id: "H1", why: "history: 'to <team>', winner written second", body: "5-3 to Yellows", lastBotPost: ASK_SCORE, facts: n(5, 3, { winner: "Yellows" }), expect: { red: 3, yellow: 5 } },
  { id: "H2", why: "history: 'to reds'", body: "5-4 to reds", lastBotPost: ASK_SCORE, facts: n(5, 4, { winner: "reds" }), expect: { red: 5, yellow: 4 } },
  { id: "H3", why: "history: tagged, large numbers", body: "15-12 to Reds @Match Time", tagged: true, facts: n(15, 12, { winner: "Reds" }), expect: { red: 15, yellow: 12 } },
  { id: "H4", why: "history: the winner's number written SECOND", body: "4-6 to Yellows", facts: n(4, 6, { winner: "Yellows" }), expect: { red: 4, yellow: 6 } },
  { id: "H5", why: "history: '<team> wins' after the score", body: "6-5 Yellow wins", facts: n(6, 5, { winner: "Yellow" }), expect: { red: 5, yellow: 6 } },
  { id: "H6", why: "history: singular team word", body: "9-6 to yellow", facts: n(9, 6, { winner: "yellow" }), expect: { red: 6, yellow: 9 } },
  { id: "H7", why: "history: a draw, bare", body: "7-7", lastBotPost: ASK_SCORE, facts: n(7, 7), expect: { red: 7, yellow: 7 } },
  { id: "H8", why: "history: a draw in a sentence", body: "Final score was 8-8", facts: n(8, 8), expect: { red: 8, yellow: 8 } },
  { id: "H9", why: "history: a score with a winner and NO TEAM is asked about", body: "10-7 :))", facts: n(10, 7), expect: "ask" },
  { id: "H10", why: "the unit suites' canonical message", body: "Red won 5-3", facts: n(5, 3, { winner: "Red" }), expect: { red: 5, yellow: 3 } },

  // ── The incident ───────────────────────────────────────────────────
  { id: "I1", why: "2026-10-06 message 1: a story with two scorelines, the final one counts", body: "it was 6-6 until 15 minutes then suddenly it turned to 9-6 to yellows. Let's see if you can understand this @Match Time", tagged: true, facts: n(9, 6, { winner: "yellows" }), expect: { red: 6, yellow: 9 } },
  { id: "I2", why: "2026-10-06 message 2: the correction that was dropped", body: "@Match Time no Yellow 9 - 6 Red", tagged: true, recorded: R96, lastBotPost: WRONG_ACK, facts: n(9, 6, { firstTeam: "Yellow", secondTeam: "Red", correction: true }), expect: { red: 6, yellow: 9 } },

  // ── A team beside each number, and the sender's own side ───────────
  { id: "N1", why: "each number labelled", body: "Red 6 Yellow 9", facts: n(6, 9, { firstTeam: "Red", secondTeam: "Yellow" }), expect: { red: 6, yellow: 9 } },
  { id: "N2", why: "'we won' from a Yellow player", body: "we won 5-3", sender: "yellow", facts: n(5, 3, { winner: "us" }), expect: { red: 3, yellow: 5 } },
  { id: "N3", why: "'lost' from a Red player, own number first", body: "lost 3-5", facts: n(3, 5, { loser: "us" }), expect: { red: 3, yellow: 5 } },
  { id: "N4", why: "a named winner (a word not in the prompt) and the sender as loser", body: "reds battered us 7-2", sender: "yellow", facts: n(7, 2, { winner: "reds", loser: "us" }), expect: { red: 7, yellow: 2 } },
  { id: "N5", why: "a club that renamed its teams", body: "4-2 to the Tigers", labels: ["Lions", "Tigers"], facts: n(4, 2, { winner: "the Tigers" }), expect: { red: 2, yellow: 4 } },

  // ── A LONE team name: position is reported, code decides (item 5) ──
  { id: "L1", why: "a lone name beside the LOWER number and no winning word: ask, never a Red win", body: "Reds 3-5", facts: n(3, 5, { firstTeam: "Reds" }), expect: "ask" },
  { id: "L2", why: "a lone name beside the HIGHER number is that team's win", body: "yellow 9-6", facts: n(9, 6, { firstTeam: "yellow" }), expect: { red: 6, yellow: 9 } },

  // ── Corrections ────────────────────────────────────────────────────
  { id: "C1", why: "a TAGGED correction with no team is told how to correct it: no question about a recorded match", body: "@Match Time no it was 9-7", tagged: true, recorded: R96, lastBotPost: WRONG_ACK, facts: n(9, 7, { correction: true }), expect: "told" },
  { id: "C4", why: "H2: an UNTAGGED correction changes nothing and says nothing, even from an admin", body: "no Yellow 9 - 6 Red", recorded: R96, lastBotPost: WRONG_ACK, facts: n(9, 6, { firstTeam: "Yellow", secondTeam: "Red", correction: true }), expect: "silent", anyRoute: true },
  { id: "C5", why: "H2: 'no, reds won 3-1' about another club's match, untagged: nothing", body: "no, reds won 3-1", sender: "yellow", recorded: R96, facts: n(3, 1, { winner: "reds", correction: true }), expect: "silent", anyRoute: true },
  { id: "C2", why: "a correcting draw", body: "@Match Time wrong, it finished 9-9", tagged: true, recorded: R96, lastBotPost: WRONG_ACK, facts: n(9, 9, { correction: true }), expect: { red: 9, yellow: 9 } },
  { id: "C3", why: "a first report is NOT a correction even right after the bot asked", body: "9-6 to yellows", lastBotPost: ASK_SCORE, facts: n(9, 6, { winner: "yellows" }), expect: { red: 6, yellow: 9 } },

  // ── A correction with NO NUMBERS (item 3) ──────────────────────────
  { id: "X1", why: "numberless correction naming the winner swaps the recorded result", body: "@Match Time wrong way round, yellows won", tagged: true, recorded: R96, lastBotPost: WRONG_ACK, facts: none({ correction: true, swapped: true, winner: "yellows" }), expect: { red: 6, yellow: 9 } },
  { id: "X2", why: "the same, with nobody named", body: "@Match Time other way round", tagged: true, recorded: R96, lastBotPost: WRONG_ACK, facts: none({ correction: true, swapped: true }), expect: { red: 6, yellow: 9 } },
  { id: "X3", why: "NO NUMBERS IS NOT 0-0: a numberless message on an unscored match writes nothing", body: "yellows won", lastBotPost: ASK_SCORE, facts: none({ winner: "yellows" }), expect: "silent", anyRoute: true },
  { id: "X4", why: "told who won and not the score, tagged, nothing recorded: asked for the score", body: "@Match Time yellows won", tagged: true, lastBotPost: ASK_SCORE, facts: none({ winner: "yellows" }), expect: "told", anyRoute: true },
  { id: "X5", why: "M1: no numbers in the text means no score, whatever the model returns (it must not come back as 0-0)", body: "good game lads, well played", lastBotPost: ASK_SCORE, facts: none(), expect: "silent", anyRoute: true },

  // ── A tag is not a correction; another game is not this one (item 6)
  { id: "G1", why: "a tagged score that is not a correction never replaces the record", body: "@Match Time it was 9-2 to yellow", tagged: true, sender: "yellow", recorded: R96, facts: n(9, 2, { winner: "yellow" }), expect: "told" },
  { id: "G2", why: "a tagged score about ANOTHER game changes nothing", body: "@Match Time last week we lost 9-2", tagged: true, sender: "yellow", recorded: R96, facts: n(9, 2, { loser: "us", otherGame: true }), expect: "silent", anyRoute: true },
  { id: "G3", why: "...and is not recorded against an unscored match either", body: "@Match Time last week we lost 9-2", tagged: true, sender: "yellow", facts: n(9, 2, { loser: "us", otherGame: true }), expect: "silent", anyRoute: true },

  // ── The one-word answer to the bot's question (item 4) ─────────────
  { id: "A1", why: "a bare team name answering 'which team won?'", body: "Yellow", pending: { first: 10, second: 7 }, lastBotPost: WHICH_TEAM, facts: none({ winner: "Yellow" }), expect: { red: 7, yellow: 10 }, noModelInProduction: true },
  { id: "A2", why: "the answer as two words, from the person who posted the scoreline", body: "reds won", pending: { first: 10, second: 7 }, lastBotPost: WHICH_TEAM, facts: none({ winner: "reds" }), expect: { red: 10, yellow: 7 }, noModelInProduction: true },
  { id: "A3", why: "M2: the same words from ANOTHER player, untagged, complete nothing", body: "reds won", sender: "yellow", pending: { first: 10, second: 7 }, lastBotPost: WHICH_TEAM, facts: none({ winner: "reds" }), expect: "silent", anyRoute: true },
  { id: "A5", why: "third review: the asker's CHATTER that names a winner completes nothing, whatever the model reports", body: "yellow bibs stink mate, reds deserved it anyway", pending: { first: 10, second: 7 }, lastBotPost: WHICH_TEAM, facts: none({ winner: "reds" }), expect: "silent", anyRoute: true },
  { id: "A6", why: "third review: the pair restated with one team is the answer", body: "Yellow 7-10", pending: { first: 10, second: 7 }, lastBotPost: WHICH_TEAM, facts: n(7, 10, { firstTeam: "Yellow" }), expect: { red: 7, yellow: 10 } },
  { id: "M1", why: "third review: numbers that are not a score (a kickoff time) must not be recorded, whatever comes back", body: "good game lads, same time next week 21:30", lastBotPost: ASK_SCORE, facts: none(), expect: "silent", anyRoute: true },
  { id: "A4", why: "M2: a question mark is not an answer", body: "Yellow?", pending: { first: 10, second: 7 }, lastBotPost: WHICH_TEAM, facts: none({ winner: "Yellow" }), expect: "silent", anyRoute: true },

  // ── Turkish ────────────────────────────────────────────────────────
  { id: "T1", why: "Turkish: winner named", body: "sarılar 9-6 kazandı", labels: TR, facts: n(9, 6, { winner: "sarılar" }), expect: { red: 6, yellow: 9 } },
  { id: "T2", why: "Turkish: each number labelled", body: "kırmızı 6 sarı 9", labels: TR, facts: n(6, 9, { firstTeam: "kırmızı", secondTeam: "sarı" }), expect: { red: 6, yellow: 9 } },
  { id: "T3", why: "Turkish: 'we won' is in the verb", body: "5-3 kazandık", labels: TR, facts: n(5, 3, { winner: "us" }), expect: { red: 5, yellow: 3 } },
  { id: "T4", why: "Turkish: 'we lost'", body: "3-5 kaybettik", labels: TR, sender: "yellow", facts: n(3, 5, { loser: "us" }), expect: { red: 5, yellow: 3 } },
  { id: "T5", why: "Turkish: a draw", body: "7-7 berabere", labels: TR, facts: n(7, 7), expect: { red: 7, yellow: 7 } },
  { id: "T6", why: "Turkish: a correction", body: "@Match Time yanlış, kırmızı 6 sarı 9", tagged: true, labels: TR, recorded: R96, lastBotPost: "Tamam 👍 *Kırmızı* 9 - 6 kazandı, rakip Sarı. Kaydettim.", facts: n(6, 9, { firstTeam: "kırmızı", secondTeam: "sarı", correction: true }), expect: { red: 6, yellow: 9 } },
  { id: "T7", why: "Turkish: a numberless correction", body: "@Match Time tam tersi, sarılar kazandı", tagged: true, labels: TR, recorded: R96, lastBotPost: "Tamam 👍 *Kırmızı* 9 - 6 kazandı, rakip Sarı. Kaydettim.", facts: none({ correction: true, swapped: true, winner: "sarılar" }), expect: { red: 6, yellow: 9 } },
  { id: "T8", why: "Turkish: a case ending on the team word", body: "9-6 sarıların lehine bitti", labels: TR, facts: n(9, 6, { winner: "sarıların" }), expect: { red: 6, yellow: 9 } },
];

const RED_SIDE = ["kemal", "elvin", "sait"];
const YELLOW_SIDE = ["najib", "mustafa", "wasim"];

/** The world a case is decided in. */
function caseWorld(c: ScoreLiveCase): SquadState {
  const teams = [
    ...RED_SIDE.map((k) => ({ userId: `u-${k}`, team: "RED" as const })),
    ...YELLOW_SIDE.map((k) => ({ userId: `u-${k}`, team: "YELLOW" as const })),
  ];
  return world({
    admins: ["kemal"],
    completedMatch: {
      id: "done-1",
      participantUserIds: teams.map((t) => t.userId),
      teams,
      teamLabels: c.labels ?? ["Red", "Yellow"],
      kickoffAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      redScore: c.recorded?.red ?? null,
      yellowScore: c.recorded?.yellow ?? null,
      ...(c.pending
        ? {
            pendingScore: {
              first: c.pending.first,
              second: c.pending.second,
              askedAt: new Date(NOW.getTime() - 60_000).toISOString(),
              askerUserId: c.pending.askedBy === "yellow" ? "u-najib" : "u-kemal",
            },
          }
        : {}),
    },
  });
}

/**
 * What the pipeline does with `facts` for this case's message: the real
 * engine, over the case's world. `facts` is the case's own (the unit
 * test) or what the live extractor returned (the script).
 */
export function runScoreCase(c: ScoreLiveCase, facts: ScoreFacts): ScoreCaseOutcome {
  const r = decide({
    now: NOW,
    state: caseWorld(c),
    messages: [
      msg({
        id: c.id,
        from: c.sender === "yellow" ? "najib" : "kemal",
        body: c.body,
        tagged: c.tagged ?? false,
        route: "score",
        facts,
      }),
    ],
  });
  const write = r.writes.find((w) => w.kind === "score");
  if (write && write.kind === "score") return { red: write.red, yellow: write.yellow };
  if (r.speech.some((s) => s.kind === "score_ask_team")) return "ask";
  if (
    r.speech.some(
      (s) =>
        s.kind === "score_recorded_hint" ||
        s.kind === "score_already_recorded" ||
        s.kind === "score_which_match" ||
        s.kind === "score_ask_score",
    )
  ) {
    return "told";
  }
  return "silent";
}

export function describeOutcome(o: ScoreCaseOutcome): string {
  return typeof o === "string" ? o : `Red ${o.red}, Yellow ${o.yellow}`;
}
