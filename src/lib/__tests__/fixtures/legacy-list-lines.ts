/**
 * TEST FIXTURE ONLY (2026-10-30): the list-line helpers of the deleted
 * `src/lib/pasted-roster.ts`, kept for `monthly-legacy.ts` (the legacy
 * monthly list reader the unit tests and the e2e stub build lists with).
 * Production reads every pasted list with a model; no file under src/
 * outside the tests may import this (`players-group-no-parsing.source.test.ts`).
 */
import { normaliseName } from "../../name-normalise";

export interface RosterEntry {
  /** Slot number as written; null for a bulleted entry. */
  slot: number | null;
  /** The line with its numbering removed, otherwise untouched. */
  raw: string;
  /** Cleaned display name. Empty when the slot held no usable name —
   *  a blank slot, or an `@lid` / phone / raw-id wire-format token. */
  name: string;
  /** Does it read like a person's name (short, has letters, not an id)?
   *  Used to keep instruction lists and leaderboards out. */
  nameLike: boolean;
}

export interface PastedRoster {
  /** The playing block, in slot order. Blank slots are KEPT (their
   *  position is information: 2026-06-10 left slot 14 empty after a
   *  drop-out) but carry `name: ""`. */
  entries: RosterEntry[];
  /** A `Reserves:` / `Subs:` / `Standby:` block, if the message has one. */
  reserves: RosterEntry[];
  /** Names under any OTHER header that ends the playing list: "Paid but
   *  can't play", "Out", "Injured", a forwarded "Waiting list (2):".
   *  They are in the message, so `rosterMentions` still sees them, but
   *  they are not playing names and are never `entries` or `names`. */
  notPlaying: RosterEntry[];
  /** Non-empty playing names, in slot order. Duplicates are KEPT —
   *  "Adam" appearing twice is a fact about the message. */
  names: string[];
}

/** Four list lines. Three is a paragraph with numbers in it; four is a
 *  list. Every real paste in the corpus is 5–14 lines. */
const MIN_LIST_LINES = 4;
/** …and at least three of them must read like a person's name, so a
 *  numbered instruction list ("1. add Kieran to the squad") and a stats
 *  leaderboard ("1. Adam — 4/4 (100%)") are not mistaken for rosters. */
const MIN_NAME_LIKE = 3;

/** Zero-width and word-joiner characters WhatsApp leaves behind when a
 *  list is copied and re-pasted. Same set `normaliseName` folds. */
const INVISIBLE = /[​-‏‪-‮⁠﻿]/g;

/** Emoji, pictographs, variation selectors, keycap combiners. */
const DECORATION =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{20E3}\u{2190}-\u{21FF}\u{2B05}-\u{2B07}]/gu;

/** `1.` `1)` `1 -` `1:` `01.` — the numbering styles that occur. */
const NUMBERED = /^(\d{1,2})\s*[.)\-–—:]\s*(.*)$/;
/** `1️⃣` and friends: digit + optional VS16 + combining enclosing keycap. */
const EMOJI_DIGIT = /^((?:\d️?⃣\s*)+)(.*)$/u;
/** `-` `*` `•` `·` `–` as a bullet, which requires a following space so
 *  a hyphenated fragment is not mistaken for one. */
const BULLET = /^[-*•·–]\s+(.*)$/;

const RESERVE_HEADER = /^\s*(reserves?|subs?|substitutes?|standby|stand-by)\b\s*:?\s*$/i;

/**
 * A header for players who are NOT playing: "Paid but can't play",
 * "Can't play", "Out", "Injured", "Gelemeyenler", "Ödedi gelemiyor".
 * Tested against the FOLDED header (see `foldHeader`): lower case, no
 * accents, no apostrophes, punctuation as spaces.
 *
 * Whole-line and fixed-vocabulary on purpose. "I'm out" or "who is out
 * this week?" is a sentence, not a header, and does not match.
 */
