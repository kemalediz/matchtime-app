/**
 * WHOSE NUMBER IS WHOSE: mapping a result message's facts onto Red and
 * Yellow (2026-10-07). Pure: no DB, no clock, no model.
 *
 * The score extractor reports what the message says about teams
 * VERBATIM (`ScoreFacts`). This file turns that into `{ red, yellow }`
 * using the club's own team names, or says it cannot.
 *
 * WHY THE MODEL DOES NOT DO THIS. It does not know what this club calls
 * its teams (`team-labels.ts`: a club, or a single match, can rename
 * them), and which side is "Red" is a fact in the database, not in the
 * message. Until 2026-10-06 nobody did it at all: the engine put the
 * first number on Red, and "9-6 to yellows" was recorded Red 9.
 *
 * THE RULE WHEN NOTHING SAYS: ASK. Two different numbers with no team
 * ("10-7") used to be recorded Red first. That is not a convention this
 * product ever told anybody: the bot's own question is "What was the
 * final score?", and of the club's reports before the incident nearly
 * every one with a winner named the team ("5-4 to Yellows"). A guess
 * that is wrong half the time, announced as "recorded", is worse than
 * one short question. A draw needs no team and is never asked about.
 *
 * ── TWO KINDS OF STATEMENT, AND THEY ARE NOT EQUALLY STRONG ──────────
 * (review of PR #214, item 5)
 *
 *   OUTCOME   a word says who won or lost: "to yellows", "yellow wins",
 *             "kazandı", "we lost". `winner` / `loser`. Strong.
 *   POSITION  a team name written beside a number, and nothing else.
 *             `firstTeam` / `secondTeam`.
 *
 * BOTH numbers labelled ("Yellow 9 - 6 Red") is strong: it is the
 * result, spelled out. ONE name beside one number is not. "Reds 3-5" is
 * as likely the sender's own score first as it is a Red win written
 * backwards, so a lone name is believed only when it sits beside the
 * HIGHER number ("yellow 9-6"), and only when no outcome word says
 * otherwise. Beside the lower number with no such word, the bot asks.
 * The extractor reports where the name was written; whether that is
 * enough is decided here, not by the model.
 *
 * ── NAMES ARE WHOLE WORDS (item 7) ───────────────────────────────────
 * A reference names a team when its words ARE the team's words, give or
 * take an ending this file knows: an English plural or possessive, a
 * Turkish plural, a Turkish case ending. Never a prefix: "Reda's team",
 * "Reddy" and "yel" name nobody. See `wordIs`.
 *
 * ── COLOURS BELONG TO A SIDE ONLY WHILE IT IS CALLED BY ITS COLOUR ───
 * "yellows" means the YELLOW side when that side is called Yellow or
 * Sarı. Once a club calls its sides Blue and White, or Lions and Tigers,
 * "yellow" is neither team's name and is asked about. (The first version
 * mapped it anyway, on the theory that the bibs are still yellow. Nobody
 * knows what colour the Tigers wear.)
 */
import type { ScoreFacts } from "./types";

export type TeamSide = "RED" | "YELLOW";

export type ScoreResolution =
  | { kind: "resolved"; red: number; yellow: number }
  | {
      kind: "ask";
      /** `no_team`: the message names nobody. `unknown_team`: it names
       *  somebody who is neither side (or "we" from a sender who was on
       *  neither). `conflict`: it says two things that cannot both hold.
       *  `lone_lower`: one team name beside the lower number and no word
       *  saying who won. */
      why: "no_team" | "unknown_team" | "conflict" | "lone_lower";
    };

const other = (t: TeamSide): TeamSide => (t === "RED" ? "YELLOW" : "RED");

/** Lower case, Turkish letters folded to ASCII, everything that is not a
 *  letter or digit removed. "Sarılar" and "SARILAR" and "sarilar" agree. */
