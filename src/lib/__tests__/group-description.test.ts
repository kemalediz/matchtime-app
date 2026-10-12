/**
 * The WhatsApp group description is masked before it is stored
 * (2026-10-12). Organisers keep match and payment details there, so it
 * often holds bank details. The rules are in src/lib/group-description.ts:
 * default deny for digits, an allow-list of strictly checked shapes
 * (times, prices, dates, years), links and email addresses removed whole
 * except links to a map. Pure: no database, no model.
 *
 * The first two tables are the adversarial review of the first version of
 * this file (PR #233): every input in "bypasses" came out unchanged or
 * half masked then, and every input in "match information" was destroyed.
 */
import { describe, expect, it } from "vitest";
import {
  EMAIL_REMOVED,
  GROUP_DESCRIPTION_MAX_CHARS,
  LINK_REMOVED,
  NUMBER_REMOVED,
  ingestGroupDescription,
  isMapLink,
  maskGroupDescription,
} from "../group-description";

const X = NUMBER_REMOVED;
const LINK = LINK_REMOVED;
const EMAIL = EMAIL_REMOVED;
const mask = (s: string) => maskGroupDescription(s).text;

describe("bypasses found in review: each is removed whole", () => {
  const cases: Array<[input: string, expected: string]> = [
    // A label digit must not turn the start of a sort code into a time.
    ["No 1:12-34-56", `No ${X}`],
    ["Sort code 1:12 34 56", `Sort code ${X}`],
    ["Bank details\n1.12-34-56\n2.12345678", `Bank details\n${X}`],
    ["12.34-56", X],
    // Separators that used to end a run.
    ["Sort 12/34/56 Acc 1234/5678", `Sort ${X} Acc ${X}`],
    ["4111/1111/1111/1111", X],
    ["GB29/NWBK/6016/1331/9268/19", X],
    ["sort 12,34,56 acc 1234,5678", `sort ${X} acc ${X}`],
    ["12:34:56", X],
    ["1234_5678", X],
    ["NL91_ABNA_0417_1643_00", X],
    ["12\u00b734\u00b756", X],
    ["12\u202234\u202256", X],
    ["12*34*56", X],
    ["12|34|56", X],
    ["12~34~56", X],
    ["12'34'56", X],
    ["sort 12. 34. 56", `sort ${X}`],
    ["12 . 34 . 56", X],
    ["12..34..56", X],
    // New lines.
    ["Sort 12-34-56\nAcc 1234\n5678", `Sort ${X}\nAcc ${X}`],
    ["4111\n1111\n1111\n1111", X],
    ["GB29\nNWBK\n6016\n1331\n9268\n19", X],
    ["Kemal 07700\n900123", `Kemal ${X}`],
    ["07700/900123", X],
    ["IBAN TR33 0006 1005 1978 6457 8413\n26", `IBAN ${X}`],
    // Emoji, the line separator, HTML entities.
    ["12\u{1f600}34\u{1f600}56", X],
    ["12\u202834\u202856", X],
    ["&#49;&#50;&#51;&#52;&#53;&#54;", X],
    ["&#x31;&#x32;&#x33;&#x34;&#x35;&#x36;", X],
    ["12&nbsp;34&nbsp;56", X],
    ["12&ensp;34&ensp;56", X],
    // A number whose last group reads as a time or a price, and a price
    // sign in front of a number.
    ["0555 123 45.67", X],
    ["£1234 56 78", X],
    ["£1234 5678", X],
    ["12.34 56.78", X],
    ["1234 56.78", X],
    ["12 34 5.67", X],
    ["07.70 09.00 12.34", X],
  ];
  it.each(cases)("%j", (input, expected) => {
    const out = maskGroupDescription(input);
    expect(out.text).toBe(expected);
    expect(out.text).not.toMatch(/\d/);
  });

  it("a doubly encoded entity leaves no number behind either", () => {
    const out = mask("&#38;#49;&#38;#50;&#38;#51;&#38;#52;&#38;#53;&#38;#54;");
    expect(out).toContain(X);
    expect(out.replace("&#38;", "")).not.toMatch(/\d/);
  });
});

describe("match information that used to be destroyed: each survives", () => {
  const kept = [
    "Mon 12/10 2026 8pm",
    "Tue 13 10 2026",
    "12.10.2026",
    "12-10-2026",
    "2026-10-12",
    "Min 10 max 14 2026 season",
    "Capacity 14 2026/27",
    "Season 2025-2026",
    "100-150 TL",
    "125.000 TL",
    "https://maps.google.com/?q=51.361800,-0.194500",
    "https://maps.app.goo.gl/abc123456",
  ];
  it.each(kept)("%s", (s) => {
    const out = maskGroupDescription(s);
    expect(out.text).toBe(s);
    expect(out.removed + out.links + out.emails).toBe(0);
  });
});

