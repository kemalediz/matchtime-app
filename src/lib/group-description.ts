/**
 * THE WHATSAPP GROUP DESCRIPTION, MASKED BEFORE IT IS STORED (2026-10-12).
 *
 * When MatchTime is added to a group the Pi sends the group's description
 * with the add. Organisers keep match and payment details there, so it
 * often holds bank details. `ingestGroupDescription` is the one door from
 * "what the Pi sent" to "what the server keeps": it runs on the request
 * body before anything is written, and what it returns is all that may
 * reach the database, a log or an error message. The stored text is
 * read once, by the setup reading, beside the chat
 * (`descriptionForReading`, setup-learning/run.ts).
 *
 * Pure: no imports, no I/O. Never throws. Linear in the length of the
 * text. Idempotent: masking what was masked changes nothing. That holds
 * because the three placeholders are single tokens to every rule (nothing
 * reads into one, takes its letters for words, or alters it), because a
 * removal never changes what the text around it is read as, and because
 * a cut at the length limit drops whatever it split. It is tested on
 * several hundred thousand generated strings, not proved. The server
 * still masks twice (the route, then group-add.ts).
 *
 * THE DESIGN IS DEFAULT DENY. Digits are removed unless they are part of a
 * shape this file recognises as a time, a price, a date or a year, or
 * there are too few of them to be a bank or phone number. Privacy beats
 * usefulness wherever the two conflict.
 *
 * 1. THE TEXT IS READ THROUGH A NORMALISED COPY. For deciding only, every
 *    character is NFKC-normalised, every Unicode digit becomes 0 to 9,
 *    every kind of space becomes a space, every kind of line break a new
 *    line, every kind of dash a hyphen, letters are lower-cased, and
 *    invisible and combining characters are dropped. An HTML entity
 *    ("&#49;", "&nbsp;") counts as the digit it stands for, or else as a
 *    separator. Each character of the copy remembers where it came from,
 *    so the text that is kept is the organiser's own, untouched outside
 *    the removed spans.
 *
 * 2. LINKS AND EMAIL ADDRESSES GO FIRST, WHOLE.
 *      - A link starts at a scheme ("https://"), at "www.", or at a host
 *        followed by a path ("monzo.me/x"), the earliest of them, and
 *        dots in front are not part of it ("here...monzo.me/x"). A host
 *        with no path is only a word.
 *      - It ends at the first character that cannot be in a link: a
 *        space, a line break, a quote, a square or angle bracket, an
 *        emoji or other symbol. Sentence punctuation at its end and a
 *        closing bracket with no opening one are not part of it. What is
 *        glued after it is read again: a second link, a phone number.
 *      - A link to a map service is kept and its digits are never looked
 *        at (`mapLinkLength` below has the list and the conditions: plain
 *        ASCII as written, Google's own domains, nothing else carried in
 *        it). Every other link becomes "[link removed]": payment links,
 *        wa.me links that carry a phone number, anything else.
 *      - An email address becomes "[email removed]", letters of any
 *        alphabet included.
 *
 * 3. IBANS GO NEXT, WHOLE: a country code that has IBANs, two check
 *    digits, then letters and digits up to exactly that country's length,
 *    with separators or line breaks between them, at least 10 digits in
 *    all, and any group of letters alone being four letters (a bank
 *    code). It becomes "[number removed]". A piece that is not exactly an
 *    IBAN is left to the cluster rule, which removes its digits anyway.
 *
 * 4. A CLUSTER is a maximal stretch of text with no letter in it. Spaces,
 *    NEW LINES, every punctuation mark, symbols and emoji do not end a
 *    cluster; only a letter does. So "1234\n5678", "12/34/56" and
 *    "12,34,56" are each one cluster. A link, an email address or a
 *    placeholder does not end one either: digits on both sides of it are
 *    counted together ("1234 [link removed] 5678"), though it sets a
 *    shape apart as a comma does. A cluster with 3 digits or fewer is
 *    left alone.
 *
 * 5. INSIDE A CLUSTER, THESE SHAPES ARE HONOURED, each checked strictly:
 *      - a clock time: hour 0 to 23, ":" or ".", minutes 00 to 59
 *        ("8:30", "20.30"); a bare hour or a time followed by am or pm
 *        ("8pm", "9.30pm"); a range of two times ("21.00-22.00",
 *        "8-9pm");
 *      - a price: a number with a currency attached, the sign before or
 *        after it (pound, euro, dollar, lira) or the word after it (TL,
 *        GBP, EUR and so on), thousands and decimals in the UK or the
 *        Turkish style ("7.50" with a pound sign, "7,50 TL",
 *        "125.000 TL"), up to 5 digits without a thousands mark and one
 *        thousands mark at most; a range whose second price is the
 *        larger ("100-150 TL"), both round when either has four digits
 *        ("1000-1500 TL" is a range, "1234-5678 TL" is not);
 *      - a date: day 1 to 31 and month 1 to 12 joined by "/", "." or "-"
 *        ("12/10"), with a four-digit year 2020 to 2039 ("12.10.2026",
 *        "2026-10-12"); a two-digit year, or day month year split by
 *        spaces, only with a weekday or month word right beside it
 *        ("Tue 13 10 2026");
 *      - a year 2020 to 2039 standing alone, and a season ("2025-2026",
 *        "2026/27").
 *    A shape is honoured only when it is CLEANLY DELIMITED: the digits
 *    before and after it in the cluster must be at least one space or
 *    line break away. "1:12-34-56", "12.34-56" and "12:34:56" hold no
 *    time: the time is glued to more digits.
 *
 * 6. A SHAPE DOES NOT SHIELD A NUMBER. With nothing but spaces between
 *    them:
 *      - a dotted or dashed pair of digits ("12.34", "12-10"), which
 *        looks as much like a piece of a number as like a time or a date,
 *        stops being honoured beside any loose digit, and beside another
 *        such pair ("12.34 567", "07.30 09.00 12.34");
 *      - any other time, date or price stops being honoured beside two
 *        loose digits or more ("20:45 17 30", "12/10 567"), though not
 *        beside one ("Pitch 3 20:30");
 *      - two years side by side are not years. A year or a season beside
 *        a small count stays ("max 14 2026", "14 2026/27").
 *    What stops being honoured counts as loose digits, and so can stop
 *    the shape next to it in turn.
 *
 *    TWO THINGS ARE LET THROUGH, because short descriptions are written
 *    this way and they are what the description is captured for:
 *      (a) ONE loose group of one or two digits in a cluster is a count
 *          beside the kick-off, and makes no shape give way:
 *          "Mondays 20:30 14 players", "Pitch 12 20:30",
 *          "Every Tuesday 19.30 12 players", "12/10 14 players". Two such
 *          groups, or a group of three digits, are not a count. A dashed
 *          pair and a date split by spaces still give way to it: that is
 *          how a sort code is written ("20-10 25", "Mon 12 10 56").
 *      (b) Exactly two dotted pairs with nothing loose in the cluster are
 *          a date and a time, or two times: "12.10 21.00",
 *          "20.30 21.30".
 *    The price of (a), known and accepted: a sort code written as a time
 *    and a pair ("12:34 56", "12.34 56") stays. Nobody writes one so, and
 *    the account number beside it is removed all the same.
 *
 * 7. THE DECISION, per cluster, on the digits that no honoured shape
 *    accounts for (the leftover):
 *      - 6 or more: every leftover digit in the cluster is removed;
 *      - 4 or more, in a cluster that also holds an honoured shape: the
 *        same;
 *      - fewer: everything stays.
 *    When digits are removed, an honoured shape with only spaces between
 *    it and a removed digit goes with them ("1:12 34 56", a price before
 *    a phone number). A shape set apart by a line break, a comma, a
 *    semicolon, a full stop or a spaced dash stays
 *    ("KO 20:30 - 07700 900123"). Runs of removed digits that touch
 *    become ONE "[number removed]", so no half of a number is ever left.
 *
 * 8. WHAT IS LEFT OF A CARD. On a line a number was removed from, "exp",
 *    "cvv", "cvc" or "son kullanma" followed by a date or a group of 3 or
 *    4 digits is removed too.
 *
 * WHAT IS NOT HONOURED, on purpose. A small count has no shape of its own
 * ("9 a side", "max 14"): it survives because it is few digits, and it is
 * removed with the rest when it shares a cluster with a number. A date
 * with a two-digit year and nothing beside it ("12/10/26") is removed:
 * that is exactly what a sort code looks like.
 *
 * WHAT IS NOT REMOVED: names, post codes, numbers written out in words,
 * and anything deliberately disguised: digits split by words or letters
 * ("12a34b56"), letters used as digits ("O77OO"), a number hidden as a
 * list of times or prices. A sort code that reads as a date beside a day
 * word ("09-01-28 Mon") stays; the account number beside it does not.
 */

