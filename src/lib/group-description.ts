/**
 * THE WHATSAPP GROUP DESCRIPTION, MASKED BEFORE IT IS STORED (2026-10-12).
 *
 * When MatchTime is added to a group the Pi sends the group's description
 * with the add. Organisers keep match and payment details there, so it
 * often holds bank details. `ingestGroupDescription` is the one door from
 * "what the Pi sent" to "what the server keeps": it runs on the request
 * body before anything is written, and what it returns is all that may
 * reach the database, a log or an error message. Nothing reads the stored
 * text yet; a later slice gives it to the setup reading.
 *
 * Pure: no imports, no I/O. Never throws. Idempotent: what it kept,
 * ingested again, is kept as it is (group-add.ts runs it a second time on
 * whatever it is handed, so no caller can store unmasked text).
 *
 * WHAT IS REMOVED. Each of these becomes "[number removed]":
 *
 *   1. An IBAN: two letters, two digits, then 11 to 30 letters or digits,
 *      in one piece or in groups of four split by a space or a hyphen, all
 *      upper case or all lower case, with at least 8 digits in it.
 *   2. Any run of 6 or more digits on one line, where two digits may have
 *      between them either any number of spaces, tabs, hyphens and dashes
 *      of any kind, round brackets and invisible characters, or one dot.
 *      So "12-34-56", "12 - 34 - 56", "12.34.56", "1234 5678",
 *      "+44 7700 900123", "(020) 7946 0958" and "0555.123.45.67" all go:
 *      sort codes, account numbers, card numbers and phone numbers. A
 *      leading "+" or "(" goes with the number.
 *
 * "A digit" is any Unicode decimal digit or other numeric character
 * (Arabic-Indic, Devanagari, dingbat digits and so on), and the text is
 * NFKC-normalised first, so full-width, mathematical, superscript, circled
 * and keycap digits are plain digits by the time the rules run. Invisible
 * characters (zero-width, bidi marks, soft hyphen, variation selectors,
 * combining marks, the Hangul fillers, the braille blank) never break a
 * run.
 *
 * WHAT SURVIVES, and why.
 *
 *   - A colon, a slash, a comma, a new line, and a dot that is not
 *     directly between two digits all END a run: "12/10", "12/10/2026",
 *     "Max 14. 2026 season", "9 a side", "Monday 9pm", "14 players".
 *   - A CLOCK TIME OR A PRICE IS NEVER PART OF A NUMBER. One or two
 *     digits, then a dot, a colon or a comma, then exactly two digits
 *     ("8:30", "20.30", "7.50", "7,50"), and a currency sign followed by
 *     up to four digits and optional pence ("£7", "£12.50", "€1500"), are
 *     set aside before rule 2 runs. So "21.00-22.00" is two times, not
 *     eight digits, and in "07700 900123 20:30" only the phone goes.
 *     This applies only when the time or price stands on its own: it is
 *     not set aside when a digit, or a dot, colon or comma, touches it on
 *     either side (invisible characters ignored). "12.34.56",
 *     "£1234567" and "12345678:30" are therefore numbers, and go.
 *
 * WHAT IS LOST ON PURPOSE (over-masking is the safe direction): a year
 * range ("2025-2026"), a date with its year written with dots or hyphens
 * ("12.10.2026"), a price in thousands with a dot ("125.000 TL"), and any
 * numbers on one line with only spaces or hyphens between them that add
 * up to 6 digits ("14 10 2026").
 *
 * WHAT CAN SURVIVE (known, accepted): when the LAST group of a number is
 * written like a time or a price after a space ("0555 123 45.67"), those
 * last four digits stay; the rest of the number goes if it has 6 digits.
 *
 * WHAT IS NOT REMOVED: names, email addresses, links (a payment link such
 * as a "pay me" page included), post codes, and numbers written out in
 * words. Those are not what this guards.
 */

/** What every removed number is replaced with. */
export const NUMBER_REMOVED = "[number removed]";

/**
 * The longest description accepted, and the longest stored, in UTF-16
 * units. WhatsApp's own limit is about 2,048 characters; twice that leaves
 * room for the limit to grow and for masking to lengthen the text (a
 * 6-digit number becomes a 16-character placeholder). Anything longer did
 * not come from WhatsApp and is dropped whole, never cut: a cut could
 * leave half a number that is too short to be recognised.
 */
export const GROUP_DESCRIPTION_MAX_CHARS = 4096;

const DIGIT = "[\\p{Nd}\\p{No}]";
/** Characters with no width or no glyph of their own. Never a break. */
const INVISIBLE = "[\\p{Cf}\\p{Mn}\\p{Me}\\u115F\\u1160\\u3164\\uFFA0\\u2800]";
/** What may sit between two digits of one number. No new line, no dot. */
const SEPARATOR = `(?:[\\p{Zs}\\t\\p{Pd}\\u2212()]|${INVISIBLE})`;
/** Between two digits: separators in any number, or exactly one dot. */
const BETWEEN = `(?:${SEPARATOR}*|${INVISIBLE}*\\.${INVISIBLE}*)`;

