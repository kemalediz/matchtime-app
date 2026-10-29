/**
 * TEST FIXTURE ONLY: the deterministic monthly list reader MatchTime used
 * before 2026-10-29, and the fixed "IN FOR <MONTH>" words. Production reads
 * lists and sign-ups with a model (`monthly-reader.ts`); a source guard
 * (`../monthly-no-parsing.source.test.ts`) keeps every file under src/
 * outside the tests from importing this.
 *
 * Kept because the unit tests build `MonthlyList` values from readable
 * text with it, and the e2e suite answers the reader's stub with it
 * (`legacyReaderAnswer`) so the monthly scenarios written before the model
 * run unchanged, for free.
 */
import { foldListText as fold, monthOfWord } from "../../monthly-list";
import type { MonthlyList, MonthlyListEntry, MonthlyListMarks, MonthlyListMonth, PaygDate } from "../../monthly-list";
import { cleanName, isCantPlayHeader, readListLine, sameName, splitRosterSections, type ListLine } from "../../pasted-roster";
import { t } from "../../i18n/t";
import { LANGS, type Lang } from "../../i18n/lang";
import { monthNameLabel } from "../../i18n/dates";
import { paygPriceLabel } from "../../monthly-week-copy";
import { footer, type SignupPostFacts } from "../../month-signup-copy";
import type { SignupAsk, SignupChoice } from "../../month-signup-rules";

type LangArg = Lang | string | null | undefined;

/** Without a month header, the pasted-roster thresholds apply: four list
 *  lines, three of them names. */
const MIN_LIST_LINES = 4;
const MIN_NAMES = 3;

const NO_MARKS: MonthlyListMarks = {
  paid: false,
  paidAmountPence: null,
  tier: null,
  payg: false,
  paygDates: [],
};

/** "list", "lists", "liste", "listesi". */
const LIST_WORD = /^list(?:s|e|esi)?$/;
const PAID_WORD = /^(?:paid|payed|odedi|odendi)$/;
/** "not paid", "unpaid", "ödemedi", "ödenmedi": recognised so the words
 *  come out of the name, and deliberately NOT a paid mark. */
const NOT_PAID_WORD = /^(?:not|unpaid|odemedi|odenmedi)$/;
const CONCESSION_WORD = /^(?:pensioners?|concessions?|oap|emekli|indirimli)$/;
const PAYG_WORD = /^payg$/;
/** A paid word inside folded running text. */
const PAID_IN_TEXT = /\b(?:paid|payed|odedi|odendi)\b/;