/** What every removed number is replaced with. */
export const NUMBER_REMOVED = "[number removed]";
/** What every link that is not a map link is replaced with. */
export const LINK_REMOVED = "[link removed]";
/** What every email address is replaced with. */
export const EMAIL_REMOVED = "[email removed]";
const PLACEHOLDERS = [NUMBER_REMOVED, LINK_REMOVED, EMAIL_REMOVED];

/**
 * The longest description accepted, and the longest stored, in UTF-16
 * units. WhatsApp's own limit is about 2,048 characters; twice that leaves
 * room for the limit to grow and for masking to lengthen the text.
 * Anything longer did not come from WhatsApp and is dropped whole, never
 * cut before it is masked.
 */
export const GROUP_DESCRIPTION_MAX_CHARS = 4096;

// ── 1. The normalised copy ──────────────────────────────────────────────

const SEP = 0;
const DIG = 1;
const LET = 2;
/**
 * A link, an email address, an IBAN or a placeholder: dealt with, and one
 * token to every rule after it. Nothing reads into it, nothing takes its
 * letters for words, and it is never altered, split or absorbed.
 */
const BLOCK = 3;
/** What a BLOCK looks like from inside a cluster: one opaque mark. */
const GAP = "\ue000";

/** A separator with no meaning of its own (an emoji, an entity). */
const OPAQUE = "\ufffc";

interface Piece {
  /** The characters of the copy this code point becomes ("" when dropped). */
  a: string;
  /** Their kinds, one per character. */
  k: number[];
}

const ASCII: Piece[] = [];
for (let c = 0; c < 128; c++) {
  const ch = String.fromCharCode(c);
  if (c >= 48 && c <= 57) ASCII.push({ a: ch, k: [DIG] });
  else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) ASCII.push({ a: ch.toLowerCase(), k: [LET] });
  else if (c === 9 || c === 32) ASCII.push({ a: " ", k: [SEP] });
  else if (c >= 10 && c <= 13) ASCII.push({ a: "\n", k: [SEP] });
  else if (c < 32 || c === 127) ASCII.push({ a: "", k: [] });
  else ASCII.push({ a: ch, k: [SEP] });
}

const RE_ND = /\p{Nd}/u;
const RE_NO = /\p{No}/u;
const RE_INVISIBLE = /[\p{Cf}\p{Mn}\p{Me}\p{Mc}\p{Cc}]/u;
const RE_LETTER = /[\p{L}\p{Nl}]/u;
const RE_LINE = /[\p{Zl}\p{Zp}]/u;
const RE_SPACE = /\p{Zs}/u;
const RE_DASH = /\p{Pd}/u;
const RE_PRIVATE = /\p{Co}/u;
/** Letters by category that show nothing: the Hangul fillers. */
const FILLERS = new Set([0x115f, 0x1160, 0x3164, 0xffa0]);
const TURKISH: Record<string, string> = {
  "\u0131": "i",
  "\u0130": "i",
  "\u015f": "s",
  "\u015e": "s",
  "\u00e7": "c",
  "\u00c7": "c",
  "\u011f": "g",
  "\u011e": "g",
  "\u00f6": "o",
  "\u00d6": "o",
  "\u00fc": "u",
  "\u00dc": "u",
};

/** The value of a decimal digit of any script: digits sit in runs of ten. */
function digitOf(cp: number): string {
  let v = 0;
  while (v < 9 && cp - v - 1 > 0 && RE_ND.test(String.fromCodePoint(cp - v - 1))) v++;
  return String(v);
}

function pieceOfNormalised(cp: number, a: string[], k: number[]): void {
  if (cp < 128) {
    a.push(ASCII[cp].a);
    k.push(...ASCII[cp].k);
    return;
  }
  const ch = String.fromCodePoint(cp);
  if (FILLERS.has(cp)) return;
  if (RE_ND.test(ch)) {
    a.push(digitOf(cp));
    k.push(DIG);
  } else if (RE_NO.test(ch)) {
    // A numeric character with no plain digit behind it (a dingbat digit).
    a.push("9");
    k.push(DIG);
  } else if (RE_INVISIBLE.test(ch)) {
    return;
  } else if (RE_LETTER.test(ch)) {
    const folded = TURKISH[ch] ?? ch.toLowerCase();
    a.push(folded.length === 1 ? (TURKISH[folded] ?? folded) : "x");
    k.push(LET);
  } else if (RE_LINE.test(ch) || cp === 0x85) {
    a.push("\n");
    k.push(SEP);
  } else if (RE_SPACE.test(ch)) {
    a.push(" ");
    k.push(SEP);
  } else if (RE_DASH.test(ch) || cp === 0x2212) {
    a.push("-");
    k.push(SEP);
  } else {
    // A symbol. One this file gives a meaning of its own (private use,
    // where GAP lives) is only ever an opaque separator.
    a.push(cp <= 0xffff && !RE_PRIVATE.test(ch) ? ch : OPAQUE);
    k.push(SEP);
  }
}

const pieceCache = new Map<number, Piece>();

function pieceOf(cp: number): Piece {
  if (cp < 128) return ASCII[cp];
  const hit = pieceCache.get(cp);
  if (hit) return hit;
  const a: string[] = [];
  const k: number[] = [];
  let normal: string;
  try {
    normal = String.fromCodePoint(cp).normalize("NFKC");
  } catch {
    normal = OPAQUE;
  }
  for (const c of normal) pieceOfNormalised(c.codePointAt(0)!, a, k);
  // ONE character that is digits and letters at once ("m/s2" in a single
  // sign) is digits and separators: a letter that vanishes with its digit
  // when the digit is removed must not have ended a cluster.
  if (k.includes(DIG) && k.includes(LET)) {
    for (let x = 0; x < k.length; x++) {
      if (k[x] === LET) {
        k[x] = SEP;
        a[x] = OPAQUE;
      }
    }
  }
  const piece = { a: a.join(""), k };
  if (pieceCache.size > 4096) pieceCache.clear();
  pieceCache.set(cp, piece);
  return piece;
}

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|[A-Za-z][A-Za-z0-9]{1,31});/y;