describe("what survives (the first version's list, still green)", () => {
  const kept = [
    "8:30",
    "20:30",
    "£7",
    "7.50",
    "£7.50 each",
    "9 a side",
    "Monday 9pm",
    "12/10",
    "12/10/2026",
    "Mondays 20:30 to 21:30, 9 a side, £7",
    "Pazartesi 21.00-22.00 hali saha, 7,50 TL",
    "21:00-22:00",
    "19:00 - 20:00",
    "8-9pm",
    "8.30-9pm",
    "KO 8pm sharp, arrive 7:45",
    "5-a-side, 14 players max, 2 subs",
    "7v7",
    "£5 per game or £60 a month",
    "£5-£7",
    "£5 - £7 a game",
    "1.250,00 TL",
    "£1,250.00",
    "100 TL",
    "1000-1500 TL",
    "£5-7",
    "50p",
    "[number removed] 20:30 [link removed] [email removed]",
    "Pitch 3, Goals Sutton, SM1 4AF",
    "Pitch 3 20:30",
    "2026 season",
    "Est. 2019",
    "Max 14. 2026 season starts in March",
    "9.30pm",
    "20.30 - 21.30",
    "€1500 a season",
    "U16s",
    "v1.2.3",
    "Squad of 14, bibs for 7",
    "Sat 12/10/26",
    "12/10 20:30, £7",
    "Mon 12/10/2026 20:30-21:30 £7.50",
    "19:00, 20:00, 21:00",
    "Mondays 20:30, 14 players",
    "1) 20:30 2) 21:30 3) £5",
    "Next games: 14/10, 21/10, 28/10 all 20:30",
    "Subs £60/month (12 months = £720)",
    "Tuesdays 20:30 to 21:30, 5 a side, £7 each.",
    "Ali, Ben, Cem",
    "",
  ];
  it.each(kept)("%s", (s) => {
    expect(mask(s)).toBe(s);
    expect(maskGroupDescription(s).removed).toBe(0);
  });
});