/** The folded words of a string: letters and digits only. */
function words(s: string): string[] {
  return fold(s)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

// ── Month header ──────────────────────────────────────────────────────

/**
 * Read the month from a header line, or null.
 *
 * The line must contain a list word ("list", "liste", "listesi") AND a
 * month name as a whole word, so "See you in October" and "Martin's
 * list" are not headers. When a line names more than one month ("List
 * for November: pay by Fri 30 Oct"), the one that reads as the list's
 * own month wins: "for <month>" or "<month> list".
 */
function readMonthHeader(line: string): MonthlyListMonth | null {
  const w = words(line);
  if (!w.some((x) => LIST_WORD.test(x))) return null;

  const candidates = w
    .map((word, i) => ({ word, i, month: monthOfWord(word) ?? undefined }))
    .filter((c) => c.month !== undefined);
  if (candidates.length === 0) return null;

  const isHeaderPosition = (i: number): boolean => {
    const before = w[i - 1];
    const after = w[i + 1];
    if (before === "for") return true;
    if (after !== undefined && LIST_WORD.test(after)) return true;
    // "Aralık ayı listesi"
    return after === "ayi" && w[i + 2] !== undefined && LIST_WORD.test(w[i + 2]);
  };

  const chosen =
    candidates.find((c) => isHeaderPosition(c.i)) ??
    // "may" is also an ordinary word ("the list may change").
    candidates.find((c) => c.word !== "may") ??
    candidates[0];

  const yearWord = w.find((x) => /^20\d{2}$/.test(x));
  return { month: chosen.month as number, year: yearWord ? Number(yearWord) : null };
}

/** Is this line a month list's header ("List for October", "Ekim
 *  listesi")? For telling the list's own title from what a member typed
 *  around it. */
export function isMonthListHeader(line: string): boolean {
  return readMonthHeader(line) !== null;
}

// ── Marks ─────────────────────────────────────────────────────────────

/** "22.50", "22,5", "30" as pence. */
function toPence(pounds: string, fraction: string | undefined): number {
  const f = fraction ? Number(fraction.padEnd(2, "0")) : 0;
  return Number(pounds) * 100 + f;
}

/**
 * The amount written beside a paid mark, or null.
 *
 * Only a number that is PLAINLY an amount is read: one carrying a
 * currency sign anywhere in the text, or a number that is the only
 * thing left once the paid word is taken out. "(paid for 4 games)" has
 * neither, so it is paid with no amount, not paid £4.
 */
function readAmount(text: string): number | null {
  const signed = /[£₺]\s*(\d{1,4})(?:[.,](\d{1,2}))?|(\d{1,4})(?:[.,](\d{1,2}))?\s*(?:[£₺]|tl\b)/i.exec(
    text,
  );
  if (signed) return toPence(signed[1] ?? signed[3], signed[2] ?? signed[4]);

  const rest = fold(text)
    .split(/\s+/)
    .filter((t) => !PAID_WORD.test(t.replace(/[^\p{L}]/gu, "")) || /\d/.test(t))
    .join(" ")
    .replace(/^[\s:=\-–—,]+|[\s:=\-–—,]+$/g, "");
  const bare = /^(\d{1,4})(?:[.,](\d{1,2}))?$/.exec(rest);
  return bare ? toPence(bare[1], bare[2]) : null;
}

/**
 * The dates written after a PAYG mark: "5th only", "9th, 23rd",
 * "9th and 23rd Nov", "9 Kasım". A month named after a run of bare days
 * covers the whole run, so "9th and 23rd Nov" is both in November.
 */
function readPaygDates(text: string): PaygDate[] {
  const dates: PaygDate[] = [];
  const re = /(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\p{L}+))?/gu;
  const folded = fold(text);
  let m: RegExpExecArray | null;
  while ((m = re.exec(folded)) !== null) {
    const day = Number(m[1]);
    if (day < 1 || day > 31) continue;
    const month = m[2] !== undefined ? monthOfWord(m[2]) : null;
    dates.push({ day, month });
  }
  for (let i = dates.length - 2; i >= 0; i--) {
    if (dates[i].month === null) dates[i].month = dates[i + 1].month;
  }
  return dates;
}

/** Apply one piece of mark text (a bracket's contents, or a trailing
 *  "paid 30" / "PAYG 5th only") to `marks`. Returns false when the text
 *  is outside the vocabulary: "(Bossman)", "(GK)". */
function applyMarkText(text: string, marks: MonthlyListMarks): boolean {
  const w = words(text);
  const negated = w.some((x) => NOT_PAID_WORD.test(x));
  const paid = w.some((x) => PAID_WORD.test(x));
  const payg = w.some((x) => PAYG_WORD.test(x));
  const concession = w.some((x) => CONCESSION_WORD.test(x));
  if (!paid && !payg && !concession && !negated) return false;

  // Work on the folded text from here, so positions line up.
  const folded = fold(text);
  const paidAt = folded.search(PAID_IN_TEXT);

  if (payg) {
    marks.payg = true;
    // Dates are whatever follows the PAYG word, up to a paid word, with
    // any money taken out first: "(PAYG, paid £8)" names no date.
    const from = folded.search(/\bpayg\b/);
    const until = paidAt > from ? paidAt : folded.length;
    const dateText = folded.slice(from, until).replace(/[£₺]\s*\d+(?:[.,]\d+)?/g, " ");
    for (const d of readPaygDates(dateText)) marks.paygDates.push(d);
  }
  if (paid && !negated) {
    marks.paid = true;
    // Beside a PAYG mark, only what follows the paid word can be the
    // amount, so "(PAYG 5th, paid)" does not read the 5th as £5.
    const amount = readAmount(payg ? folded.slice(paidAt) : folded);
    if (amount !== null) marks.paidAmountPence = amount;
  }
  if (concession) marks.tier = "concession";
  return true;
}