interface Copy {
  /** The normalised copy. One UTF-16 unit per character. */
  a: string;
  kind: number[];
  /** Where each character of the copy starts and ends in the text. */
  from: number[];
  to: number[];
}

function normalisedCopy(text: string): Copy {
  const a: string[] = [];
  const kind: number[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  while (i < text.length) {
    const unit = text.charCodeAt(i);
    if (unit === 38) {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(text);
      if (m) {
        // The digit it stands for, or else a separator. Never a letter:
        // an entity must not be a way to end a cluster.
        let ch = OPAQUE;
        let kd = SEP;
        const cp = m[1] ? Number(m[1]) : m[2] ? parseInt(m[2], 16) : -1;
        if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
          const p = pieceOf(cp);
          if (p.a.length === 1 && p.k[0] === DIG) {
            ch = p.a;
            kd = DIG;
          }
        }
        a.push(ch);
        kind.push(kd);
        from.push(i);
        to.push(i + m[0].length);
        i += m[0].length;
        continue;
      }
    }
    let cp = unit;
    let len = 1;
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = (unit - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        len = 2;
      }
    }
    if (cp >= 0xd800 && cp <= 0xdfff) {
      // A lone surrogate: not text. A separator.
      a.push(OPAQUE);
      kind.push(SEP);
      from.push(i);
      to.push(i + 1);
    } else {
      const p = pieceOf(cp);
      for (let j = 0; j < p.a.length; j++) {
        a.push(p.a[j]);
        kind.push(p.k[j]);
        from.push(i);
        to.push(i + len);
      }
    }
    i += len;
  }
  return { a: a.join(""), kind, from, to };
}

/**
 * Mark [s, e) of the copy as a BLOCK, widened to whole characters of the
 * text: when one original character is several in the copy and any of
 * them is in a link, an email address or an IBAN, all of them are (the
 * whole character is what gets replaced). Returns the widened ends.
 */
function block(copy: Copy, s: number, e: number): [number, number] {
  const { kind, from } = copy;
  while (s > 0 && from[s - 1] === from[s]) s--;
  while (e < kind.length && from[e] === from[e - 1]) e++;
  for (let x = s; x < e; x++) kind[x] = BLOCK;
  return [s, e];
}

// ── 2. Links and email addresses ────────────────────────────────────────

/** A span of the copy to replace (`text`) or to keep untouched (null). */
interface Span {
  s: number;
  e: number;
  text: string | null;
  /** "shape" and "map" are kept as they are; reported for the tests. */
  what: "number" | "link" | "email" | "map" | "shape";
}

const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/;
/** Google's own country domains: "maps.google.<one of these>" and "google.<one of these>/maps". */
const GOOGLE_DOMAINS = new Set([
  "com", "co.uk", "com.tr", "de", "fr", "es", "it", "nl", "ie", "pt", "be", "ch", "at", "se", "no", "dk", "pl", "gr",
  "ca", "com.au",
]);
/** Map services whose links are long and may hold coordinates. */
const LONG_MAP_HOSTS = new Set([
  "maps.apple.com",
  "maps.apple",
  "waze.com",
  "ul.waze.com",
  "openstreetmap.org",
  "osm.org",
  "maps.yandex.com",
  "maps.yandex.com.tr",
  "maps.yandex.ru",
]);
/**
 * Yandex's main hosts. They serve every Yandex product, so a link is a
 * map link only under "/maps" or "/harita" (its Turkish name).
 */