describe("numbers: what is removed", () => {
  const cases: Array<[what: string, input: string, expected: string]> = [
    ["a UK account number", "Acc 12345678", `Acc ${X}`],
    ["a sort code with hyphens", "Sort 12-34-56", `Sort ${X}`],
    ["a sort code with spaces", "Sort 12 34 56", `Sort ${X}`],
    ["a sort code with spaced hyphens", "Sort 12 - 34 - 56", `Sort ${X}`],
    ["a sort code with dots", "Sort 12.34.56", `Sort ${X}`],
    ["a bare sort code", "Sort 123456", `Sort ${X}`],
    ["a sort code that could be a date", "Sort 20-10-25", `Sort ${X}`],
    ["a sort code and an account number, each on its own", "SC 12-34-56 AC 12345678", `SC ${X} AC ${X}`],
    ["an account number in two halves", "Acc 1234 5678", `Acc ${X}`],
    ["a card number with spaces", "4111 1111 1111 1111", X],
    ["a card number with hyphens", "4111-1111-1111-1111", X],
    ["a card number with dots", "4111.1111.1111.1111", X],
    ["a UK mobile", "Call 07700 900123", `Call ${X}`],
    ["an international mobile, the plus with it", "Call +44 7700 900123", `Call ${X}`],
    ["a number with an area code in brackets", "Call (020) 7946 0958", `Call ${X}`],
    ["a Turkish mobile with brackets", "Ara +90 (555) 123 45 67", `Ara ${X}`],
    ["a Turkish mobile with dots", "Ara 0555.123.45.67", `Ara ${X}`],
    ["a WhatsApp mention of a number", "ask @447700900123", `ask @${X}`],
    ["a number glued to a word", "ref12345678", `ref${X}`],
    ["a number glued to a word on both sides", "x123456y", `x${X}y`],
    ["a number with a tab in it", "Acc 1234\t5678", `Acc ${X}`],
    ["a number with a no-break space in it", "Acc 1234\u00a05678", `Acc ${X}`],
    ["a number with an en dash in it", "Sort 12\u201334\u201356", `Sort ${X}`],
    ["a number with a minus sign in it", "Sort 12\u221234\u221256", `Sort ${X}`],
    ["a number after a currency sign", "£1234567", X],
    ["a number, then a colon and two digits", "12345678:30", X],
    ["a number with one dot in it", "1234.5678", X],
    ["an account number written like a price range, in a lira account", "Hesap 1234-5678 TL", `Hesap ${X} TL`],
    ["a number written like a price in millions", "12.345.678 TL", `${X} TL`],
    ["the same after a currency sign", "£1.250.000", X],
    ["a price range that runs backwards", "150-100 TL", `${X} TL`],
    ["an IBAN one character short: its digits go, and no word after it is eaten", "GB29 NWBK 6016 1331 9268 1 thanks all", `GB29 NWBK ${X} thanks all`],
    ["a UK IBAN in groups", "IBAN GB29 NWBK 6016 1331 9268 19", `IBAN ${X}`],
    ["a UK IBAN in one piece", "IBAN GB29NWBK60161331926819", `IBAN ${X}`],
    ["a Turkish IBAN in groups", "IBAN: TR33 0006 1005 1978 6457 8413 26", `IBAN: ${X}`],
    ["a Turkish IBAN in one piece", "TR330006100519786457841326", X],
    ["a lower-case IBAN", "iban gb29 nwbk 6016 1331 9268 19", `iban ${X}`],
    ["an IBAN with hyphens", "GB29-NWBK-6016-1331-9268-19", X],
    ["an IBAN whose account part has letters", "MT84 MALT 0110 0001 2345 MTLC AST0 01S", X],
    ["an IBAN, and the words after it kept", "TR33 0006 1005 1978 6457 8413 26 adina Ali", `${X} adina Ali`],
    ["an IBAN in full-width characters", "\uff27\uff22\uff12\uff19 NWBK 6016 1331 9268 19", X],
  ];
  it.each(cases)("%s", (_what, input, expected) => {
    expect(mask(input)).toBe(expected);
  });

  it("a placeholder is inert: nothing reads across it or takes its letters for words", () => {
    // "TR", then digits, then the letters of a placeholder, would add up to an IBAN.
    const s = "TR33 0006 1005 1978 64 [link removed] 20:30";
    expect(mask(s)).toBe(`TR${X} [link removed] 20:30`);
    expect(mask(mask(s))).toBe(mask(s));
  });

  it("words that start like a country code are not an IBAN", () => {
    for (const s of ["at 20:30 on Mondays weekly, 9 a side", "is 14 players per team on Tuesdays", "de 21.00 hali saha"]) {
      expect(mask(s)).toBe(s);
    }
  });
});

describe("a time, a price or a date beside a number", () => {
  const cases: Array<[input: string, expected: string]> = [
    // Set apart by a spaced dash, a comma, a full stop or a new line: kept.
    ["£5 - 07700 900123", `£5 - ${X}`],
    ["KO 20:30 - 07700 900123 - £7.50", `KO 20:30 - ${X} - £7.50`],
    ["07700 900123, 20:30", `${X}, 20:30`],
    ["20:30\n07700 900123", `20:30\n${X}`],
    ["21.00, 07700 900123", `21.00, ${X}`],
    ["Gate 1234, 20:30", `Gate ${X}, 20:30`],
    // Only spaces between them: it goes with the number.
    ["£5 07700 900123", X],
    ["20:30 07700 900123", X],
    ["07700 900123 20:30", X],
    ["1:23 4567 8901", X],
    ["2026 1234", X],
    // Nothing to remove: everything stays.
    ["Mon 20:30 2026", "Mon 20:30 2026"],
    ["Pitch 3 20:30", "Pitch 3 20:30"],
    // ONE group of one or two loose digits beside a time, a date or a
    // price is a count ("20:30 14 players"): see the round-two tests.
    ["12/10 20:30 14", "12/10 20:30 14"],
    // More than that, with only a space between, and the shape may be the
    // start of a number.
    ["Sort 12:34 567", `Sort ${X}`],
    ["Sort 12/10 56 78", `Sort ${X}`],
    ["£12.34 56 78", X],
    ["Mon 12 10 56", `Mon ${X}`],
  ];
  it.each(cases)("%j", (input, expected) => {
    expect(mask(input)).toBe(expected);
  });

  it("a clock or a price never shields a number that is one", () => {
    expect(mask("sort:12-34-56 acc:12345678")).toBe(`sort:${X} acc:${X}`);
    expect(mask("Tel:07700900123")).toBe(`Tel:${X}`);
    expect(mask("12345678.50")).toBe(X);
    expect(mask("0488.86842")).toBe(X);
    // An invisible character does not make a price or a time out of a number.
    expect(mask("£8000\u200b828")).toBe(X);
    expect(mask("1234\u200b5.67")).toBe(X);
    expect(mask("12.34\u200b.56")).toBe(X);
  });
});