const BRACKET = /[(（]([^)）]*)(?:[)）]|$)/gu;
/** A trailing mark with no brackets: "Sunny paid", "Tom Paid 30",
 *  "Tom - paid £37.50", "Jake not paid", "Vikram PAYG", "Simon PAYG 5th
 *  only", "Burak ödedi 300". The mark word must follow a space or a
 *  separator, so "Paidraig" is a name. */
const TAIL_PAID =
  /(?:^|[\s,:\-–—])(?:not\s+)?(?:paid|payed|unpaid|[oö]dedi|[oö]dendi|[oö]demedi|[oö]denmedi)(?:\s*[:=\-–—]?\s*[£₺]?\s*\d{1,4}(?:[.,]\d{1,2})?\s*(?:[£₺]|tl)?)?\s*$/iu;
const TAIL_PAYG = /(?:^|[\s,:\-–—])payg(?:\s+[^()（）]*)?$/iu;

/**
 * Split one list line into the name and its marks.
 *
 * Marks come out first, the name is cleaned afterwards, so "Toby paid"
 * is the name "Toby" with a paid mark, not a player called "Toby paid".
 * Every bracket is a note and never part of the name: a bracket inside
 * the vocabulary becomes a mark, any other ("(Bossman)", "(GK)") is
 * dropped, as `cleanName` has always done.
 */
export function readMarks(raw: string): { name: string; marks: MonthlyListMarks } {
  const marks: MonthlyListMarks = { ...NO_MARKS, paygDates: [] };

  let rest = raw.replace(BRACKET, (_whole, inner: string) => {
    applyMarkText(inner, marks);
    return " ";
  });

  // Bare trailing marks, peeled from the right until none is left
  // ("Vikram PAYG paid" carries two).
  for (let i = 0; i < 4; i++) {
    const trimmed = rest.replace(/\s+$/u, "");
    const paid = TAIL_PAID.exec(trimmed);
    if (paid) {
      applyMarkText(paid[0], marks);
      rest = trimmed.slice(0, paid.index);
      continue;
    }
    const payg = TAIL_PAYG.exec(trimmed);
    if (payg) {
      applyMarkText(payg[0], marks);
      rest = trimmed.slice(0, payg.index);
      continue;
    }
    break;
  }

  // A separator left dangling where a mark was: "Tom -", "Tom:".
  rest = rest.replace(/[\s,:\-–—]+$/u, "");

  const cleaned = cleanName(rest);
  // A slot holding only a placeholder ("…", "?", "-") is a blank slot.
  const name = /\p{L}/u.test(cleaned) ? cleaned : "";
  return { name, marks };
}

function toEntry(l: ListLine): MonthlyListEntry {
  const { name, marks } = readMarks(l.raw);
  return { slot: l.slot, raw: l.raw, name, marks };
}

// ── The reader ────────────────────────────────────────────────────────

/**
 * Read a message as a monthly list, or return null if it is not one.
 * Pure: same string in, same object out, always.
 *
 * A message is a list when it has a month header and at least one
 * numbered line (the organiser's opening post is three names), or, with
 * no header, when it meets the pasted-roster thresholds.
 */
