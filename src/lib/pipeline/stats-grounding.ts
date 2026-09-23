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
}): GroundingResult {
  const reply = (args.reply ?? "").trim();
  if (!reply) return { ok: false, why: "the reply is empty" };
  if (/\bNO_ANSWER\b/.test(reply)) return { ok: false, why: "the model said the tables do not answer it" };

  const words_ = reply.match(NUMBER_WORDS_EN) ?? reply.match(NUMBER_WORDS_TR);
  if (words_) return { ok: false, why: `a number written as a word ("${words_[0]}")` };

  const allowedNumbers = new Set([...args.grounding.numbers, ...(args.question.match(NUMBER) ?? [])].map(norm));
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