describe("where privacy and usefulness conflict, privacy wins", () => {
  const cases: Array<[why: string, input: string, expected: string]> = [
    ["a date with a two-digit year and no day word is what a sort code looks like", "Next game 12/10/26", `Next game ${X}`],
    ["three dotted times in a row", "07.30 09.00 12.30", X],
    ["two years side by side", "2025 2026", X],
    ["two counts right after a time", "Mondays 20:30 14 12", `Mondays ${X}`],
    ["a time range written as four digits each", "Mondays 2000-2100", `Mondays ${X}`],
    ["a list of small numbers adds up", "Teams of 5, 6, 7, 8, 9, 10", `Teams of ${X}`],
    ["a list of small numbers down the page", "7\n9\n11\n14\n21\n30", X],
    ["a count that shares a cluster with a number goes with it", "Pitch 3\n07700 900123", `Pitch ${X}`],
    ["a price in front of a number, only a space between", "£5 07700 900123", X],
    ["a four-digit code beside a time", "Code 4321 20:30", `Code ${X}`],
    ["coordinates outside a map link", "51.361800, -0.194500", X],
  ];
  it.each(cases)("%s", (_why, input, expected) => {
    expect(mask(input)).toBe(expected);
  });

  it("what is knowingly left: digits split by letters, and short pieces set apart", () => {
    for (const s of ["12a34b56", "12.34, 56", "Sort 12345"]) expect(mask(s)).toBe(s);
  });
});

describe("links and email addresses", () => {
  const cases: Array<[input: string, expected: string]> = [
    ["Pay monzo.me/kemaled", `Pay ${LINK}`],
    ["https://paypal.me/kemal/7", LINK],
    ["revolut.me/kemal12345", LINK],
    ["wa.me/447700900123", LINK],
    ["https://wa.me/447700900123?text=hi", LINK],
    ["Join: https://chat.whatsapp.com/AbC123456789.", `Join: ${LINK}.`],
    ["www.example.com", LINK],
    ["(see https://example.com/a?b=12345678)", `(see ${LINK})`],
    ["bank://transfer?acc=12345678", LINK],
    ["HTTPS://PAYPAL.ME/KEMAL", LINK],
    ["pay:monzo.me/kemaled", `pay:${LINK}`],
    ["mail kemal.ediz+pay@example.co.uk now", `mail ${EMAIL} now`],
    ["a@b.io, c@d.io", `${EMAIL}, ${EMAIL}`],
    // Not on the map allow-list, however they are dressed.
    ["https://maps.google.com@evil.example/12345678", LINK],
    ["https://maps.google.com.evil.example/x", LINK],
    ["https://google.com/search?q=12345678", LINK],
    ["https://google.com/mapsx/12345678", LINK],
    ["goo.gl/abc123456", LINK],
    ["https://evil.example/maps.google.com/12345678", LINK],
    ["ftp://maps.google.com/12345678", LINK],
    ["https://maps.google.com:8080/12345678", LINK],
    // A link broken by spaces is not a link; its digits are judged as any others.
    ["monzo . me / 12345678", `monzo . me / ${X}`],
  ];
  it.each(cases)("%j", (input, expected) => {
    expect(mask(input)).toBe(expected);
  });

  const maps = [
    "https://maps.google.com/?q=51.361800,-0.194500",
    "https://www.google.com/maps/place/Goals+Sutton/@51.3618,-0.1945,17z",
    "https://google.co.uk/maps?q=51.361800,-0.194500",
    "maps.google.co.uk/?q=51.361800,-0.194500",
    "https://maps.google.com.tr/?q=41.008200,28.978400",
    "https://maps.app.goo.gl/abc123456",
    "https://goo.gl/maps/abc123456",
    "https://maps.apple.com/?ll=51.361800,-0.194500",
    "https://what3words.com/filled.count.soap",
    "https://w3w.co/filled.count.soap",
    "https://waze.com/ul?ll=51.36180000,-0.19450000",
    "https://ul.waze.com/ul?ll=51.36180000,-0.19450000",
    "https://www.openstreetmap.org/#map=17/51.36180/-0.19450",
  ];
  it.each(maps)("a map link is kept whole: %s", (url) => {
    expect(isMapLink(url)).toBe(true);
    const text = `Pitch: ${url}. Sort 12-34-56`;
    const out = maskGroupDescription(text);
    expect(out.text).toBe(`Pitch: ${url}. Sort ${X}`);
    expect(out.links).toBe(0);
    expect(out.kept.mapLinks.map(([s, e]) => out.text.slice(s, e))).toEqual([url]);
  });

  it("a host with no path is not a link, and stays", () => {
    expect(mask("see matchtime.ai for more")).toBe("see matchtime.ai for more");
  });

  it("counts what it removed, by kind", () => {
    const out = maskGroupDescription("12-34-56, GB29NWBK60161331926819, monzo.me/x, a@b.io, 12345678");
    expect(out).toMatchObject({ removed: 3, links: 1, emails: 1 });
  });
});