export function parseMonthlyList(body: string | null | undefined): MonthlyList | null {
  if (!body) return null;

  const split = splitRosterSections(body);
  const slots = split.playing.map(toEntry);
  const cantPlay = split.cantPlay.map(toEntry);
  const reserves = split.reserves.map(toEntry);
  const other = split.other.map(toEntry);

  let month: MonthlyListMonth | null = null;
  for (const line of split.proseLines) {
    month = readMonthHeader(line);
    if (month) break;
  }

  const all = [...slots, ...cantPlay, ...reserves, ...other];
  if (month) {
    if (!all.some((e) => e.slot !== null)) return null;
  } else {
    if (all.length < MIN_LIST_LINES) return null;
    if (all.filter((e) => e.name).length < MIN_NAMES) return null;
  }

  return { month, slots, sections: { cantPlay, reserves, other } };
}

export interface MonthlyListMatch {
  where: "slot" | "cantPlay" | "reserves" | "other";
  entry: MonthlyListEntry;
}

/**
 * Where is this person on the list? By NAME, never by position: slots
 * are reordered, blanked and refilled all month, so a position says
 * nothing about who is in it.
 *
 * Uses `sameName`, the rule the pasted-roster code uses: exact on the
 * folded name, or an equal first name, so the list's "Gary" is the
 * member "Gary Holt". Deliberately not fuzzy. The first match wins, in
 * the order slots, can't play, reserves, other.
 */
export function findInMonthlyList(
  list: MonthlyList,
  name: string | null | undefined,
): MonthlyListMatch | null {
  const groups: Array<[MonthlyListMatch["where"], MonthlyListEntry[]]> = [
    ["slot", list.slots],
    ["cantPlay", list.sections.cantPlay],
    ["reserves", list.sections.reserves],
    ["other", list.sections.other],
  ];
  for (const [where, entries] of groups) {
    for (const entry of entries) {
      if (entry.name && sameName(entry.name, name)) return { where, entry };
    }
  }
  return null;
}

// ── MatchTime's own lines (what a residual leaves out) ───────────────

const WEEK_RESERVE_HEADER = /^\s*(reserves?|subs?|substitutes?|standby|stand-by)\b\s*:?\s*$/i;

/** `mwk_list_open_organiser` as MatchTime posted it in English until
 *  2026-10-12. Never sent any more, only recognised. The Turkish line did
 *  not change. */
function legacyOpenOrganiserLine(open: number): string {
  return `${open} ${open === 1 ? "place" : "places"} open. Say *IN* to go on the waiting list, and the organisers will pick who plays.`;
}

/**
 * What a member typed AROUND the list. The list's own furniture is taken
 * out: its title, its section headers, and the "N places open" line of
 * MatchTime's own post, which a member who copies that post pastes back
 * (and which a model must never read as the sender saying IN).
 */
