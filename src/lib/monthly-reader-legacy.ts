/**
 * TEST-ONLY: the deterministic stand-in for the monthly reader's model
 * (2026-10-29). Production never reaches this file: `monthly-reader.ts`
 * imports it only when the e2e stub file is set and has no answer for a
 * message, so the monthly scenarios written before the reader was a model
 * still run, for free, against the code that acts on a reading.
 *
 * It is the reader MatchTime used before (the numbered-list parser in
 * `monthly-list.ts`, the fixed "IN FOR <MONTH>" vocabulary that lived in
 * `month-signup-rules.ts`, the title checks in `month-signup-copy.ts`),
 * turned into a `MonthlyReading`. Kemal's rule stands for production: no
 * code reads what people mean.
 */
import { foldListText, monthOfWord, parseMonthlyList, isMonthListHeader } from "./monthly-list";
import type { SignupAsk, SignupChoice } from "./month-signup-rules";
import { isMonthLevelList, quotedSignupMonth, signupPasteResidual } from "./month-signup-copy";
import { pasteResidual } from "./monthly-week-copy";
import type { MonthlyReaderInput, MonthlyReading } from "./monthly-reader-prompt";
import type { ReaderStubFacts } from "./monthly-reader";

const TR_LOCATIVE = /^(.+?)(?:da|de|ta|te)$/;
const DAY_TOKEN = /^(\d{1,2})(?:st|nd|rd|th)?$/;
const DAY_JOINER = new Set(["and", "ve"]);

/** Whole messages only, after the month is `M` and a run of days is `D`.
 *  The FULL form: "for <month>" in English, the month then the word in
 *  Turkish. "Jan payg" and "PAYG November" are not it. */
const WITH_MONTH: Record<SignupChoice, ReadonlySet<string>> = {
  in: new Set(["in for M", "im in for M", "i m in for M", "i am in for M", "count me in for M", "M varim", "M icin varim", "M ayi icin varim"]),
  out: new Set([
    "out for M",
    "im out for M",
    "i m out for M",
    "i am out for M",
    "not in for M",
    "im not in for M",
    "i m not in for M",
    "i am not in for M",
    "M yokum",
    "M icin yokum",
    "M ayi icin yokum",
  ]),
  payg: new Set(["payg for M", "payg for M D", "payg D for M", "M icin payg", "M icin payg D"]),
};

/** A month's short name is not enough to sign anybody up for it. */
const MONTH_ABBREVIATIONS = new Set(["jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"]);

/** The bare words, read only for a reply to the list itself. */
const BARE: Record<SignupChoice, ReadonlySet<string>> = {
  in: new Set(["in", "im in", "i m in", "i am in", "count me in", "yes", "varim", "ben varim", "evet"]),
  out: new Set(["out", "im out", "i m out", "i am out", "not in", "not this month", "no", "yokum", "ben yokum", "bu ay yokum", "hayir"]),
  payg: new Set(["payg", "payg D", "D payg"]),
};

/**
 * Is this message a sign-up for a month, in the fixed vocabulary?
 *
 * The WHOLE message must be one of the phrases, with the month's full
 * name: "IN FOR NOVEMBER", "I'm out for November", "PAYG for November 9th
 * and 23rd", "Kasım varım", "Kasım'da yokum". A sentence that merely mentions the month ("who is in
 * for November?") is not one, and a plain "IN" is this week's game, as it
 * always was (plan 4.1).
 *
 * `quoted`: the message is a reply to the list post, so the bare word
 * ("IN", "varım", "PAYG 9th only") is enough.
 */
export function readSignupMessage(text: string | null | undefined, opts: { quoted: boolean }): SignupAsk | null {
  const tokens = foldListText(text ?? "")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
  if (tokens.length === 0 || tokens.length > 12) return null;

  const months: number[] = [];
  const days: number[] = [];
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    // "may" is also a word; nothing in this vocabulary uses it as one.
    const month = MONTH_ABBREVIATIONS.has(tok) ? null : (monthOfWord(tok) ?? monthOfWord(TR_LOCATIVE.exec(tok)?.[1] ?? ""));
    if (month !== null) {
      months.push(month);
      out.push("M");
      continue;
    }
    const day = DAY_TOKEN.exec(tok);
    if (day) {
      const n = Number(day[1]);
      if (n < 1 || n > 31) return null;
      days.push(n);
      if (out[out.length - 1] !== "D") out.push("D");
      continue;
    }
    // "9th and 23rd": a joiner between two days is part of the run.
    if (DAY_JOINER.has(tok) && out[out.length - 1] === "D" && DAY_TOKEN.test(tokens[i + 1] ?? "")) continue;
    out.push(tok);
  }
  if (months.length > 1) return null;
  // "only" / "sadece" at the end of a PAYG line adds nothing.
  if (out.length > 1 && (out[out.length - 1] === "only" || out[out.length - 1] === "sadece")) out.pop();
  const phrase = out.join(" ");

  const table = months.length === 1 ? WITH_MONTH : opts.quoted ? BARE : null;
  if (!table) return null;
  for (const choice of ["in", "out", "payg"] as const) {
    if (!table[choice].has(phrase)) continue;
    if (choice !== "payg" && days.length > 0) return null;
    return { choice, month: months[0] ?? null, days: [...new Set(days)] };
  }
  return null;
}

/** The day a list's title names, standing alone (MatchTime's own title:
 *  "List for October: Mon 12 Oct, 20:00"). */
function titleDay(body: string): number | null {
  const title = body.split(/\r?\n/).find((line) => isMonthListHeader(line));
  if (!title) return null;
  const n = (title.match(/(?<![\d:.£₺])\b\d{1,2}\b(?![:.\d])/g) ?? []).map(Number).find((d) => d >= 1 && d <= 31);
  return n ?? null;
}

export function legacyMonthlyReading(input: MonthlyReaderInput, facts: ReaderStubFacts | null): MonthlyReading {
  // `quotedSignupMonth` itself checks it is MatchTime's own sign-up list.
  const quotedText = input.reply?.text ?? null;
  const quotedMonth = quotedSignupMonth(quotedText);
  const ask = readSignupMessage(input.body, { quoted: quotedMonth !== null });
  const askMonth = ask ? (ask.month ?? quotedMonth) : null;
  if (ask && askMonth) return { kind: "signup", choice: ask.choice, month: askMonth, days: ask.days, games: null };
  const list = parseMonthlyList(input.body);
  if (!list) return { kind: "none", why: "legacy: not a list" };
  let residual = pasteResidual(input.body, { lang: facts?.lang ?? null, maxPlayers: facts?.maxPlayers ?? 0, paygPricePence: facts?.paygPricePence ?? null });
  for (const f of facts?.signupFooters ?? []) residual = residual ? signupPasteResidual(residual, f) : residual;
  return { kind: "list", list, gameDay: titleDay(input.body), listOf: isMonthLevelList(input.body) ? "month" : "week", residual };
}