const YANDEX_HOSTS = new Set(["yandex.com", "yandex.com.tr", "yandex.ru"]);
const YANDEX_MAPS_PATH = /^\/(?:maps|harita)(?=[/?#]|$)/;
/** Yandex's short share link: "/maps/-/<code>", the code one path piece. */
const YANDEX_SHORT_PATH = /^\/(?:maps|harita)\/-\/[a-z0-9._~-]+/;
/** Map services whose links are a short code or three words. */
const SHORT_MAP_HOSTS = new Set(["maps.app.goo.gl", "goo.gl", "what3words.com", "w3w.co"]);
const SHORT_PATH = /^\/[a-z0-9._/-]*/;
const PLAIN_ASCII = /^[\x21-\x7e]+$/;
/** Digits in a row that a map link may hold: coordinates run to 8 decimals. */
const LONG_LINK_DIGITS = /\d{9}/;
/** And a short link's code: letters and digits mixed, never 7 digits in a row. */
const SHORT_LINK_DIGITS = /\d{7}/;
const OTHER_LINK_INSIDE = /:\/\/|(?:^|[^a-z0-9])www\.|[a-z0-9-]\.[a-z]{2,24}\/|@(?![\d-])/;

/**
 * How much of `url`, from its start, is a link to a map: its whole length,
 * less for a short link with something glued after its code, 0 when it is
 * not a map link at all. `url` is the ORGANISER'S OWN characters, not the
 * normalised copy: a map host is plain ASCII exactly as written, so a
 * look-alike (an accented "o" in "google", a zero-width space in the host) is
 * never one. THE allow-list:
 *
 *   maps.google.<Google domain>      any path          (long)
 *   google.<Google domain>/maps...   only under /maps  (long)
 *   maps.apple.com, maps.apple       any path          (long)
 *   waze.com, ul.waze.com            any path          (long)
 *   openstreetmap.org, osm.org       any path          (long)
 *   maps.yandex.com, .com.tr, .ru    any path          (long)
 *   yandex.com, .com.tr, .ru         only under /maps or /harita (long)
 *   the same, /maps/-/<code>         a short code      (short)
 *   maps.app.goo.gl                  a short code      (short)
 *   goo.gl/maps/...                  a short code      (short)
 *   what3words.com, w3w.co           three words       (short)
 *
 * each with or without "www." and with http, https or no scheme. A host
 * with a user part or a port is never a map link.
 *
 * A LONG link may hold commas and an "@" before coordinates. It is not a
 * map link when it carries something else: another link or scheme, "www.",
 * an "@" before anything but a coordinate, or 9 digits in a row.
 *
 * A SHORT link is its host and a path of letters, digits, dots, hyphens,
 * underscores and slashes: it ENDS at anything else (a comma, a bracket, a
 * question mark), and what follows is judged as ordinary text. It is not a
 * map link with 7 digits in a row in it.
 */
function mapLinkLength(url: string): number {
  if (!PLAIN_ASCII.test(url)) return 0;
  let rest = url.toLowerCase();
  let offset = 0;
  const scheme = /^https?:\/\//.exec(rest);
  if (scheme) {
    offset = scheme[0].length;
    rest = rest.slice(offset);
  } else if (/^[a-z][a-z0-9+.-]*:\/\//.test(rest)) {
    return 0;
  }
  const cut = rest.search(/[/?#]/);
  const hostPart = cut === -1 ? rest : rest.slice(0, cut);
  const path = cut === -1 ? "" : rest.slice(cut);
  if (hostPart.includes("@") || hostPart.includes(":")) return 0;
  const host = hostPart.startsWith("www.") ? hostPart.slice(4) : hostPart;
  if (!HOST.test(host)) return 0;

  if (SHORT_MAP_HOSTS.has(host)) {
    let kept = SHORT_PATH.exec(path)?.[0] ?? "";
    while (kept.endsWith(".")) kept = kept.slice(0, -1);
    if (host === "goo.gl" && !kept.startsWith("/maps/")) return 0;
    if (SHORT_LINK_DIGITS.test(kept) || OTHER_LINK_INSIDE.test(kept)) return 0;
    return offset + hostPart.length + kept.length;
  }

  if (YANDEX_HOSTS.has(host)) {
    if (!YANDEX_MAPS_PATH.test(path)) return 0;
    const short = YANDEX_SHORT_PATH.exec(path);
    if (short) {
      let kept = short[0];
      while (kept.endsWith(".")) kept = kept.slice(0, -1);
      if (SHORT_LINK_DIGITS.test(kept) || OTHER_LINK_INSIDE.test(kept)) return 0;
      return offset + hostPart.length + kept.length;
    }
  }

  let known = LONG_MAP_HOSTS.has(host) || YANDEX_HOSTS.has(host);
  if (!known && host.startsWith("maps.google.")) known = GOOGLE_DOMAINS.has(host.slice(12));
  if (!known && host.startsWith("google.") && GOOGLE_DOMAINS.has(host.slice(7))) {
    known = path === "/maps" || path.startsWith("/maps/") || path.startsWith("/maps?");
  }
  if (!known) return 0;
  if (LONG_LINK_DIGITS.test(path) || OTHER_LINK_INSIDE.test(path)) return 0;
  return url.length;
}

/** Is the whole of `url`, as the organiser wrote it, a link to a map? */
export function isMapLink(url: string): boolean {
  return url.length > 0 && mapLinkLength(url) === url.length;
}

/** Punctuation a link may hold. Not quotes, not square or angle brackets. */
const URL_PUNCTUATION = "-._~:/?#@!$&()*+,;=%";
const SENTENCE_PUNCTUATION = ".,;:!?";
const MAX_SCHEME = 15;

/**
 * Find every link, left to right, the EARLIEST start first. A link starts
 * at a scheme ("https://"), at "www.", or at a host with a path
 * ("monzo.me/x"), and dots in front of it are not part of it
 * ("here...monzo.me/x"). It runs on over letters, digits and link
 * punctuation and ENDS at the first character that cannot be in a link: a
 * space, a line break, a quote, a square or angle bracket, an emoji or any
 * other symbol, a placeholder. Sentence punctuation at its end, and a
 * closing bracket with no opening one, are not part of it. Whatever comes
 * after is scanned again, so a second link, or a number, glued to the
 * first is still found.
 */
function findLinks(copy: Copy, text: string, spans: Span[]): void {
  const { a, kind } = copy;
  const n = a.length;
  const alnum = (i: number) => kind[i] === LET || kind[i] === DIG;
  const hostChar = (i: number) => alnum(i) || (kind[i] === SEP && (a[i] === "." || a[i] === "-"));
  const urlChar = (i: number) => alnum(i) || (kind[i] === SEP && URL_PUNCTUATION.includes(a[i]));

  let i = 0;
  while (i < n) {
    if (!hostChar(i)) {
      i++;
      continue;
    }
    let r = i;
    while (r < n && hostChar(r)) r++;
    // The run [i, r) of host characters. Where could a link start in it?
    let start = -1;
    // The last label of the run: the piece after its last dot.
    let lastLabel = r;
    while (lastLabel > i && a[lastLabel - 1] !== ".") lastLabel--;
    if (a.startsWith("://", r) && kind[r] === SEP) {
      // A scheme: the plain letters that end the run. Digits before them
      // are not part of it ("12345https://" is a number and a link), so a
      // number removed from in front of a link never changes the link.
      let s = r;
      while (s > lastLabel && kind[s - 1] === LET && a.charCodeAt(s - 1) < 128) s--;
      if (s < r && r - s <= MAX_SCHEME) start = s;
    }
    {
      // "www." with no letter before it, and more after it.
      for (let w = i; w + 4 < r; w++) {
        if ((w === i || kind[w - 1] !== LET) && a.startsWith("www.", w) && kind[w + 3] === SEP) {
          if (start === -1 || w < start) start = w;
          break;
        }
      }
      // A host with a path: the labels that end the run, back to the first
      // empty one (two dots in a row), with letters for the last.
      if (r + 1 < n && a[r] === "/" && kind[r] === SEP && urlChar(r + 1)) {
        const tld = r - lastLabel;
        let lettersOnly = tld >= 2 && tld <= 24;
        for (let x = lastLabel; lettersOnly && x < r; x++) if (kind[x] !== LET) lettersOnly = false;
        if (lettersOnly) {
          let s = lastLabel;
          let labels = 1;
          // A dot at s - 1 with a label, not another dot, before it.
          while (s - 1 > i && a[s - 1] === "." && a[s - 2] !== ".") {
            let b = s - 1;
            while (b > i && a[b - 1] !== ".") b--;
            s = b;
            labels++;
          }
          if (labels >= 2 && (start === -1 || s < start)) start = s;
        }
      }
    }
    if (start === -1) {
      i = r;
      continue;
    }

    let e = start;
    let open = 0;
    let close = 0;
    while (e < n && urlChar(e)) {
      if (a[e] === "(") open++;
      else if (a[e] === ")") close++;
      e++;
    }
    while (e > start + 1) {
      const c = a[e - 1];
      if (kind[e - 1] !== SEP) break;
      if (SENTENCE_PUNCTUATION.includes(c)) e--;
      else if (c === ")" && close > open) {
        close--;
        e--;
      } else break;
    }

    // A map link is judged on the organiser's own characters.
    const original = text.slice(copy.from[start], copy.to[e - 1]);
    const kept = original.length === e - start ? mapLinkLength(original) : 0;
    if (kept > 0) e = start + kept;
    const [s, end] = block(copy, start, e);
    spans.push({ s, e: end, text: kept > 0 ? null : LINK_REMOVED, what: kept > 0 ? "map" : "link" });
    i = end;
  }
}

/**
 * Find every email address: something, "@", and a host that ends in a dot
 * and two letters or more. Letters of any alphabet count (an accented name,
 * an accented host), and the address ends with its last such ending, so
 * what is glued after it is left to be judged ("...@gmail.com-Kemal",
 * "...@gmail.com07700900123").
 */
function findEmails(copy: Copy, spans: Span[]): void {
  const { a, kind } = copy;
  const n = a.length;
  const alnum = (i: number) => kind[i] === LET || kind[i] === DIG;
  const local = (i: number) => alnum(i) || (kind[i] === SEP && "._%+-".includes(a[i]));
  const domain = (i: number) => alnum(i) || (kind[i] === SEP && (a[i] === "." || a[i] === "-"));
  let at = a.indexOf("@");
  while (at !== -1) {
    let next = at + 1;
    if (kind[at] === SEP) {
      let s = at;
      while (s > 0 && local(s - 1)) s--;
      while (s < at && !alnum(s)) s++;
      let e = at + 1;
      while (e < n && domain(e)) e++;
      let end = -1;
      for (let d = e - 1; d > at + 1 && end === -1; d--) {
        if (a[d] !== ".") continue;
        let l = d + 1;
        while (l < e && kind[l] === LET) l++;
        if (l - d - 1 >= 2) end = l;
      }
      if (s < at && end !== -1) {
        const [bs, be] = block(copy, s, end);
        spans.push({ s: bs, e: be, text: EMAIL_REMOVED, what: "email" });
        next = be;
      }
    }
    at = a.indexOf("@", next);
  }
}

// ── 3. IBANs ────────────────────────────────────────────────────────────

/** IBAN length by country code (the SWIFT registry). */
const IBAN_LENGTH: Record<string, number> = {
  ad: 24, ae: 23, al: 28, at: 20, az: 28, ba: 20, be: 16, bg: 22, bh: 22, br: 29, by: 28, ch: 21, cr: 22, cy: 28,
  cz: 24, de: 22, dk: 18, do: 28, ee: 20, eg: 29, es: 24, fi: 18, fo: 18, fr: 27, gb: 22, ge: 22, gi: 23, gl: 18,
  gr: 27, gt: 28, hr: 21, hu: 28, ie: 22, il: 23, iq: 23, is: 26, it: 27, jo: 30, kw: 30, kz: 20, lb: 28, lc: 32,
  li: 21, lt: 20, lu: 20, lv: 21, mc: 27, md: 24, me: 22, mk: 19, mr: 27, mt: 31, mu: 30, nl: 18, no: 15, pk: 24,
  pl: 28, ps: 29, pt: 25, qa: 29, ro: 24, rs: 22, sa: 24, sc: 31, se: 24, si: 19, sk: 24, sm: 27, so: 23, st: 25,
  sv: 28, tl: 23, tn: 24, tr: 26, ua: 29, va: 22, vg: 24, xk: 20,
};
/** Separators allowed between two characters of one IBAN. */
const IBAN_MAX_GAP = 4;

const isAsciiAlnum = (c: number) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57);

function findIbans(copy: Copy, spans: Span[]): void {
  const { a, kind } = copy;
  const n = a.length;
  let i = 0;
  while (i + 3 < n) {
    if (
      kind[i] !== LET ||
      kind[i + 1] !== LET ||
      kind[i + 2] === LET ||
      (i > 0 && (kind[i - 1] === LET || kind[i - 1] === DIG))
    ) {
      i++;
      continue;
    }
    const length = IBAN_LENGTH[a.slice(i, i + 2)];
    if (!length) {
      i++;
      continue;
    }
    // Take whole runs of letters and digits, never part of one, until the
    // country's length is reached.
    let p = i + 2;
    let taken = 2;
    let digits = 0;
    let end = i + 2;
    let checkDigits = "";
    while (taken < length) {
      let q = p;
      while (q < n && kind[q] === SEP && q - p < IBAN_MAX_GAP) q++;
      if (q >= n || (kind[q] !== DIG && kind[q] !== LET)) break;
      let r = q;
      while (r < n && r - q <= length && (kind[r] === DIG || kind[r] === LET) && isAsciiAlnum(a.charCodeAt(r))) r++;
      if (r === q || taken + (r - q) > length) break;
      if (r < n && (kind[r] === DIG || kind[r] === LET)) break;
      let runDigits = 0;
      for (let x = q; x < r; x++) {
        if (kind[x] === DIG) runDigits++;
        if (checkDigits.length < 2) checkDigits += kind[x] === DIG ? "d" : "l";
      }
      // A group of letters alone is a bank code, which is four letters. A
      // word of any other length is not part of an IBAN.
      if (runDigits === 0 && r - q !== 4) break;
      digits += runDigits;
      taken += r - q;
      p = r;
      end = r;
    }
    // The country's exact length: a shorter or longer piece is left to the
    // cluster rule, which removes its digits all the same.
    if (taken === length && digits >= 10 && checkDigits === "dd") {
      const [bs, be] = block(copy, i, end);
      spans.push({ s: bs, e: be, text: NUMBER_REMOVED, what: "number" });
      i = be;
    } else {
      i++;
    }
  }
}

// ── 4 to 7. Clusters ────────────────────────────────────────────────────

const DAY_WORDS = new Set([
  "mon", "monday", "mondays", "tue", "tues", "tuesday", "tuesdays", "wed", "weds", "wednesday", "wednesdays", "thu",
  "thur", "thurs", "thursday", "thursdays", "fri", "friday", "fridays", "sat", "saturday", "saturdays", "sun", "sunday",
  "sundays", "pazartesi", "pzt", "sali", "sal", "carsamba", "car", "persembe", "per", "cuma", "cum", "cumartesi", "cmt",
  "pazar", "paz", "jan", "january", "feb", "february", "mar", "march", "apr", "april", "may", "jun", "june", "jul",
  "july", "aug", "august", "sep", "sept", "september", "oct", "october", "nov", "november", "dec", "december", "ocak",
  "subat", "mart", "nisan", "mayis", "haziran", "temmuz", "agustos", "eylul", "ekim", "kasim", "aralik",
]);
const CURRENCY_WORDS = new Set(["tl", "try", "gbp", "eur", "usd", "lira", "euro", "euros", "pound", "pounds", "quid"]);
const CURRENCY_BEFORE = /[£€$₺] ?$/;
const CURRENCY_AFTER = /^ ?[£€$₺]/;
const RANGE_DASH = /^ ?- ?$/;
const PRICE_RANGE_DASH = /^ ?- ?[£€$₺]? ?$/;
const NEAR_WORD = /^[ ,.]{0,2}$/;
/** A break that sets a shape apart from what is beside it. */
const HARD_BREAK = /\n|[,;.)] | - | \(|\ue000/;
const MAX_WORD = 12;

const hasSpace = (s: string) => s.includes(" ") || s.includes("\n") || s.includes(GAP);
const isYear = (s: string) => s.length === 4 && s >= "2020" && s <= "2039";
/** The same years written with two digits. */
const isShortYear = (s: string) => s.length === 2 && s >= "20" && s <= "39";

type ShapeClass = "strong" | "weak" | "year";
/**
 * How a shape is written, where a rule needs to know: a dotted pair, a
 * dashed pair, a dotted range, and a date whose parts are split by spaces
 * (honoured for the day word beside it).
 */
type WeakForm = "dot" | "dash" | "range" | "spaced";
interface Shape {
  j: number;
  cls: ShapeClass;
  form?: WeakForm;
  /** For a dotted pair: does it read as a time, and as a date? */
  time?: boolean;
  date?: boolean;
}
interface Unit {
  /** First and last digit group it covers. */
  i: number;
  j: number;
  cls: ShapeClass | "loose";
  form?: WeakForm;
  time?: boolean;
  date?: boolean;
  digits: number;
  masked: boolean;
}

/** One cluster, parsed. Everything a shape may look at. */
interface Cluster {
  /** The digit groups, and where each sits in the copy. */
  tok: string[];
  ts: number[];
  te: number[];
  /** `sep[k]` is what stands between group k and group k + 1. */
  sep: string[];
  pre: string;
  post: string;
  leftWord: string;
  rightWord: string;
}

function priceNumber(c: Cluster, i: number, maxPlain: number): number {
  const t = c.tok[i];
  if (t.length > 1 && t[0] === "0") return -1;
  const n = c.tok.length;
  const mark = (k: number) => k < n - 1 && (c.sep[k] === "." || c.sep[k] === ",");
  // One thousands mark at most: "125.000", "1.250,00". Millions are not a
  // match fee, and "12.345.678" is an account number.
  if (t.length <= 3 && mark(i) && c.tok[i + 1].length === 3) {
    const k = i + 1;
    return mark(k) && c.tok[k + 1].length <= 2 ? k + 1 : k;
  }
  if (t.length > maxPlain) return -1;
  return mark(i) && c.tok[i + 1].length <= 2 ? i + 1 : i;
}

/** The whole units of the price in groups i to j, pence left out. */
function priceUnits(c: Cluster, i: number, j: number): string {
  const last = j > i && c.tok[j].length <= 2 ? j - 1 : j;
  return c.tok.slice(i, last + 1).join("");
}

/**
 * Do two prices make a range? The second must be the larger, and when
 * either has four digits or more both must be round (a multiple of 50):
 * "1000-1500 TL" is a range, "1234-5678 TL" is an account number.
 */
function isPriceRange(low: string, high: string): boolean {
  if (Number(high) <= Number(low)) return false;
  if (low.length < 4 && high.length < 4) return true;
  return Number(low) % 50 === 0 && Number(high) % 50 === 0;
}

function currencyBefore(c: Cluster, i: number): boolean {
  if (CURRENCY_BEFORE.test(i === 0 ? c.pre : c.sep[i - 1])) return true;
  return i === 0 && (c.pre === "" || c.pre === " ") && CURRENCY_WORDS.has(c.leftWord);
}

function currencyAfter(c: Cluster, j: number): boolean {
  const last = j === c.tok.length - 1;
  if (CURRENCY_AFTER.test(last ? c.post : c.sep[j])) return true;
  return last && (c.post === "" || c.post === " ") && CURRENCY_WORDS.has(c.rightWord);
}

/** A time starting at group i: its last group and how it is written. */
function timeAt(c: Cluster, i: number): { j: number; form: "colon" | "dot" | "bare" } | null {
  const h = c.tok[i];
  if (h.length > 2 || Number(h) > 23) return null;
  if (i + 1 < c.tok.length && (c.sep[i] === ":" || c.sep[i] === ".")) {
    const m = c.tok[i + 1];
    if (m.length === 2 && Number(m) <= 59) return { j: i + 1, form: c.sep[i] === ":" ? "colon" : "dot" };
  }
  return { j: i, form: "bare" };
}

const amPmAfter = (c: Cluster, j: number) =>
  j === c.tok.length - 1 && (c.post === "" || c.post === " ") && (c.rightWord === "am" || c.rightWord === "pm");

const dayWordBeside = (c: Cluster, i: number, j: number) =>
  (i === 0 && NEAR_WORD.test(c.pre) && DAY_WORDS.has(c.leftWord)) ||
  (j === c.tok.length - 1 && NEAR_WORD.test(c.post) && DAY_WORDS.has(c.rightWord));

function dayMonth(d: string, m: string): boolean {
  return d.length <= 2 && m.length <= 2 && Number(d) >= 1 && Number(d) <= 31 && Number(m) >= 1 && Number(m) <= 12;
}

/** Every shape that could start at group i, longest and strictest first. */
function shapesAt(c: Cluster, i: number): Shape[] {
  const out: Shape[] = [];
  const n = c.tok.length;
  const t0 = c.tok[i];
  const s0 = i < n - 1 ? c.sep[i] : null;
  const t1 = i + 1 < n ? c.tok[i + 1] : null;
  const s1 = i + 1 < n - 1 ? c.sep[i + 1] : null;
  const t2 = i + 2 < n ? c.tok[i + 2] : null;

  // A date with its year.
  if (t1 && t2 && s0 === s1 && (s0 === "/" || s0 === "." || s0 === "-")) {
    if (dayMonth(t0, t1) && (isYear(t2) || (isShortYear(t2) && dayWordBeside(c, i, i + 2)))) {
      out.push({ j: i + 2, cls: "strong" });
    }
    if (s0 === "-" && isYear(t0) && dayMonth(t2, t1)) out.push({ j: i + 2, cls: "strong" });
  }
  // Day month (year) split by spaces: only with a day or month word beside it.
  if (t1 && s0 === " " && dayMonth(t0, t1)) {
    if (t2 && s1 === " " && (isYear(t2) || isShortYear(t2)) && dayWordBeside(c, i, i + 2)) {
      out.push({ j: i + 2, cls: "strong", form: "spaced" });
    }
    if (dayWordBeside(c, i, i + 1)) out.push({ j: i + 1, cls: "strong", form: "spaced" });
  }
  // A season.
  if (t1 && (s0 === "-" || s0 === "/") && isYear(t0)) {
    const next = Number(t0) + 1;
    if ((t1.length === 4 && Number(t1) === next) || (t1.length === 2 && Number(t1) === next % 100)) {
      out.push({ j: i + 1, cls: "year" });
    }
  }
  // A price range, then a price.
  const p1 = priceNumber(c, i, 4);
  if (p1 !== -1 && p1 + 1 < n && PRICE_RANGE_DASH.test(c.sep[p1])) {
    const p2 = priceNumber(c, p1 + 1, 4);
    if (
      p2 !== -1 &&
      isPriceRange(priceUnits(c, i, p1), priceUnits(c, p1 + 1, p2)) &&
      (currencyBefore(c, i) || currencyAfter(c, p2) || CURRENCY_BEFORE.test(c.sep[p1]))
    ) {
      out.push({ j: p2, cls: "strong" });
    }
  }
  const p = priceNumber(c, i, 5);
  if (p !== -1 && (currencyBefore(c, i) || currencyAfter(c, p))) out.push({ j: p, cls: "strong" });
  // A range of times, then a time.
  const a = timeAt(c, i);
  if (a) {
    if (a.j + 1 < n && RANGE_DASH.test(c.sep[a.j])) {
      const b = timeAt(c, a.j + 1);
      if (b) {
        const amPm = amPmAfter(c, b.j);
        if (a.form === "bare" || b.form === "bare") {
          if (amPm) out.push({ j: b.j, cls: "strong" });
        } else {
          if (amPm || a.form === "colon" || b.form === "colon") out.push({ j: b.j, cls: "strong" });
          else out.push({ j: b.j, cls: "weak", form: "range" });
        }
      }
    }
    const amPm = amPmAfter(c, a.j);
    if (a.form === "colon" || amPm) out.push({ j: a.j, cls: "strong" });
    else if (a.form === "dot") out.push({ j: a.j, cls: "weak", form: "dot", time: true, date: !!t1 && dayMonth(t0, t1) });
  }
  // Day and month.
  if (t1 && dayMonth(t0, t1)) {
    if (s0 === "/") out.push({ j: i + 1, cls: "strong" });
    else if (s0 === "-") out.push({ j: i + 1, cls: "weak", form: "dash" });
    else if (s0 === ".") out.push({ j: i + 1, cls: "weak", form: "dot", time: false, date: true });
  }
  if (isYear(t0)) out.push({ j: i, cls: "year" });
  return out;
}

function decideCluster(c: Cluster, spans: Span[]): void {
  const n = c.tok.length;
  const clean = (i: number, j: number) => (i === 0 || hasSpace(c.sep[i - 1])) && (j === n - 1 || hasSpace(c.sep[j]));

  // 5. Honoured shapes, left to right.
  const units: Unit[] = [];
  let i = 0;
  while (i < n) {
    const shape = shapesAt(c, i).find((s) => clean(i, s.j));
    const j = shape ? shape.j : i;
    let digits = 0;
    for (let k = i; k <= j; k++) digits += c.tok[k].length;
    units.push({ i, j, cls: shape ? shape.cls : "loose", form: shape?.form, time: shape?.time, date: shape?.date, digits, masked: false });
    i = j + 1;
  }

  // 6. A shape does not shield a number, with two things let through.
  const beside = (k: number) => !HARD_BREAK.test(c.sep[units[k].j]); // unit k and unit k + 1
  const loose = units.filter((u) => u.cls === "loose");
  const weak = units.filter((u) => u.cls === "weak");
  // (a) ONE loose group of one or two digits is a count beside the
  //     kick-off ("20:30 14 players", "Pitch 12 20:30"), not a number.
  const count = loose.length === 1 && loose[0].digits <= 2 ? loose[0] : null;
  // (b) Exactly two dotted pairs and nothing loose: a date and a time
  //     ("12.10 21.00"), or two times ("20.30 21.30").
  const dateAndTime =
    loose.length === 0 &&
    weak.length === 2 &&
    weak[0].form === "dot" &&
    weak[1].form === "dot" &&
    !!weak[1].time &&
    (!!weak[0].date || !!weak[0].time);

  const demote = new Array<boolean>(units.length).fill(false);
  for (let k = 0; k + 1 < units.length; k++) {
    const x = units[k].cls;
    const y = units[k + 1].cls;
    if (beside(k) && ((x === "weak" && y === "weak" && !dateAndTime) || (x === "year" && y === "year"))) {
      demote[k] = true;
      demote[k + 1] = true;
    }
  }
  for (let k = 0; k < units.length; k++) if (demote[k]) units[k].cls = "loose";
  // Beside loose digits: a weak shape always gives way; a time, a date or
  // a price gives way to two loose digits or more ("20:45 17 30"), not to
  // one ("Pitch 3 20:30"). A year does not give way ("max 14 2026"). The
  // count of (a) makes nothing give way, except a dashed pair and a date
  // split by spaces: that is how a sort code is written ("20-10 25",
  // "Mon 12 10 56").
  const givesWay = (u: Unit, other: Unit) =>
    other.cls === "loose" &&
    !(other === count && u.form !== "dash" && u.form !== "spaced") &&
    (u.cls === "weak" || (u.cls === "strong" && other.digits >= 2));
  for (let k = 1; k < units.length; k++) {
    if (beside(k - 1) && givesWay(units[k], units[k - 1])) units[k].cls = "loose";
  }
  for (let k = units.length - 2; k >= 0; k--) {
    if (beside(k) && givesWay(units[k], units[k + 1])) units[k].cls = "loose";
  }

  // 7. The decision.
  let leftover = 0;
  let shapes = 0;
  for (const u of units) {
    if (u.cls === "loose") leftover += u.digits;
    else shapes++;
  }
  const remove = leftover >= 6 || (shapes > 0 && leftover >= 4);
  if (remove) {
    for (const u of units) if (u.cls === "loose") u.masked = true;
    // A shape with only spaces between it and a removed digit goes too.
    const absorbed: number[] = [];
    for (let k = 0; k < units.length; k++) {
      if (units[k].cls === "loose") continue;
      const left = k > 0 && units[k - 1].cls === "loose" && beside(k - 1);
      const right = k + 1 < units.length && units[k + 1].cls === "loose" && beside(k);
      if (left || right) absorbed.push(k);
    }
    for (const k of absorbed) units[k].masked = true;
  }

  for (let k = 0; k < units.length; k++) {
    const u = units[k];
    if (!u.masked) {
      if (u.cls !== "loose") spans.push({ s: c.ts[u.i], e: c.te[u.j], text: null, what: "shape" });
      continue;
    }
    // Removed units that follow one another become one placeholder, but
    // never across a link or another placeholder: that stays as it is.
    let last = k;
    while (last + 1 < units.length && units[last + 1].masked && !c.sep[units[last].j].includes(GAP)) last++;
    spans.push({ s: c.ts[u.i], e: c.te[units[last].j], text: NUMBER_REMOVED, what: "number" });
    k = last;
  }
}

const LEADS = "+(£€$₺";

function findClusters(copy: Copy, spans: Span[]): void {
  const { a, kind } = copy;
  const n = a.length;
  let rs = 0;
  while (rs < n) {
    if (kind[rs] === LET) {
      rs++;
      continue;
    }
    // A region with no letter in it. A BLOCK does not end it: digits on
    // both sides of a link or a placeholder are counted together.
    let re = rs;
    const ts: number[] = [];
    const te: number[] = [];
    const sep: string[] = [];
    let pre = "";
    let between: string[] = [];
    let digits = 0;
    while (re < n && kind[re] !== LET) {
      if (kind[re] === DIG) {
        const start = re;
        while (re < n && kind[re] === DIG) re++;
        if (ts.length === 0) pre = between.join("");
        else sep.push(between.join(""));
        between = [];
        ts.push(start);
        te.push(re);
        digits += re - start;
      } else if (kind[re] === BLOCK) {
        while (re < n && kind[re] === BLOCK) re++;
        between.push(GAP);
      } else {
        between.push(a[re]);
        re++;
      }
    }
    if (digits > 3) {
      const word = (from: number, step: 1 | -1) => {
        let p = from;
        let len = 0;
        while (p >= 0 && p < n && kind[p] === LET && len <= MAX_WORD) {
          p += step;
          len++;
        }
        if (len === 0 || len > MAX_WORD) return "";
        return step === 1 ? a.slice(from, p) : a.slice(p + 1, from + 1);
      };
      const cluster: Cluster = {
        tok: ts.map((s, k) => a.slice(s, te[k])),
        ts,
        te,
        sep,
        pre,
        post: between.join(""),
        leftWord: word(rs - 1, -1),
        rightWord: word(re, 1),
      };
      const before = spans.length;
      decideCluster(cluster, spans);
      // A "+", a "(" or a currency sign in front of a removed number goes with it.
      for (let k = before; k < spans.length; k++) {
        const sp = spans[k];
        if (sp.text === null) continue;
        let bracket = false;
        while (sp.s > rs && kind[sp.s - 1] === SEP && LEADS.includes(a[sp.s - 1])) {
          sp.s--;
          if (a[sp.s] === "(") bracket = true;
        }
        // And the bracket that closes the one just taken.
        if (bracket && sp.e < re && kind[sp.e] === SEP && a[sp.e] === ")") sp.e++;
      }
    }
    rs = re;
  }
}

/**
 * What is left of a card. When a number was removed from a line and the
 * same line says "exp", "cvv", "cvc" or "son kullanma" followed by a date
 * or a group of 3 or 4 digits, that goes too.
 */
const CARD_EXTRA =
  /(?<![a-z])(?:exp(?:iry|ires|iration)?|cvv2?|cvc2?|cv2|son kullanma(?: tarihi)?|skt)[ .:\-]{0,3}(\d{1,2}[/.\-]\d{2,4}|\d{3,4})(?!\d)/g;

function findCardExtras(copy: Copy, spans: Span[]): Span[] {
  const { a, kind } = copy;
  const lines = new Set<number>();
  for (const sp of spans) {
    if (sp.what !== "number") continue;
    const start = a.lastIndexOf("\n", sp.s) + 1;
    lines.add(start);
  }
  if (lines.size === 0) return spans;
  const extras: Span[] = [];
  for (const start of lines) {
    let end = a.indexOf("\n", start);
    if (end === -1) end = a.length;
    const line = a.slice(start, end);
    CARD_EXTRA.lastIndex = 0;
    for (let m = CARD_EXTRA.exec(line); m; m = CARD_EXTRA.exec(line)) {
      const e = start + m.index + m[0].length;
      const s = e - m[1].length;
      let free = true;
      for (let x = s; x < e; x++) if (kind[x] === BLOCK || kind[x] === LET) free = false;
      if (free) extras.push({ s, e, text: NUMBER_REMOVED, what: "number" });
    }
  }
  if (extras.length === 0) return spans;
  // An extra replaces a shape it covers, and is dropped where a removal
  // already covers it.
  const taken = new Uint8Array(a.length);
  for (const sp of spans) if (sp.text !== null) taken.fill(1, sp.s, sp.e);
  const added = extras.filter((x) => !taken.subarray(x.s, x.e).includes(1));
  const gone = new Uint8Array(a.length);
  for (const x of added) gone.fill(1, x.s, x.e);
  return [...spans.filter((sp) => sp.text !== null || !gone.subarray(sp.s, sp.e).includes(1)), ...added];
}

/**
 * A placeholder already in the text is a BLOCK before anything else looks:
 * its letters are not words, no link, email or IBAN reads into it, and it
 * is never altered. This is what makes masking the masked text change
 * nothing.
 */
function blockPlaceholders(copy: Copy): void {
  const { a, kind } = copy;
  let at = a.indexOf("[");
  while (at !== -1) {
    const hit = PLACEHOLDERS.find((p) => a.startsWith(p, at));
    if (hit) {
      for (let i = at; i < at + hit.length; i++) kind[i] = BLOCK;
      at = a.indexOf("[", at + hit.length);
    } else {
      at = a.indexOf("[", at + 1);
    }
  }
}

// ── The mask ────────────────────────────────────────────────────────────

export interface MaskedGroupDescription {
  /** The text with every removed span replaced by its placeholder. */
  text: string;
  /** How many numbers (IBANs included), links and email addresses went. */
  removed: number;
  links: number;
  emails: number;
  /**
   * For the tests: where, in `text`, the things deliberately kept are.
   * `shapes` are honoured times, prices, dates and years; `mapLinks` are
   * links on the map allow-list. Half-open [start, end) pairs.
   */
  kept: { shapes: Array<[number, number]>; mapLinks: Array<[number, number]> };
}

/**
 * Remove bank details, phone numbers, links and email addresses from
 * `text`. The rules are at the top of this file.
 */
export function maskGroupDescription(text: string): MaskedGroupDescription {
  const copy = normalisedCopy(text);
  let spans: Span[] = [];
  blockPlaceholders(copy);
  findLinks(copy, text, spans);
  findEmails(copy, spans);
  findIbans(copy, spans);
  findClusters(copy, spans);
  spans = findCardExtras(copy, spans);
  spans.sort((x, y) => x.s - y.s || x.e - y.e);

  // Where each span lies in the text. Two spans can share ONE original
  // character (a single character such as a "1/2" sign is several in the
  // copy): a removal always wins it, so nothing kept can hide a digit that
  // was to be removed, and no removal is ever dropped.
  const from = spans.map((sp) => copy.from[sp.s]);
  const to = spans.map((sp) => copy.to[sp.e - 1]);
  for (let k = 1; k < spans.length; k++) {
    if (from[k] >= to[k - 1]) continue;
    if (spans[k].text !== null && spans[k - 1].text === null) to[k - 1] = from[k];
    else from[k] = to[k - 1];
  }

  const out: string[] = [];
  const kept: MaskedGroupDescription["kept"] = { shapes: [], mapLinks: [] };
  let removed = 0;
  let links = 0;
  let emails = 0;
  let at = 0; // in `text`
  let length = 0; // of `out`
  for (let k = 0; k < spans.length; k++) {
    const sp = spans[k];
    const start = Math.max(from[k], at);
    const end = to[k];
    if (end <= start) continue; // nothing of it is left to write
    out.push(text.slice(at, start));
    length += start - at;
    const piece = sp.text ?? text.slice(start, end);
    if (sp.what === "shape") kept.shapes.push([length, length + piece.length]);
    else if (sp.what === "map") kept.mapLinks.push([length, length + piece.length]);
    else if (sp.what === "number") removed++;
    else if (sp.what === "link") links++;
    else emails++;
    out.push(piece);
    length += piece.length;
    at = end;
  }
  out.push(text.slice(at));
  return { text: out.join(""), removed, links, emails, kept };
}

// ── The door ────────────────────────────────────────────────────────────

export interface IngestedGroupDescription {
  /** The masked text, or null when there is nothing to keep. */
  text: string | null;
  /** For a log line: a length and counts, never any of the text. */
  note: string;
  /** How many numbers were replaced. */
  removed: number;
}

const NOTHING: IngestedGroupDescription = { text: null, note: "none", removed: 0 };
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Control characters other than a new line and a tab (NUL among them,
 *  which Postgres refuses in text). */
const CONTROL = /[^\P{Cc}\n\t]/gu;

/** How many UTF-16 units the letter ending at `end` takes, or 0 when the
 *  character there is not a letter. */
function letterBefore(s: string, end: number): number {
  const unit = s.charCodeAt(end - 1);
  if (unit >= 0xdc00 && unit <= 0xdfff && end >= 2) return RE_LETTER.test(s.slice(end - 2, end)) ? 2 : 0;
  return RE_LETTER.test(s[end - 1]) ? 1 : 0;
}

/**
 * Cut masked text to the limit so that masking it again changes nothing:
 * no half placeholder, no half character, and no half word or half
 * cluster at the end (a time cut off from its "pm", or a date cut in two,
 * would read as loose digits the second time).
 */
const CUT_LOOK_BACK = 256;

function cutToLimit(s: string): string {
  if (s.length <= GROUP_DESCRIPTION_MAX_CHARS) return s;
  let cut = s.slice(0, GROUP_DESCRIPTION_MAX_CHARS).replace(/[\uD800-\uDBFF]$/, "");
  const open = cut.lastIndexOf("[");
  if (open !== -1) {
    const rest = cut.slice(open);
    // The cut fell inside a placeholder: everything before it is whole.
    if (PLACEHOLDERS.some((p) => rest.length < p.length && p.startsWith(rest))) return cut.slice(0, open).trimEnd();
  }
  cut = cut.trimEnd();
  if (PLACEHOLDERS.some((p) => cut.endsWith(p))) return cut;
  // The last token may be half a token (half a link, half a word): drop
  // it, back to the last white space when there is one nearby.
  let end = cut.length;
  let space = end - 1;
  while (space >= 0 && end - space <= CUT_LOOK_BACK && cut[space] !== " " && cut[space] !== "\n") space--;
  if (space >= 0 && end - space <= CUT_LOOK_BACK) {
    end = space;
    while (end > 0 && (cut[end - 1] === " " || cut[end - 1] === "\n")) end--;
    if (PLACEHOLDERS.some((p) => cut.slice(0, end).endsWith(p))) return cut.slice(0, end);
  } else {
    // No white space near: drop the half word, unless it is no word at
    // all (hundreds of letters), which nothing reads as one.
    let word = end;
    while (word > 0 && end - word <= CUT_LOOK_BACK && letterBefore(cut, word) > 0) word -= letterBefore(cut, word);
    if (end - word <= CUT_LOOK_BACK) end = word;
  }
  // What is left may end in a cluster that lost what came after it (the
  // rest of a date, its "pm", its currency): drop it, back to a letter.
  while (end > 0 && cut[end - 1] !== "]" && letterBefore(cut, end) === 0) end--;
  return cut.slice(0, end).trimEnd();
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
  return {
    text,
    note:
      `${text.length} chars, ${masked.removed} number(s) removed` +
      (masked.links > 0 ? `, ${masked.links} link(s) removed` : "") +
      (masked.emails > 0 ? `, ${masked.emails} email(s) removed` : ""),
    removed: masked.removed,
  };
}