export function pasteResidual(body: string, ctx: { lang: string | null; maxPlayers: number; paygPricePence: number | null }): string {
  const s = t(ctx.lang);
  const own = new Set<string>([s.mwk_list_cant_play_paid, s.mwk_list_cant_play, s.mwk_list_reserves]);
  const price = paygPriceLabel(ctx.paygPricePence);
  for (let open = 1; open <= Math.max(ctx.maxPlayers, 1); open++) {
    own.add(s.mwk_list_open({ open, price }));
    own.add(s.mwk_list_open({ open, price: null }));
    own.add(s.mwk_list_open_organiser({ open }));
    // The same line as it read before 2026-10-12, when the English said
    // "waiting list" for the bench. Posts in that wording are still in the
    // groups, and one pasted back must not reach a model as "say IN".
    own.add(legacyOpenOrganiserLine(open));
  }
  // A not-playing header only counts BELOW a list line, exactly as the
  // reader decides it: "Can't make it" typed above the list is the sender
  // speaking, and must reach the pipeline.
  const kept: string[] = [];
  let seenListLine = false;
  for (const raw of body.split(/\r?\n/)) {
    if (readListLine(raw)) {
      seenListLine = true;
      continue;
    }
    const line = raw.trim();
    if (!line) continue;
    if (isMonthListHeader(line) || WEEK_RESERVE_HEADER.test(line) || own.has(line)) continue;
    if (seenListLine && isCantPlayHeader(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

const RESERVE_HEADER = /^\s*(reserves?|subs?|substitutes?|standby|stand-by)\b\s*:?\s*$/i;

/**
 * What a member typed AROUND a pasted sign-up list. The list's own
 * furniture is taken out: its title, the waiting header and the lines of
 * MatchTime's own post, which a member who copies that post pastes back
 * (and which a model must never read as the sender saying IN or OUT).
 */
export function signupPasteResidual(body: string, p: Omit<SignupPostFacts, "list">): string {
  const s = t(p.lang);
  const own = new Set<string>([...footer(p), s.mwk_list_reserves]);
  // The carried-over line exists in both shapes.
  const month = monthNameLabel(p.lang, p.kickoffs[0]);
  own.add(s.msu_list_out({ month }));
  const kept: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    if (readListLine(raw)) continue;
    const line = raw.trim();
    if (!line) continue;
    if (isMonthListHeader(line) || RESERVE_HEADER.test(line) || own.has(line)) continue;
    // Our own footer lines, whatever their dates were when it was copied.
    if (isOwnFooterLine(line, p.lang)) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** A line of MatchTime's sign-up post from any month or day: the fixed
 *  words around the variable parts. */
function isOwnFooterLine(line: string, lang: LangArg): boolean {
  const s = t(lang);
  const SENTINEL = "\u0000";
  const shapes = [
    s.msu_list_out({ month: SENTINEL }),
    s.msu_list_join({ month: SENTINEL }),
    s.msu_list_link({ url: SENTINEL }),
    s.msu_list_deadline({ when: SENTINEL }),
    `${s.msu_list_carried({ prev: SENTINEL })} ${s.msu_list_out({ month: SENTINEL })}`,
  ];
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = (shape: string) =>
    new RegExp(
      `^${shape
        .split(/\u0000/i)
        .map(esc)
        .join(".+")}$`,
      "iu",
    ).test(line);
  if (shapes.some(matches)) return true;
  for (let day = 1; day <= 31; day++) if (line === s.msu_list_payg({ day })) return true;
  return false;
}

/** The title lines of MatchTime's own MONTH lists, as shapes (the fixed
 *  words around the variable parts), in every language. Slice 4 adds the
 *  priced list's title here. */
function monthListTitleShapes(): RegExp[] {
  const SENTINEL = "\u0000";
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return LANGS.flatMap((lang) => {
    const s = t(lang);
    return [
      s.msu_list_header({ month: SENTINEL, games: 2, weekday: SENTINEL, days: SENTINEL }),
      s.msu_list_header({ month: SENTINEL, games: 1, weekday: SENTINEL, days: SENTINEL }),
      // Slice 4: the priced list.
      s.mpy_priced_header({ month: SENTINEL, share: SENTINEL, when: SENTINEL, collector: SENTINEL }),
      s.mpy_priced_header({ month: SENTINEL, share: SENTINEL, when: SENTINEL, collector: null }),
    ].map(
      (shape) =>
        new RegExp(
          `^${shape
            .replace(/^[^\p{L}\u0000]+/u, "")
            .replace(/\d+/g, SENTINEL)
            .split(SENTINEL)
            .map(esc)
            .join(".+")}$`,
          "iu",
        ),
    );
  });
}

/** The title line of one of MatchTime's own month lists in this text, or null. */
function monthListTitle(body: string | null | undefined): string | null {
  const shapes = monthListTitleShapes();
  for (const raw of (body ?? "").split(/\r?\n/)) {
    const line = raw.trim().replace(/^\P{L}+/u, "");
    if (line !== "" && shapes.some((re) => re.test(line))) return raw.trim();
  }
  return null;
}

/**
 * Is this pasted message one of MatchTime's own MONTH lists, going by its
 * title line ("List for November (5 Mondays: 2, 9, ...)")? Such a list is
 * the month's, not this week's game: a member who pastes one back must
 * never change who plays this week by doing so, so it never reaches the
 * week's reader. A list the group typed itself ("List for November:") and
 * the week's own post ("List for November: Mon 2 Nov, 20:00") are not one.
 */
export function isMonthLevelList(body: string | null | undefined): boolean {
  return monthListTitle(body) !== null;
}

/**
 * THE QUOTED-REPLY RULE. A bare "IN" (or "OUT", "PAYG 9th") counts as a
 * sign-up for a month ONLY when the message it replies to is MatchTime's
 * own sign-up list, and then for that list's month (1 to 12). A reply to
 * the WEEK's list, to a list the group typed, or to anything else returns
 * null: that "IN" is this week's game, exactly as it always was.
 */
export function quotedSignupMonth(quotedBody: string | null | undefined): number | null {
  if (!monthListTitle(quotedBody)) return null;
  return parseMonthlyList(quotedBody)?.month?.month ?? null;
}


// ── The fixed sign-up words, and the stand-in reading ─────────────────

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
  const tokens = fold(text ?? "")
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

/** What a member typed around the list, as the old code left it: every
 *  line that is not a list line, a header, or one of MatchTime's own lines
 *  (in English or Turkish, for any number of open places or price). */
export function legacyResidual(body: string): string {
  let out = body;
  for (const lang of ["en", "tr"] as const) {
    out = pasteResidual(out, { lang, maxPlayers: 30, paygPricePence: null });
    out = out
      .split(/\r?\n/)
      .filter((line) => !isOwnFooterLine(line.trim(), lang) && !isOwnOpenLine(line.trim(), lang))
      .join("\n")
      .trim();
  }
  return out;
}

/** "3 places open, £8 PAYG: say IN to take one", whatever the price. */
function isOwnOpenLine(line: string, lang: "en" | "tr"): boolean {
  const s = t(lang);
  const SENTINEL = "\u0000";
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (let open = 1; open <= 30; open++) {
    const shape = s.mwk_list_open({ open, price: SENTINEL });
    if (new RegExp(`^${shape.split(SENTINEL).map(esc).join(".+")}$`, "iu").test(line)) return true;
  }
  return false;
}

/**
 * The monthly reader's raw answer (its schema's object) as the old code
 * would have read the message: what the e2e suite registers in the
 * reader's stub for every message it posts (`e2e/helpers/monthly-reader-legacy.ts`).
 * Member refs are left empty: production then matches the clean name.
 */
export function legacyReaderAnswer(body: string, quotedBody?: string | null): Record<string, unknown> {
  const none = { kind: "none", month: 0, gameDay: 0, listOf: "", lines: [], residual: "", choice: "", signupMonth: 0, days: [], games: 0 };
  const quotedMonth = quotedSignupMonth(quotedBody ?? null);
  const ask = readSignupMessage(body, { quoted: quotedMonth !== null });
  const askMonth = ask ? (ask.month ?? quotedMonth) : null;
  if (ask && askMonth) return { ...none, kind: "signup", choice: ask.choice, signupMonth: askMonth, days: ask.days };
  const list = parseMonthlyList(body);
  if (!list) return none;
  const line = (section: string) => (e: MonthlyListEntry) => ({
    section,
    slot: e.slot ?? 0,
    name: e.name,
    member: "",
    guest: false,
    host: "",
    games: 0,
    payg: e.marks.payg,
    paygDays: e.marks.paygDates.map((d) => d.day),
    paid: e.marks.paid,
    paidPence: e.marks.paidAmountPence ?? 0,
    concession: e.marks.tier === "concession",
    newbie: false,
  });
  return {
    ...none,
    kind: "list",
    month: list.month?.month ?? 0,
    gameDay: titleDay(body) ?? 0,
    listOf: isMonthLevelList(body) ? "month" : "week",
    lines: [
      ...list.slots.map(line("playing")),
      ...list.sections.cantPlay.map(line("cant_play")),
      ...list.sections.reserves.map(line("reserves")),
      ...list.sections.other.map(line("other")),
    ],
    residual: legacyResidual(body),
  };
}