const DIGIT_RE = new RegExp(DIGIT, "gu");
const DIGIT_RUN = new RegExp(`[+(]{0,2}${DIGIT}(?:${BETWEEN}${DIGIT}){5,}${INVISIBLE}*`, "gu");
/**
 * A clock time or a price standing on its own. ONE capture group around
 * the whole, so `split` hands the matches back at the odd indexes.
 */
const TIME_OR_PRICE = new RegExp(
  `((?<![\\p{Nd}\\p{No}.,:]${INVISIBLE}*)` +
    `(?:[£$€₺]\\p{Nd}{1,4}(?:[.,]\\p{Nd}{2})?|\\p{Nd}{1,2}[.:,]\\p{Nd}{2})` +
    `(?!${INVISIBLE}*(?:${DIGIT}|[.,:]${INVISIBLE}*${DIGIT})))`,
  "u",
);
const iban = (letters: string) =>
  new RegExp(
    `(?<![A-Za-z0-9])${letters}{2}\\d{2}(?:[ \\-]?(?:${letters}|\\d){4}){2,7}(?:[ \\-]?(?:${letters}|\\d){1,4})?(?![A-Za-z0-9])`,
    "g",
  );
const IBAN_UPPER = iban("[A-Z]");
const IBAN_LOWER = iban("[a-z]");

function digitCount(s: string): number {
  return s.match(DIGIT_RE)?.length ?? 0;
}

/**
 * Replace every bank-detail-shaped and phone-shaped number in `text` with
 * "[number removed]". The rules are at the top of this file. Returns the
 * masked text (NFKC-normalised) and how many numbers went.
 */
export function maskGroupDescription(text: string): { text: string; removed: number } {
  let removed = 0;
  const gone = () => {
    removed++;
    return NUMBER_REMOVED;
  };
  let out = text.normalize("NFKC");

  // Rule 1. An IBAN-shaped piece with too few digits is left for rule 2.
  for (const re of [IBAN_UPPER, IBAN_LOWER]) {
    out = out.replace(re, (m) => (digitCount(m) < 8 ? m : gone()));
  }

  // Rule 2, on everything that is not a clock time or a price.
  out = out
    .split(TIME_OR_PRICE)
    .map((piece, i) => (i % 2 === 1 ? piece : piece.replace(DIGIT_RUN, gone)))
    .join("");

  return { text: out, removed };
}

export interface IngestedGroupDescription {
  /** The masked text, or null when there is nothing to keep. */
  text: string | null;
  /** For a log line: a length and a count, never any of the text. */
  note: string;
  /** How many numbers were replaced. */
  removed: number;
}

const NOTHING: IngestedGroupDescription = { text: null, note: "none", removed: 0 };
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Control characters other than a new line and a tab (NUL among them,
 *  which Postgres refuses in text). */
const CONTROL = /[^\P{Cc}\n\t]/gu;

/** Cut to the limit without leaving half a placeholder or half a character. */
function cutToLimit(s: string): string {
  if (s.length <= GROUP_DESCRIPTION_MAX_CHARS) return s;
  let cut = s.slice(0, GROUP_DESCRIPTION_MAX_CHARS);
  const open = cut.lastIndexOf("[");
  if (open !== -1) {
    const rest = cut.slice(open);
    if (rest.length < NUMBER_REMOVED.length && NUMBER_REMOVED.startsWith(rest)) cut = cut.slice(0, open);
  }
  return cut.replace(/[\uD800-\uDBFF]$/, "").trimEnd();
}

/**
 * What the server keeps of the `groupDescription` the Pi sent: masked,
 * trimmed, at most GROUP_DESCRIPTION_MAX_CHARS long, or nothing at all.
 * Not a string, blank, or longer than the limit: nothing.
 */
export function ingestGroupDescription(raw: unknown): IngestedGroupDescription {
  if (typeof raw !== "string" || raw.length === 0) return NOTHING;
  if (raw.length > GROUP_DESCRIPTION_MAX_CHARS) return { text: null, note: "oversize", removed: 0 };
  const clean = raw.replace(LONE_SURROGATE, "\ufffd").replace(/\r\n?/g, "\n").replace(CONTROL, "");
  const masked = maskGroupDescription(clean);
  const text = cutToLimit(masked.text.trim());
  if (text.length === 0) return NOTHING;
  return { text, note: `${text.length} chars, ${masked.removed} number(s) removed`, removed: masked.removed };
}
