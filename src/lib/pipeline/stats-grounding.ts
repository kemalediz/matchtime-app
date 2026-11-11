/**
 * THE GROUNDING CHECK on the generic stats answer (2026-09-23).
 *
 * The generic prompt (`stats-generic.ts`) is the one place a model writes
 * stats text for the group. Kemal's rule: every name and every number in
 * its reply must appear in the tables it was given. This is that rule,
 * deterministic and pure. A reply that fails it is MatchTime's own
 * error: the caller says the safe line instead, and never asks the
 * group about it.
 *
 * WHAT IT CHECKS
 *   • every number (digits, "." or "," as the decimal mark) appears in
 *     the supplied tables or in the question itself ("top 5");
 *   • no number is written as a word ("four times", "dört kez"): the
 *     prompt requires digits precisely so the check above can see them;
 *   • every SQUAD MEMBER the reply mentions, by full name or by first
 *     name, is one the tables named. Turkish case suffixes are stripped
 *     first, so "Abid'in" is Abid;
 *   • the model's own NO_ANSWER marker, and an empty reply, fail.
 *
 * WHAT IT CANNOT CHECK, stated: a name that belongs to nobody in the
 * squad ("John") is not caught, because telling an invented name from an
 * ordinary capitalised word ("Team", "Man of the Match", the club's name)
 * is guesswork. The context the model is given holds only visible,
 * top-of-table data, so what it could leak by that route is limited to
 * what it could not have been told.
 */
import { normaliseName } from "../name-normalise";
import type { Member } from "./types";

export interface GroundingContext {
  /** Every squad member the supplied tables name, by full name. */
  names: string[];
  /** Every number printed in the supplied tables, as printed. */
  numbers: string[];
}

export type GroundingResult = { ok: true } | { ok: false; why: string };

const NUMBER = /\d+(?:[.,]\d+)?/g;
const NUMBER_WORDS_EN =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|once|twice)\b/i;
// "on" (ten) is left out: it is also an English word, and a reply in
// English would fail on "tops the table on 7.8".
const NUMBER_WORDS_TR = /(?<!\p{L})(?:iki|üç|dört|beş|altı|yedi|sekiz|dokuz|yirmi|otuz)(?!\p{L})/iu;

const norm = (n: string) => n.replace(",", ".").replace(/^0+(?=\d)/, "");

/** The value of each number word the two checks above look for, for
 *  `numberWords: "check"`. "once" and "twice" are 1 and 2. */
const NUMBER_WORD_VALUE: Record<string, number> = {
  once: 1, twice: 2, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
  iki: 2, üç: 3, dört: 4, beş: 5, altı: 6, yedi: 7, sekiz: 8, dokuz: 9, yirmi: 20, otuz: 30,
};
const NUMBER_WORDS_ALL_EN = new RegExp(NUMBER_WORDS_EN.source, "gi");
const NUMBER_WORDS_ALL_TR = new RegExp(NUMBER_WORDS_TR.source, "giu");

/** Letters-only words of a text, folded, each with any apostrophe suffix
 *  ("Idris'in", "Sait's") removed. */
function words(text: string): string[] {
  return text
    .split(/[^\p{L}'’]+/u)
    .map((w) => w.replace(/['’]\p{L}*$/u, ""))
    .map((w) => normaliseName(w))
    .filter(Boolean);
}

function firstOf(name: string): string {
  return normaliseName(name).split(" ")[0] ?? "";
}

/** PURE. See the header. */
export function groundingCheck(args: {
  reply: string;
  question: string;
  grounding: GroundingContext;
  roster: Member[];
  /**
   * What a number written as a word means for the check (2026-11-11):
   *   "refuse" (default, the generic stats answer) fails the reply, as it
   *            always has: its prompt requires digits;
   *   "check"  (the unified answer) checks the word as the number it
   *            stands for, like a digit. "once a place opens" is 1, and a
   *            1 in the context grounds it; "twelve" with no 12 fails.
   */
  numberWords?: "refuse" | "check";
}): GroundingResult {
  const reply = (args.reply ?? "").trim();
  if (!reply) return { ok: false, why: "the reply is empty" };
  if (/\bNO_ANSWER\b/.test(reply)) return { ok: false, why: "the model said the tables do not answer it" };

  const allowedNumbers = new Set([...args.grounding.numbers, ...(args.question.match(NUMBER) ?? [])].map(norm));

  if (args.numberWords === "check") {
    for (const w of [...(reply.match(NUMBER_WORDS_ALL_EN) ?? []), ...(reply.match(NUMBER_WORDS_ALL_TR) ?? [])]) {
      const value = NUMBER_WORD_VALUE[w.toLocaleLowerCase("tr")] ?? NUMBER_WORD_VALUE[w.toLowerCase()];
      if (value !== undefined && !allowedNumbers.has(String(value))) {
        return { ok: false, why: `the number "${w}" (${value}) is not in the tables` };
      }
    }
  } else {
    const words_ = reply.match(NUMBER_WORDS_EN) ?? reply.match(NUMBER_WORDS_TR);
    if (words_) return { ok: false, why: `a number written as a word ("${words_[0]}")` };
  }

  for (const n of reply.match(NUMBER) ?? []) {
    if (!allowedNumbers.has(norm(n))) return { ok: false, why: `the number ${n} is not in the tables` };
  }

  const allowed = new Set(args.grounding.names.map((n) => normaliseName(n)));
  const allowedFirsts = new Set(args.grounding.names.map(firstOf));
  const replyWords = words(reply);
  const replyText = ` ${replyWords.join(" ")} `;
  for (const m of args.roster) {
    const full = normaliseName(m.name);
    if (!full || allowed.has(full)) continue;
    const first = firstOf(m.name);
    const namedInFull = full.includes(" ") && replyText.includes(` ${full} `);
    // A first name shared with somebody the tables DO name is theirs.
    const namedByFirst = first.length >= 3 && !allowedFirsts.has(first) && replyWords.includes(first);
    if (namedInFull || namedByFirst) {
      return { ok: false, why: `${m.name} is mentioned but is not in the tables` };
    }
  }
  return { ok: true };
}

/**
 * PURE. The members a reply names, by user id: by full name, or by a first
 * name of 3 letters or more that no other member shares. The same matching
 * as the check above (Turkish suffixes stripped, names folded). Used by the
 * unified answer to see whether a reply reproduces the squad list.
 */
export function membersNamed(reply: string, roster: Member[]): Set<string> {
  const replyWords = words(reply);
  const replyText = ` ${replyWords.join(" ")} `;
  const firstCount = new Map<string, number>();
  for (const m of roster) {
    const f = firstOf(m.name);
    if (f) firstCount.set(f, (firstCount.get(f) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const m of roster) {
    const full = normaliseName(m.name);
    if (!full) continue;
    const first = firstOf(m.name);
    if (replyText.includes(` ${full} `)) out.add(m.userId);
    else if (first.length >= 3 && firstCount.get(first) === 1 && replyWords.includes(first)) out.add(m.userId);
  }
  return out;
}