describe("adversarial characters", () => {
  const zw = "\u200b";
  const cases: Array<[what: string, input: string]> = [
    ["zero-width spaces between digits", `1${zw}2${zw}3${zw}4${zw}5${zw}6${zw}7${zw}8`],
    ["many zero-width characters between digits", `1234${zw}${zw}${zw}${zw}${zw}5678`],
    ["zero-width joiners and non-joiners", "12\u200c34\u200d56\u206078"],
    ["a byte-order mark and a soft hyphen", "1234\ufeff56\u00ad78"],
    ["left-to-right and right-to-left marks", "12\u200e34\u200f56\u202a78\u202c"],
    ["full-width digits", "\uff11\uff12\uff13\uff14\uff15\uff16\uff17\uff18"],
    ["Arabic-Indic digits", "\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668"],
    ["Persian digits", "\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6"],
    ["Devanagari digits", "\u0967\u0968\u0969\u096a\u096b\u096c"],
    ["mathematical bold digits", "\u{1d7cf}\u{1d7d0}\u{1d7d1}\u{1d7d2}\u{1d7d3}\u{1d7d4}"],
    ["superscript digits", "\u00b9\u00b2\u00b3\u2074\u2075\u2076"],
    ["circled digits", "\u2460\u2461\u2462\u2463\u2464\u2465"],
    ["dingbat digits", "\u2776\u2777\u2778\u2779\u277a\u277b"],
    ["keycap emoji digits", "1\ufe0f\u20e32\ufe0f\u20e33\ufe0f\u20e34\ufe0f\u20e35\ufe0f\u20e36\ufe0f\u20e3"],
    ["mixed scripts in one number", "12\u0663\u0664\uff15\uff16"],
    ["an invisible Hangul filler between digits", "1234\u31645678"],
    ["a braille blank between digits", "1234\u28005678"],
    ["thin and hair spaces", "12\u200934\u200a56"],
    ["a combining mark between digits", "123\u0301456"],
    ["full-width colons", "12\uff1a34\uff1a56"],
  ];
  it.each(cases)("%s", (_what, input) => {
    const out = maskGroupDescription(`pay ${input} now`);
    expect(out.text.startsWith(`pay ${X}`)).toBe(true);
    expect(out.text.endsWith(" now")).toBe(true);
    expect(out.removed).toBe(1);
    expect(out.text).not.toMatch(/[\p{Nd}\p{No}]/u);
  });

  it("digits of another script are read as what they are: an Arabic-Indic time survives", () => {
    const time = "\u0662\u0660:\u0663\u0660"; // 20:30
    expect(mask(`KO ${time}`)).toBe(`KO ${time}`);
    expect(mask(`KO ${time} \u0660\u0667\u0667\u0660\u0660 \u0669\u0660\u0660\u0661\u0662\u0663`)).toBe(`KO ${X}`);
  });

  it("the organiser's own text is untouched outside what is removed", () => {
    const s = "\u00c7ar\u015famba 21.00\u2019de, \uff19 a side \u{1f600} Sort 12-34-56";
    expect(mask(s)).toBe(`\u00c7ar\u015famba 21.00\u2019de, \uff19 a side \u{1f600} Sort ${X}`);
  });

  it("never throws, whatever the characters", () => {
    for (const s of ["\ud800", "\udc00\ud800 12", "&#0;&#1114112;&#xD800;&#55296;", "&#;&;&#x;", "\u0000\u0001", "@", "://", "/"]) {
      expect(() => maskGroupDescription(s)).not.toThrow();
    }
  });
});

// ── Linear time ─────────────────────────────────────────────────────────

const fill = (unit: string) => unit.repeat(Math.ceil(GROUP_DESCRIPTION_MAX_CHARS / unit.length)).slice(0, GROUP_DESCRIPTION_MAX_CHARS);

