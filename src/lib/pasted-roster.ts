/**
 * Pasted-roster parsing — deterministic, pure, no model.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 * PR #35's self-replay sweep measured the current analyzer against
 * ITSELF: same message, same reconstructed world, same model, twice.
 * Three of the four write-level disagreements were one message shape —
 * a pasted numbered roster registering a DIFFERENT SUBSET of names on
 * each run (2026-06-07: `Nabeel` vs `Adam, Amir, Ehtisham, Martin`).
 * The 18,315-token analyzer prompt says nothing at all about a pasted
 * list, so the model improvises which of the fourteen lines are
 * registrations, and improvisation is not reproducible.
 *
 * Splitting `"1. Ehtisham\n2. Amir\n…"` into names is parsing, not
 * language understanding — §3.2 family B, "should be deterministic
 * code". This module is that code. It reports the SHAPE of a message;
 * it decides nothing. The analyze route uses it to clamp the model's
 * list-derived picks (see `api/whatsapp/analyze/route.ts`).
 *
 * ── What it deliberately does NOT do ─────────────────────────────────
 * It cannot tell a squad from a shopping list without a dictionary, and
 * it does not try. `1. milk / 2. bread / 3. eggs / 4. rice` is reported
 * as list-shaped, and that is fine: the clamp built on top can only
 * ever REMOVE a write, and no shopping-list item matches a player name.
 * The classification error is therefore one-directional and safe.
 *
 * It also does not derive a squad. Turning a series of pasted lists into
 * attendance requires the PREVIOUS list to diff against, plus sender
 * attribution and alias learning — that is `lib/squad-from-list.ts`,
 * which runs on a cron behind the `featureSquadFromList` org flag. The
 * analyze route has none of that state, which is exactly why it must
 * not guess.
 */
import { normaliseName } from "./squad-from-list";

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

function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, " ");
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