function fold(s: string): string {
  return s
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const SELF = new Set(["us", "we", "our", "ours", "biz", "bizim", "bizimkiler"]);
const THEM = new Set(["them", "they", "their", "theirs", "onlar", "onlarin"]);

/** Words people put around a team name that are not part of it. */
const FILLER = new Set(["the", "team", "side", "lot", "lads", "boys", "takim", "takimi", "takimin"]);

/** Folded. The colour each side is, in both languages the product speaks. */
const COLOUR: Record<TeamSide, { en: string; tr: string }> = {
  RED: { en: "red", tr: "kirmizi" },
  YELLOW: { en: "yellow", tr: "sari" },
};

/** Turkish case endings, folded (so ı and i, ü and u are one). */
const TR_CASE = new Set([
  "i", "u", "e", "a", "yi", "yu", "ye", "ya", "in", "un", "nin", "nun",
  "de", "da", "te", "ta", "den", "dan", "ten", "tan", "le", "la", "yle", "yla",
]);

/** Is `ending` a Turkish plural, optionally with a case ending after it? */
function isTurkishPlural(ending: string): boolean {
  const m = /^l[ae]r(.*)$/.exec(ending);
  return !!m && (m[1] === "" || TR_CASE.has(m[1]));
}

/**
 * Is `word` the name-word `name`, give or take a known ending?
 *
 *   exact                         "yellow", "sarı"
 *   English plural                "yellows", "reds"
 *   singular of a plural name     "tiger" for "Tigers"
 *   Turkish plural (+ case)       "sarılar", "Kartalların", "sarılardan"
 *   anything after an apostrophe  "yellow's", "Kartal'a", "Aslan'dan",
 *                                 as long as it is one of the above
 *                                 endings or a Turkish case ending
 *   a bare Turkish case ending    ONLY on the Turkish colour words
 *                                 (`trNoun`): "sarıya", "kırmızıdan".
 *                                 A proper name takes its case ending
 *                                 after an apostrophe in Turkish, and
 *                                 allowing it bare is how "Reda" would
 *                                 become "Red" + "a".
 */
function wordIs(rawWord: string, name: string, trNoun: boolean): boolean {
  if (!name) return false;
  const cut = rawWord.search(/['’]/);
  const stem = fold(cut === -1 ? rawWord : rawWord.slice(0, cut));
  const after = cut === -1 ? "" : fold(rawWord.slice(cut + 1));
  if (after && !(after === "s" || TR_CASE.has(after) || isTurkishPlural(after))) return false;
  if (stem === name) return true;
  if (name.endsWith("s") && stem === name.slice(0, -1) && stem.length >= 3) return true;
  if (!stem.startsWith(name)) return false;
  const ending = stem.slice(name.length);
  if (ending === "s" || ending === "es") return true;
  if (isTurkishPlural(ending)) return true;
  return trNoun && TR_CASE.has(ending);
}

/** The words of a reference or a label, as written, minus filler. */
function words(s: string): string[] {
  const all = s.split(/[^\p{L}\p{N}'’]+/u).filter(Boolean);
  const kept = all.filter((w) => !FILLER.has(fold(w)));
  return kept;
}

/**
 * How well do the reference's words name this label? 2: all of the
 * label's words, in order. 1: a run of them ("submarines" for "Yellow
 * Submarines"). 0: no.
 */
function labelMatch(ref: string[], label: string): 0 | 1 | 2 {
  const allWords = label.split(/[^\p{L}\p{N}'’]+/u).filter(Boolean);
  const stripped = allWords.filter((w) => !FILLER.has(fold(w)));
  const names = (stripped.length > 0 ? stripped : allWords).map(fold);
  if (ref.length === 0 || names.length === 0 || ref.length > names.length) return 0;
  for (let at = 0; at + ref.length <= names.length; at++) {
    if (ref.every((w, i) => wordIs(w, names[at + i], false))) {
      return ref.length === names.length ? 2 : 1;
    }
  }
  return 0;
}

/** Is this side still called by its colour (in either language)? */
function calledByItsColour(label: string, side: TeamSide): boolean {
  const f = fold(label);
  return f === COLOUR[side].en || f === COLOUR[side].tr;
}

function colourMatch(ref: string[], side: TeamSide): boolean {
  if (ref.length !== 1) return false;
  return wordIs(ref[0], COLOUR[side].en, false) || wordIs(ref[0], COLOUR[side].tr, true);
}

/**
 * Which side does this reference mean? null when it means neither, or
 * could mean both.
 *
 * Order: the sender's own side ("us" / "them"), then the club's names
 * for its teams, then the colour words for a side still called by its
 * colour.
 */
export function resolveTeamRef(
  ref: string | undefined | null,
  labels: readonly [string, string],
  senderTeam: TeamSide | null,
): TeamSide | null {
  const raw = (ref ?? "").trim();
  if (!raw) return null;
  const folded = fold(raw);
  if (SELF.has(folded)) return senderTeam;
  if (THEM.has(folded)) return senderTeam ? other(senderTeam) : null;

  const w = words(raw);
  if (w.length === 0) return null;

  const red = labelMatch(w, labels[0]);
  const yellow = labelMatch(w, labels[1]);
  if (red !== yellow) return red > yellow ? "RED" : "YELLOW";
  if (red > 0) return null; // both, equally: ambiguous

  const cRed = calledByItsColour(labels[0], "RED") && colourMatch(w, "RED");
  const cYellow = calledByItsColour(labels[1], "YELLOW") && colourMatch(w, "YELLOW");
  if (cRed !== cYellow) return cRed ? "RED" : "YELLOW";
  return null;
}

/**
 * Who won, from the OUTCOME words alone (`winner` / `loser`). For a
 * message with no numbers: an answer to "which team won?", or "wrong
 * way round, yellows won". null when nobody is named, a name is
 * nobody's, or the two disagree.
 */
export function resolveWinnerSide(args: {
  facts: ScoreFacts;
  labels: readonly [string, string];
  senderTeam: TeamSide | null;
}): TeamSide | null {
  const { facts, labels, senderTeam } = args;
  const says = new Set<TeamSide>();
  let unknown = false;
  if ((facts.winner ?? "").trim()) {
    const s = resolveTeamRef(facts.winner, labels, senderTeam);
    if (s) says.add(s);
    else unknown = true;
  }
  if ((facts.loser ?? "").trim()) {
    const s = resolveTeamRef(facts.loser, labels, senderTeam);
    if (s) says.add(other(s));
    else unknown = true;
  }
  if (unknown || says.size !== 1) return null;
  return [...says][0];
}

/**
 * Map the facts onto `{ red, yellow }`. The caller has checked that the
 * message HAS two numbers (`first` and `second` are not null) and that
 * they are in range.
 */
export function resolveScoreResult(args: {
  facts: ScoreFacts & { first: number; second: number };
  /** The PLAYED match's display names, [red, yellow]. */
  labels: readonly [string, string];
  /** The sender's side in that match, or null. */
  senderTeam: TeamSide | null;
}): ScoreResolution {
  const { facts, labels, senderTeam } = args;
  const { first, second } = facts;
  // A draw is the same whoever is Red.
  if (first === second) return { kind: "resolved", red: first, yellow: second };

  const hi = Math.max(first, second);
  const lo = Math.min(first, second);
  const has = (v: string | undefined) => !!(v ?? "").trim();
  let named = 0;
  let unknown = 0;
  /** Red's score according to each STRONG statement that resolved. */
  const redSays = new Set<number>();

  const strong = (ref: string | undefined, ifRed: number, ifYellow: number) => {
    if (!has(ref)) return;
    named++;
    const side = resolveTeamRef(ref, labels, senderTeam);
    if (!side) {
      unknown++;
      return;
    }
    redSays.add(side === "RED" ? ifRed : ifYellow);
  };

  strong(facts.winner, hi, lo); // this team has the bigger number
  strong(facts.loser, lo, hi); // this team has the smaller number

  const bothLabelled = has(facts.firstTeam) && has(facts.secondTeam);
  if (bothLabelled) {
    strong(facts.firstTeam, first, second); // first is this team's
    strong(facts.secondTeam, second, first); // second is this team's
  }

  if (redSays.size > 1) return { kind: "ask", why: "conflict" };
  if (redSays.size === 1) {
    const red = [...redSays][0];
    // A LONE name beside one number is too weak to decide a result, but
    // not too weak to CONTRADICT one: "Red 9-6, yellows won" names Red
    // beside the higher number and says Yellow won. Ask. (The same team
    // named twice, "5-3 to Yellows" with "Yellows" also reported beside
    // the 3, is one statement and an accident of word order, and the
    // other team beside the LOWER number simply agrees.)
    if (!bothLabelled && (has(facts.firstTeam) || has(facts.secondTeam))) {
      const isFirst = has(facts.firstTeam);
      const side = resolveTeamRef(isFirst ? facts.firstTeam : facts.secondTeam, labels, senderTeam);
      const besideHigher = (isFirst ? first : second) === hi;
      const winnerSide: TeamSide = red === hi ? "RED" : "YELLOW";
      if (side && besideHigher && side !== winnerSide) return { kind: "ask", why: "conflict" };
    }
    return { kind: "resolved", red, yellow: red === first ? second : first };
  }

  // No strong statement resolved. A LONE name beside one number?
  if (!bothLabelled && (has(facts.firstTeam) || has(facts.secondTeam))) {
    named++;
    const isFirst = has(facts.firstTeam);
    const side = resolveTeamRef(isFirst ? facts.firstTeam : facts.secondTeam, labels, senderTeam);
    if (!side) {
      unknown++;
    } else {
      const theirs = isFirst ? first : second;
      if (theirs !== hi) return { kind: "ask", why: "lone_lower" };
      const red = side === "RED" ? hi : lo;
      return { kind: "resolved", red, yellow: red === first ? second : first };
    }
  }

  return { kind: "ask", why: named > 0 && unknown > 0 ? "unknown_team" : "no_team" };
}