const TIMED_INPUTS: Array<[name: string, input: string]> = [
  ["4,096 x U+200B", fill("\u200b")],
  ["4,096 x U+0344", fill("\u0344")],
  ["4,096 digits", fill("1")],
  ['"1 " pairs', fill("1 ")],
  ['"1:" pairs', fill("1:")],
  ['"1." pairs', fill("1.")],
  ['"1/" pairs', fill("1/")],
  ['"12:34 " times', fill("12:34 ")],
  ['"12.34 " weak times', fill("12.34 ")],
  ['"12/10/2026 " dates', fill("12/10/2026 ")],
  ['"£1 " prices', fill("£1 ")],
  ['"2026 " years', fill("2026 ")],
  ["digits and zero-width", fill("1\u200b")],
  ["digits and emoji", fill("1\u{1f600}")],
  ["digits and new lines", fill("1234\n")],
  ["entities", fill("&#49;")],
  ["half entities", fill("&#")],
  ["ampersands", fill("&")],
  ['"GB29 " IBAN starts', fill("GB29 ")],
  ['"TR" pairs', fill("TR ")],
  ["one long word", fill("a")],
  ['"a@" pairs', fill("a@")],
  ["at signs", fill("@")],
  ['"http://" starts', fill("http://")],
  ["slashes", fill("/")],
  ['"a.b/" hosts', fill("a.bc/")],
  ["dots", fill(".")],
  ["one long link", `https://example.com/${fill("a1/")}`.slice(0, GROUP_DESCRIPTION_MAX_CHARS)],
  ["the review's bypasses, repeated", fill("No 1:12-34-56 sort 12,34,56 acc 1234\n5678 GB29/NWBK/6016 12.34 56.78 £1234 5678 ")],
];

describe("linear time", () => {
  it.each(TIMED_INPUTS)("%s: 4,096 characters in under 20 ms", (_name, input) => {
    expect(input.length).toBe(GROUP_DESCRIPTION_MAX_CHARS);
    maskGroupDescription(input); // once to warm up
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      maskGroupDescription(input);
      best = Math.min(best, performance.now() - started);
    }
    expect(best).toBeLessThan(20);
  });

  it("ten times the text takes about ten times as long, not a hundred", () => {
    const time = (s: string) => {
      maskGroupDescription(s);
      const started = performance.now();
      for (let run = 0; run < 5; run++) maskGroupDescription(s);
      return (performance.now() - started) / 5;
    };
    for (const unit of ["\u200b", "1 ", "1:", "12.34 ", "&#49;", "a@", "a.bc/"]) {
      const small = time(unit.repeat(4000 / unit.length));
      const big = time(unit.repeat(40000 / unit.length));
      expect(big, unit).toBeLessThan(Math.max(40, small * 40));
    }
  });
});

// ── Properties, on generated text ───────────────────────────────────────

function generator(seed: number) {
  let state = seed >>> 0;
  const next = (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 0x100000000) * n);
  };
  return { next, pick: <T>(xs: readonly T[]): T => xs[next(xs.length)] };
}

const SEPARATORS = [" ", " ", "\n", "-", "/", ".", ",", ":", "_", "*", "|", "~", "'", "\u00b7", "\u2022", " - ", ", ", ". ", "\u200b", "(", ")", "+", "\u{1f600}"];
const WORDS = ["a", "pm", " TL", "Mon ", "x", " Sort ", "Tue ", " am", "IBAN GB", "TR", " to "];
/** Pieces of links, email addresses and the placeholders themselves. */
const LINK_PIECES = ["www.", "x.co/", "maps.app.goo.gl/", "https://", "@", "a@b.co", "monzo.me/k", "[", "]", NUMBER_REMOVED, LINK_REMOVED, EMAIL_REMOVED, "&#49;", "&nbsp;"];
/** Single characters that are several characters once normalised. */
const EXPANDING = ["\u00bd", "\u2152", "\u33a8", "\u2488", "\u3251", "\u2474", "\u00b2", "\ufdfa", "\u33c2", "\u2460"];
const SIGNS = ["£", "€", "₺", "$"];

function generated(g: ReturnType<typeof generator>, pieces: number, extra: readonly string[] = []): string {
  let s = "";
  for (let i = 0; i < pieces; i++) {
    if (extra.length > 0 && g.next(5) === 0) {
      s += g.pick(extra);
      continue;
    }
    const roll = g.next(10);
    if (roll < 5) {
      const len = 1 + g.next(4);
      for (let d = 0; d < len; d++) s += String(g.next(10));
    } else if (roll < 8) s += g.pick(SEPARATORS);
    else if (roll < 9) s += g.pick(WORDS);
    else s += g.pick(SIGNS);
  }
  return s;
}

/**
 * The digits of each letter-free stretch of `text`, counted the way a
 * reader would: entities decoded, every character normalised. A
 * placeholder does not end a stretch (it is not a word).
 */
