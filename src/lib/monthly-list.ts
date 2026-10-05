/**
 * The monthly list reader: deterministic, pure, no model.
 *
 * Monthly squad plan (`MDs/monthly-squad-plan-2026-10-05.md`), slice 1,
 * section 6.1. Some groups run on a list for the whole month:
 *
 *     List for October:
 *
 *     1. Marco (Bossman)
 *     2. Gary (Paid £22.50)
 *     6. Vikram (PAYG)
 *     8. Simon (PAYG 5th only)
 *     10.
 *     11. Sunny paid
 *
 *     Paid but can't play
 *     1. Paulo
 *
 * `pasted-roster.ts` cannot read that. It registers names only when a
 * paste restates the squad as an exact prefix, in order, and it throws
 * the "(Paid £22.50)" bracket away. This reader keeps everything the
 * line says: the slot number as written, the name, and the marks.
 *
 * ── What it is, and is not ────────────────────────────────────────────
 * It reports what a message SAYS. It decides nothing, writes nothing and
 * posts nothing, and no code path calls it yet: comparing a list with
 * MatchTime's own state is slice 3 (plan section 6.2), and that
 * comparison is by NAME, not by position, which is what
 * `findInMonthlyList` is for.
 *
 * A "(paid)" mark is a CLAIM written by whoever pasted the list. It is
 * never proof of payment. The rule that only the collector or a settled
 * card payment confirms a payment is unchanged and lives elsewhere.
 *
 * Which lines are slots and which sit under a header is decided by
 * `splitRosterSections` in `pasted-roster.ts`, the same code the
 * pasted-roster parser uses, so the two readers cannot disagree.
 */
import { normaliseName } from "./name-normalise";
import {
  cleanName,
  sameName,
  splitRosterSections,
  type ListLine,
} from "./pasted-roster";

/** A date a PAYG player named: "5th" is `{ day: 5, month: null }`,
 *  "9 Kasım" is `{ day: 9, month: 11 }`. The month is 1 to 12, and null
 *  means "of the list's month". */
export interface PaygDate {
  day: number;
  month: number | null;
}

export interface MonthlyListMarks {
  /** The line carries a paid mark: "(paid)", "paid", "(Paid £22.50)",
   *  "ödedi". A claim, never a confirmation. */
  paid: boolean;
  /** The amount written with the paid mark, in pence ("£22.50" is 2250).
   *  Null when no amount is written. */
  paidAmountPence: number | null;
  /** "(paid pensioners rate)", "(paid concession)", "(OAP)". A hint for
   *  the organiser to confirm, never applied on its own. */
  tier: "concession" | null;
  /** "(PAYG)": pays per game, not for the month. */
  payg: boolean;
  /** The dates a PAYG mark names. Empty for a plain "(PAYG)". */
  paygDates: PaygDate[];
}

export interface MonthlyListEntry {
  /** The number as written. Never renumbered: slot numbers are stable
   *  through the month, and a gap is information. Null for a bullet. */
  slot: number | null;
  /** The line with its numbering removed, otherwise untouched. */
  raw: string;
  /** The cleaned name with the marks taken out. Empty for a blank slot. */
  name: string;
  marks: MonthlyListMarks;
}

export interface MonthlyListMonth {
  /** 1 to 12. */
  month: number;
  /** Only when the header writes one ("List for January 2027"). */
  year: number | null;
}

export interface MonthlyList {
  /** From "List for October", "October list", "Ekim listesi". Null when
   *  the message has no such header. */
  month: MonthlyListMonth | null;
  /** The playing list, in the order written. Blank slots are kept. */
  slots: MonthlyListEntry[];
  sections: {
    /** "Paid but can't play", "Can't play", "Out", "Injured",
     *  "Gelemeyenler", "Ödedi gelemiyor". */
    cantPlay: MonthlyListEntry[];
    /** "Reserves", "Subs", "Standby". */
    reserves: MonthlyListEntry[];
    /** Under a header this reader does not know, where the numbering
     *  started again. Kept apart so it is never mistaken for slots. */
    other: MonthlyListEntry[];
  };
}

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

// ── Vocabulary ────────────────────────────────────────────────────────
// Every word below is matched on FOLDED text (`fold`): lower case, no
// accents, dotless ı as i. So "Ödedi", "ödedi" and "odedi" are one word.

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, ocak: 1,
  february: 2, feb: 2, subat: 2,
  march: 3, mar: 3, mart: 3,
  april: 4, apr: 4, nisan: 4,
  may: 5, mayis: 5,
  june: 6, jun: 6, haziran: 6,
  july: 7, jul: 7, temmuz: 7,
  august: 8, aug: 8, agustos: 8,
  september: 9, sep: 9, sept: 9, eylul: 9,
  october: 10, oct: 10, ekim: 10,
  november: 11, nov: 11, kasim: 11,
  december: 12, dec: 12, aralik: 12,
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

/** Lower case, accents off, dotless ı as i, invisible characters out. */
function fold(s: string): string {
  return normaliseName(s).replace(/ı/g, "i");
}

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
    .map((word, i) => ({ word, i, month: MONTHS[word] }))
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
  return { month: chosen.month, year: yearWord ? Number(yearWord) : null };
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
    const month = m[2] !== undefined ? (MONTHS[m[2]] ?? null) : null;
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