function cleanName(raw: string): string {
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

interface ListLine {
  slot: number | null;
  raw: string;
}

function readListLine(line: string): ListLine | null {
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
 * Parse a message body as a pasted roster, or return null if it is not
 * list-shaped. Pure: same string in, same object out, always.
 */
export function parsePastedRoster(body: string | null | undefined): PastedRoster | null {
  if (!body) return null;

  const playing: RosterEntry[] = [];
  const reserves: RosterEntry[] = [];
  let inReserves = false;

  for (const line of body.split(/\r?\n/)) {
    if (RESERVE_HEADER.test(stripInvisible(line))) {
      inReserves = true;
      continue;
    }
    const l = readListLine(line);
    if (!l) continue;
    (inReserves ? reserves : playing).push(toEntry(l));
  }

  const all = [...playing, ...reserves];
  if (all.length < MIN_LIST_LINES) return null;
  if (all.filter((e) => e.nameLike).length < MIN_NAME_LIKE) return null;

  return {
    entries: playing,
    reserves,
    names: playing.filter((e) => e.name).map((e) => e.name),
  };
}

/** Convenience predicate — the shape only. */
export function isPastedRoster(body: string | null | undefined): boolean {
  return parsePastedRoster(body) !== null;
}

/** `normaliseName` folds case, accents and invisible characters; this
 *  also folds the punctuation a handle carries, so the list's
 *  "Yusuf.i" and the model's "Yusuf" are comparable. Observed on
 *  2026-06-10: the model paraphrased the slot and the write slipped the
 *  clamp, provisioning a ghost member named "Yusuf". */
function tokens(s: string): string[] {
  return normaliseName(s)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

/**
 * Does `candidate` name one of this roster's slots?
 *
 * Deliberately NOT fuzzy. Exact on the normalised name, plus first-token
 * equality in both directions so the list's "Ehtisham" matches the
 * member record's "Ehtisham Ul Haq". A token must be at least two
 * characters, so a single initial can never sweep up a slot.
 *
 * Everything a substring match would add is over-reach in the direction
 * that removes writes the model was right about.
 */
export function rosterMentions(
  roster: PastedRoster,
  candidate: string | null | undefined,
): boolean {
  const c = tokens(candidate ?? "");
  if (c.length === 0) return false;

  for (const entry of [...roster.entries, ...roster.reserves]) {
    if (!entry.name) continue;
    const e = tokens(entry.name);
    if (e.length === 0) continue;
    if (e.join(" ") === c.join(" ")) return true;
    // First names must MATCH, not merely share a prefix: "Adam" is a
    // slot, "Adamu" is a different person.
    if (e[0].length >= 2 && c[0].length >= 2 && e[0] === c[0]) return true;
  }
  return false;
}

/** `rosterMentions` over the several names one person is known by
 *  (member record, WhatsApp pushname). Nulls are skipped. */
export function rosterMentionsAny(
  roster: PastedRoster,
  candidates: Array<string | null | undefined>,
): boolean {
  return candidates.some((c) => rosterMentions(roster, c));
}

export type AttendanceAction = "IN" | "OUT" | "BENCH";
export interface RegisterForEntry {
  name: string;
  action: AttendanceAction;
}

export interface RosterClampInput {
  body: string | null | undefined;
  /** Every name this sender is known by — member record, pushname. */
  senderNames: Array<string | null | undefined>;
  registerAttendance: AttendanceAction | null;
  registerFor: RegisterForEntry[] | null;
}

export interface RosterClampResult {
  /** The message was list-shaped, so the clamp looked at it. */
  applied: boolean;
  registerAttendance: AttendanceAction | null;
  registerFor: RegisterForEntry[] | null;
  /** registerFor names removed because they were slots in the list. */
  droppedNames: string[];
  /** The sender's own IN/BENCH was removed because they are a slot. */
  droppedSelf: boolean;
  /** Something was removed AND nothing is left — the message's entire
   *  write set came out of the list, so it decides nothing. */
  silenced: boolean;
}

/**
 * The clamp: a pasted roster registers NOBODY.
 *
 * ── The rule, and why it is this one ──────────────────────────────────
 * A pasted list is a RESTATEMENT of a list, not a registration event.
 * To read a registration out of one you need the PREVIOUS list to diff
 * against — "line 6 is new, and it is the sender's own name" is a
 * registration; "line 6 was already there" is not. The analyze route
 * holds no previous list, so the model was left to guess which lines
 * mattered, and it guessed differently every time: on 2026-06-07 one run
 * wrote `Nabeel`, the other wrote `Adam, Amir, Ehtisham, Martin`, from
 * the same two messages against the same squad. The union was never
 * written by either. A player's place in a squad decided by luck.
 *
 * `lib/squad-from-list.ts` DOES keep that state, does the diff and the
 * sender attribution, and runs behind the `featureSquadFromList` org
 * flag. A group that maintains its squad by re-pasting should have it
 * switched on; the analyze route's job is to stop guessing.
 *
 * ── Two properties worth holding on to ────────────────────────────────
 * **Monotone.** It only ever removes writes. It cannot cause a
 * registration that would not otherwise have happened, which is the
 * direction that matters: wrongly adding someone from a pasted list
 * silently takes a slot from a player who did ask.
 *
 * **Never resurrects a drop.** `registerAttendance: "OUT"` is never
 * touched. Only additions (IN / BENCH) are clamped.
 *
 * `registerFor` entries whose name is NOT in the list survive whatever
 * their direction — prose alongside a paste ("also adding Kieran",
 * "Trevell got injured, he's out") is a real statement, and the list
 * says nothing about it.
 */
export function clampRosterDerivedWrites(input: RosterClampInput): RosterClampResult {
  const unchanged: RosterClampResult = {
    applied: false,
    registerAttendance: input.registerAttendance,
    registerFor: input.registerFor,
    droppedNames: [],
    droppedSelf: false,
    silenced: false,
  };

  const roster = parsePastedRoster(input.body);
  if (!roster) return unchanged;

  const entries = input.registerFor ?? [];
  const kept = entries.filter((e) => !rosterMentions(roster, e.name));
  const droppedNames = entries.filter((e) => rosterMentions(roster, e.name)).map((e) => e.name);

  const selfIsASlot = rosterMentionsAny(roster, input.senderNames);
  const droppedSelf =
    selfIsASlot &&
    (input.registerAttendance === "IN" || input.registerAttendance === "BENCH");

  const registerAttendance = droppedSelf ? null : input.registerAttendance;
  const registerFor = kept.length > 0 ? kept : null;
  const removedSomething = droppedSelf || droppedNames.length > 0;

  return {
    applied: true,
    registerAttendance,
    registerFor,
    droppedNames,
    droppedSelf,
    silenced: removedSomething && registerAttendance === null && registerFor === null,
  };
}