function digitsPerStretch(text: string): number[] {
  const read = text
    .replaceAll(NUMBER_REMOVED, "|")
    .replaceAll(LINK_REMOVED, "|")
    .replaceAll(EMAIL_REMOVED, "|")
    .replace(/&#49;/g, "1")
    .normalize("NFKC");
  return read.split(/\p{L}+/u).map((stretch) => (stretch.match(/[\p{Nd}\p{No}]/gu) ?? []).length);
}

/** `out.text` with every honoured shape and map link blanked out, digit by
 *  digit, so that only loose digits are left to count. */
function looseOnly(out: ReturnType<typeof maskGroupDescription>): string {
  const chars = out.text.split("");
  for (const [s, e] of [...out.kept.shapes, ...out.kept.mapLinks]) {
    for (let i = s; i < e; i++) chars[i] = "#";
  }
  return chars.join("");
}

describe("properties", () => {
  it("5,000 generated strings: never throws, is idempotent, and leaves fewer than 6 loose digits in any letter-free stretch", () => {
    const g = generator(20261012);
    for (let n = 0; n < 5000; n++) {
      const input = generated(g, 3 + g.next(30));
      const out = maskGroupDescription(input);
      const again = maskGroupDescription(out.text);
      expect(again.text, JSON.stringify(input)).toBe(out.text);
      expect(again.removed + again.links + again.emails, JSON.stringify(input)).toBe(0);
      expect(Math.max(...digitsPerStretch(looseOnly(out))), `${JSON.stringify(input)} -> ${JSON.stringify(out.text)}`).toBeLessThan(6);
    }
  });

  it("300,000 strings with link pieces, placeholders and characters that expand: ONE pass leaves fewer than 6 loose digits in any letter-free stretch, and a second pass changes nothing", { timeout: 120_000 }, () => {
    const g = generator(5);
    let notIdempotent = 0;
    let leaked = 0;
    const examples: string[] = [];
    for (let n = 0; n < 300_000; n++) {
      const input = generated(g, 1 + g.next(12), n % 2 === 0 ? [...LINK_PIECES, ...EXPANDING] : EXPANDING);
      const out = maskGroupDescription(input);
      if (Math.max(...digitsPerStretch(looseOnly(out))) >= 6) {
        leaked++;
        if (leaked <= 12) examples.push(`LEAK ${JSON.stringify(input)} -> ${JSON.stringify(out.text)}`);
      }
      if (maskGroupDescription(out.text).text !== out.text) {
        notIdempotent++;
        if (examples.length < 10) examples.push(`TWICE ${JSON.stringify(input)} -> ${JSON.stringify(out.text)} -> ${JSON.stringify(maskGroupDescription(out.text).text)}`);
      }
    }
    expect({ leaked, notIdempotent, examples }).toEqual({ leaked: 0, notIdempotent: 0, examples: [] });
  });

  it("3,000 strings that cannot hold a time, a price, a date or a year: fewer than 6 digits in any letter-free stretch, whatever is kept", () => {
    // Groups of 3, 5, 6 or 7 digits (an hour, a day and a month are 1 or 2,
    // a year is 4), no currency sign, no day or currency word.
    const g = generator(233);
    const words = ["x", " Sort ", "acc", " q "];
    for (let n = 0; n < 3000; n++) {
      let input = "";
      const pieces = 2 + g.next(12);
      for (let i = 0; i < pieces; i++) {
        const len = g.pick([3, 3, 5, 6, 7]);
        for (let d = 0; d < len; d++) input += String(g.next(10));
        input += g.next(6) === 0 ? g.pick(words) : g.pick(SEPARATORS);
      }
      const out = maskGroupDescription(input);
      expect(out.kept.shapes, JSON.stringify(input)).toEqual([]);
      expect(Math.max(...digitsPerStretch(out.text)), `${JSON.stringify(input)} -> ${JSON.stringify(out.text)}`).toBeLessThan(6);
      expect(maskGroupDescription(out.text).text).toBe(out.text);
    }
  });

  it("300 long generated descriptions: ingesting what was kept keeps it as it is, cut or not", () => {
    const g = generator(4096);
    for (let n = 0; n < 300; n++) {
      const raw = generated(g, 600 + g.next(900)).slice(0, GROUP_DESCRIPTION_MAX_CHARS);
      const first = ingestGroupDescription(raw);
      if (first.text === null) continue;
      expect(first.text.length).toBeLessThanOrEqual(GROUP_DESCRIPTION_MAX_CHARS);
      const second = ingestGroupDescription(first.text);
      expect(second.text, JSON.stringify(raw.slice(0, 80))).toBe(first.text);
      expect(second.removed).toBe(0);
    }
  });
});

// ── The door ────────────────────────────────────────────────────────────

describe("ingestGroupDescription: what the server keeps of what the Pi sent", () => {
  it("nothing sent, or not a string, or blank: nothing kept", () => {
    for (const raw of [undefined, null, 42, {}, ["x"], "", "   \n\t "]) {
      expect(ingestGroupDescription(raw)).toEqual({ text: null, note: "none", removed: 0 });
    }
  });

  it("masks, trims, and says only how long it is and how much went", () => {
    const r = ingestGroupDescription("  Mondays 20:30, £7.\nSort 12-34-56 Acc 12345678  ");
    expect(r.text).toBe(`Mondays 20:30, £7.\nSort ${X} Acc ${X}`);
    expect(r.removed).toBe(2);
    expect(r.note).toBe(`${r.text!.length} chars, 2 number(s) removed`);
    const l = ingestGroupDescription("Pay monzo.me/kemal or mail a@b.io, acc 12345678");
    expect(l.text).toBe(`Pay ${LINK} or mail ${EMAIL}, acc ${X}`);
    expect(l.note).toBe(`${l.text!.length} chars, 1 number(s) removed, 1 link(s) removed, 1 email(s) removed`);
  });

  it("a description that is nothing but a number keeps the placeholder", () => {
    expect(ingestGroupDescription("12345678").text).toBe(X);
  });

  it("far longer than WhatsApp allows: nothing kept, and nothing of it in the note", () => {
    const raw = "Acc 12345678 " + "x".repeat(GROUP_DESCRIPTION_MAX_CHARS);
    expect(ingestGroupDescription(raw)).toEqual({ text: null, note: "oversize", removed: 0 });
  });

  it("at the limit it is kept; masking that makes it longer is cut back to the limit, on a whole placeholder", () => {
    const atLimit = "a".repeat(GROUP_DESCRIPTION_MAX_CHARS);
    expect(ingestGroupDescription(atLimit).text).toBe(atLimit);

    // Each "123456" (6 characters) becomes the placeholder (16).
    const many = "123456a".repeat(Math.floor(GROUP_DESCRIPTION_MAX_CHARS / 7));
    const r = ingestGroupDescription(many);
    expect(r.text!.length).toBeLessThanOrEqual(GROUP_DESCRIPTION_MAX_CHARS);
    expect(r.text!.length).toBeGreaterThan(GROUP_DESCRIPTION_MAX_CHARS - 40);
    expect(r.text).not.toMatch(/\d/);
    expect(r.text!.replaceAll(X, "")).toMatch(/^a+$/);
  });

  it("a cut never leaves half a time, half a date or half a link to be read as loose digits", () => {
    for (const tail of ["12/10/2026 20:30", "Mon 8pm 150 TL", "https://maps.google.com/?q=51.361800,-0.194500", "monzo.me/kemal a@b.io"]) {
      // Long enough that the cut lands somewhere inside the repeated tail.
      const raw = ("123456a".repeat(200) + ` ${tail} `.repeat(120)).slice(0, GROUP_DESCRIPTION_MAX_CHARS);
      const first = ingestGroupDescription(raw).text!;
      expect(first.length).toBeLessThanOrEqual(GROUP_DESCRIPTION_MAX_CHARS);
      expect(ingestGroupDescription(first).text).toBe(first);
    }
  });

  it("drops what Postgres would refuse, and other control characters, but keeps new lines", () => {
    expect(ingestGroupDescription("Mon\u0000day\r\n9pm\u0007 \u{1f600}").text).toBe("Monday\n9pm \u{1f600}");
    // A lone surrogate is not text.
    expect(ingestGroupDescription("9pm \ud83d").text).toBe("9pm \ufffd");
  });

  it("is idempotent: what it kept, ingested again, is kept as it is", () => {
    const first = ingestGroupDescription("Mondays 20:30. Sort 12-34-56, IBAN TR33 0006 1005 1978 6457 8413 26, monzo.me/x").text;
    expect(ingestGroupDescription(first)).toMatchObject({ text: first, removed: 0 });
    const cut = ingestGroupDescription("123456a".repeat(Math.floor(GROUP_DESCRIPTION_MAX_CHARS / 7))).text;
    expect(ingestGroupDescription(cut).text).toBe(cut);
  });

  it("never throws, whatever it is handed", () => {
    for (const raw of [Symbol("x"), () => 1, new Date(), "\ud800", "\udc00\ud800"]) {
      expect(() => ingestGroupDescription(raw)).not.toThrow();
    }
  });
});