const CANT_PLAY_HEADER = new RegExp(
  "^(?:" +
    // English, with an optional "paid but" / "paid and" / "paid" lead.
    "(?:paid )?(?:but |and )?(?:cant|can not|cannot) (?:play|make it|come)" +
    "|outs?|injured|unavailable|not playing|not available|dropped(?: out)?|drop ?outs?" +
    // Turkish: "gelemeyenler", "ödedi (ama) gelemiyor", "oynamayanlar".
    "|(?:odedi |odeyip |odeyen )?(?:ama )?(?:gelemiyor|gelemeyen|gelemeyenler)" +
    "|oynamayanlar|sakatlar" +
    ")$",
);

function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, " ");
}

/** Fold a header line for vocabulary matching: accents, case, emoji,
 *  WhatsApp bold/italic marks, apostrophes, a trailing "(3)" count and
 *  all punctuation go. "*Paid but can’t play (2):*" → "paid but cant play". */
function foldHeader(line: string): string {
  return normaliseName(stripInvisible(line).replace(DECORATION, " "))
    .replace(/['’‘`´]/g, "")
    .replace(/\(\s*\d+\s*\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Is this line a "these players are not playing" header? */
export function isCantPlayHeader(line: string): boolean {
  return CANT_PLAY_HEADER.test(foldHeader(line));
}

/** Is this token a WhatsApp wire-format id rather than a name?
 *  `@158055467598020`, `189206211076115@lid`, `447700900123@c.us`,
 *  `+44 7700 900123`. Mirrors `isRawDigitName` in the analyze route —
 *  S28 (Izzet/Elnur, a5a150a) is the reason it must never become a name. */
function isWireId(s: string): boolean {
  const cleaned = s
    .trim()
    .replace(/@(lid|c\.us|s\.whatsapp\.net)$/i, "")
    .replace(/[@\s+().-]/g, "");
  return cleaned.length > 0 && /^\d{5,}$/.test(cleaned);
}

export function cleanName(raw: string): string {
  let s = stripInvisible(raw);
  // A trailing note: "(GK)", "- maybe late", "— 4/4 (100%)".
  s = s.replace(/\s*[(（][^)）]*[)）]\s*$/u, "");
  s = s.replace(/\s+[-–—]\s+.*$/u, "");
  s = s.replace(DECORATION, " ");
  s = s.replace(/^\s*~+\s*/, ""); // WhatsApp pushname prefix
  s = s.replace(/^\s*@\s*/, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s || isWireId(s)) return "";
  return s;
}

/** A stats/leaderboard row — "Adam — 4/4 (100%)", "Amir — 12 pts",
 *  "Martin — 3 votes". `cleanName` strips the tail and would leave a
 *  perfectly good-looking name behind, so the tail is tested on the RAW
 *  line. Mirrors `isLeaderboardLine` in message-analyzer.ts, which
 *  exists for the same reason: a leaderboard is an ANSWER, not a squad. */
function hasStatsTail(raw: string): boolean {
  return /\d+\s*\/\s*\d+|\d+\s*%|\b\d+\s*(pts?|points?|votes?|wins?|goals?|apps?)\b|\bmom\b/i.test(
    raw,
  );
}

function looksLikeAName(name: string): boolean {
  if (!name) return false;
  if (name.length > 32) return false;
  if (name.split(" ").length > 4) return false;
  if (/[?!;]/.test(name)) return false;
  if (/\d/.test(name)) return false; // "4/4", "100%", a slot repeated
  return /\p{L}/u.test(name);
}

export interface ListLine {
  slot: number | null;
  raw: string;
}

export type RosterSection = "playing" | "reserves" | "cantPlay" | "other";

export interface RosterSections {
  playing: ListLine[];
  reserves: ListLine[];
  /** Under a recognised not-playing header (`isCantPlayHeader`). */
  cantPlay: ListLine[];
  /** Under an unrecognised header where the numbering started again. */
  other: ListLine[];
  /** Every non-blank line that is not a list line, in message order:
   *  the title above the list, the section headers, any prose. */
  proseLines: string[];
}

export function readListLine(line: string): ListLine | null {
  const t = stripInvisible(line).trim();
  if (!t) return null;

  const emoji = EMOJI_DIGIT.exec(t);
  if (emoji) {
    const digits = emoji[1].replace(/[^\d]/g, "");
    return { slot: digits ? Number(digits) : null, raw: emoji[2] };
  }
  const numbered = NUMBERED.exec(t);
  if (numbered) return { slot: Number(numbered[1]), raw: numbered[2] };
  const bullet = BULLET.exec(t);
  if (bullet) return { slot: null, raw: bullet[1] };
  return null;
}

function toEntry(l: ListLine): RosterEntry {
  const name = cleanName(l.raw);
  return {
    slot: l.slot,
    raw: l.raw,
    name,
    nameLike: looksLikeAName(name) && !hasStatsTail(l.raw),
  };
}

/**
 * Split a message into its list sections. Pure, and the ONE place that
 * decides which list lines are the playing list, so the pasted-roster
 * parser and the monthly list reader (`monthly-list.ts`) cannot drift.
 *
 * A list line belongs to the playing list until a header says otherwise.
 * Three kinds of header end it:
 *
 *  1. A reserves header (`RESERVE_HEADER`), exactly as before.
 *  2. A not-playing header (`isCantPlayHeader`) BELOW a list: "Paid but
 *     can't play", "Out", "Injured". Whatever the numbering does. Above
 *     the first list line it is not a header: "Can't make it" typed over
 *     a pasted squad is the sender speaking.
 *  3. ANY other non-list line, but only when the numbering under it
 *     STARTS AGAIN (the next numbered line is at or below the last
 *     number of the section above). "Waiting list (2):" then "1. …" is a
 *     new section. A remark followed by "13. Zair" is the same list
 *     carrying on, and stays in it: that is the forwarded-roster shape
 *     S26 registers from, and it must keep working.
 *
 * Before 2026-10-05 only (1) existed, so the lines under "Paid but can't
 * play" were read as playing names (monthly squad plan, section 0).
 *
 * The change is one-directional by construction: a list line can leave
 * `playing` (or `reserves`), never join it. Once a section ends, nothing
 * returns to it.
 */
export function splitRosterSections(body: string): RosterSections {
  const out: RosterSections = {
    playing: [],
    reserves: [],
    cantPlay: [],
    other: [],
    proseLines: [],
  };
  let section: RosterSection = "playing";
  /** The last NUMBERED slot read in the current section. */
  let lastSlot: number | null = null;
  /** A non-list line has been seen since the last list line. */
  let proseSinceList = false;
  /** Any list line at all has been read, in any section. */
  let seenListLine = false;

  const enter = (next: RosterSection): void => {
    section = next;
    lastSlot = null;
    proseSinceList = false;
  };

  for (const line of body.split(/\r?\n/)) {
    const visible = stripInvisible(line);
    if (RESERVE_HEADER.test(visible)) {
      out.proseLines.push(visible.trim());
      enter("reserves");
      continue;
    }
    const l = readListLine(line);
    if (!l) {
      if (!visible.trim()) continue;
      out.proseLines.push(visible.trim());
      // Only BELOW a list. "Can't make it" typed above a pasted squad is
      // the sender talking, not a header over fourteen names.
      if (seenListLine && isCantPlayHeader(visible)) enter("cantPlay");
      else proseSinceList = true;
      continue;
    }
    if (proseSinceList && l.slot !== null && lastSlot !== null && l.slot <= lastSlot) {
      enter("other");
    }
    proseSinceList = false;
    seenListLine = true;
    if (l.slot !== null) lastSlot = l.slot;
    out[section].push(l);
  }
  return out;
}


function tokens(s: string): string[] {
  return normaliseName(s)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

/** Do these two strings name the same person, by the same rule
 *  `rosterMentions` uses? Exact on the folded name, or an equal first
 *  name. Deliberately not fuzzy — the resolver owns fuzzy matching. */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = tokens(a ?? "");
  const y = tokens(b ?? "");
  if (x.length === 0 || y.length === 0) return false;
  if (x.join(" ") === y.join(" ")) return true;
  return x[0].length >= 2 && y[0].length >= 2 && x[0] === y[0];
}
