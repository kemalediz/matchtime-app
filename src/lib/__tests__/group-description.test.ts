/**
 * The WhatsApp group description is masked before it is stored
 * (2026-10-12). Organisers keep match and payment details there, so it
 * often holds bank details. The rules, and what must survive them, are in
 * src/lib/group-description.ts. Pure: no database, no model.
 */
import { describe, expect, it } from "vitest";
import {
  GROUP_DESCRIPTION_MAX_CHARS,
  NUMBER_REMOVED,
  ingestGroupDescription,
  maskGroupDescription,
} from "../group-description";

const X = NUMBER_REMOVED;
const mask = (s: string) => maskGroupDescription(s).text;

describe("what is removed", () => {
  const cases: Array<[what: string, input: string, expected: string]> = [
    ["a UK account number", "Acc 12345678", `Acc ${X}`],
    ["a sort code with hyphens", "Sort 12-34-56", `Sort ${X}`],
    ["a sort code with spaces", "Sort 12 34 56", `Sort ${X}`],
    ["a sort code with spaced hyphens", "Sort 12 - 34 - 56", `Sort ${X}`],
    ["a sort code with dots", "Sort 12.34.56", `Sort ${X}`],
    ["a bare sort code", "Sort 123456", `Sort ${X}`],
    ["a sort code and an account number, each on its own", "SC 12-34-56 AC 12345678", `SC ${X} AC ${X}`],
    ["an account number in two halves", "Acc 1234 5678", `Acc ${X}`],
    ["a card number with spaces", "4111 1111 1111 1111", X],
    ["a card number with hyphens", "4111-1111-1111-1111", X],
    ["a card number with dots", "4111.1111.1111.1111", X],
    ["a UK mobile", "Call 07700 900123", `Call ${X}`],
    ["an international mobile", "Call +44 7700 900123", `Call ${X}`],
    ["a number with an area code in brackets", "Call (020) 7946 0958", `Call ${X}`],
    ["a Turkish mobile with brackets", "Ara +90 (555) 123 45 67", `Ara ${X}`],
    ["a Turkish mobile with dots", "Ara 0555.123.45.67", `Ara ${X}`],
    ["a number glued to a word", "ref12345678", `ref${X}`],
    ["a number glued to a word on both sides", "x123456y", `x${X}y`],
    ["a number with a tab in it", "Acc 1234\t5678", `Acc ${X}`],
    ["a number with a no-break space in it", "Acc 1234\u00a05678", `Acc ${X}`],
    ["a number with an en dash in it", "Sort 12\u201334\u201356", `Sort ${X}`],
    ["a number with a non-breaking hyphen in it", "Sort 12\u201134\u201156", `Sort ${X}`],
    ["a number with a minus sign in it", "Sort 12\u221234\u221256", `Sort ${X}`],
    ["a UK IBAN in groups", "IBAN GB29 NWBK 6016 1331 9268 19", `IBAN ${X}`],
    ["a UK IBAN in one piece", "IBAN GB29NWBK60161331926819", `IBAN ${X}`],
    ["a Turkish IBAN in groups", "IBAN: TR33 0006 1005 1978 6457 8413 26", `IBAN: ${X}`],
    ["a Turkish IBAN in one piece", "TR330006100519786457841326", X],
    ["a lower-case IBAN", "iban gb29 nwbk 6016 1331 9268 19", `iban ${X}`],
    ["an IBAN with hyphens", "GB29-NWBK-6016-1331-9268-19", X],
    ["an IBAN whose account part has letters", "MT84 MALT 0110 0001 2345 MTLC AST0 01S", X],
    ["an IBAN, and the words after it kept", "TR33 0006 1005 1978 6457 8413 26 adina Ali", `${X} adina Ali`],
  ];
  it.each(cases)("%s", (_what, input, expected) => {
    expect(mask(input)).toBe(expected);
  });
});

describe("what survives", () => {
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
    "KO 8pm sharp, arrive 7:45",
    "5-a-side, 14 players max, 2 subs",
    "7v7",
    "£5 per game or £60 a month",
    "1.250,00 TL",
    "100 TL",
    "50p",
    "Pitch 3, Goals Sutton, SM1 4AF",
    "2026 season",
    "Est. 2019",
    "Max 14. 2026 season starts in March",
    "9.30pm",
    "20.30 - 21.30",
    "€1500 a season",
    "U16s",
    "v1.2.3",
    "Squad of 14, bibs for 7",
    "Ali, Ben, Cem",
    "",
  ];
  it.each(kept)("%s", (s) => {
    expect(mask(s)).toBe(s);
    expect(maskGroupDescription(s).removed).toBe(0);
  });
});

describe("times and prices beside a number survive it", () => {
  const cases: Array<[input: string, expected: string]> = [
    ["£5 - 07700 900123", `£5 - ${X}`],
    ["£5 07700 900123", `£5 ${X}`],
    ["€10 0555 123 45 67", `€10 ${X}`],
    ["₺150 0555 123 45 67", `₺150 ${X}`],
    ["20:30 07700 900123", `20:30 ${X}`],
    ["07700 900123 20:30", `${X} 20:30`],
    ["07700 900123 7.50", `${X} 7.50`],
    ["Mon 20:30 2026", "Mon 20:30 2026"],
    ["KO 20:30 - 07700 900123 - £7.50", `KO 20:30 - ${X} - £7.50`],
  ];
  it.each(cases)("%s", (input, expected) => {
    expect(mask(input)).toBe(expected);
  });

  it("but a clock or a price never shields a number that is one", () => {
    // Six or more digits straight after the currency sign or the colon.
    expect(mask("sort:12-34-56 acc:12345678")).toBe(`sort:${X} acc:${X}`);
    expect(mask("Tel:07700900123")).toBe(`Tel:${X}`);
    expect(mask("12345678:30")).toBe(`${X}:30`);
    expect(mask("12345678.50")).toBe(X);
    expect(mask("£1234567")).toBe(`£${X}`);
    expect(mask("1234.5678")).toBe(X);
    expect(mask("0488.86842")).toBe(X);
    // An invisible character does not make a price or a time out of a number.
    expect(mask("£8000\u200b828")).toBe(`£${X}`);
    expect(mask("1234\u200b5.67")).toBe(X);
    expect(mask("12.34\u200b.56")).toBe(X);
    expect(mask("1:23 4567 8901")).toBe(`1:23 ${X}`);
  });
});

describe("adversarial input", () => {
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
  ];
  it.each(cases)("%s", (_what, input) => {
    const out = maskGroupDescription(`pay ${input} now`);
    expect(out.text).toBe(`pay ${X} now`);
    expect(out.removed).toBe(1);
    expect(out.text).not.toMatch(/[\p{Nd}\p{No}]/u);
  });

  it("an IBAN in full-width letters and digits", () => {
    expect(mask("\uff27\uff22\uff12\uff19 NWBK 6016 1331 9268 19")).toBe(X);
  });

  it("a number split over lines is two numbers, each long enough or left alone", () => {
    expect(mask("Sort\n12-34-56\nAcc\n12345678")).toBe(`Sort\n${X}\nAcc\n${X}`);
    // A list of small numbers down the page is not one number.
    expect(mask("7\n9\n11\n14\n21\n30")).toBe("7\n9\n11\n14\n21\n30");
  });

  it("is idempotent", () => {
    const once = mask("Mondays 20:30, £7. Sort 12-34-56 Acc 12345678. IBAN GB29 NWBK 6016 1331 9268 19");
    expect(mask(once)).toBe(once);
    expect(maskGroupDescription(once).removed).toBe(0);
  });

  it("does not hang on long hostile input", () => {
    const started = Date.now();
    mask("1 ".repeat(2000) + "a".repeat(2000) + "ab12 ".repeat(800));
    mask("AB12" + " abcd".repeat(1000));
    mask("1.".repeat(2000));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("counts what it removed", () => {
    expect(maskGroupDescription("12-34-56 and 12345678 and GB29NWBK60161331926819").removed).toBe(3);
  });
});

describe("ingestGroupDescription: what the server keeps of what the Pi sent", () => {
  it("nothing sent, or not a string, or blank: nothing kept", () => {
    for (const raw of [undefined, null, 42, {}, ["x"], "", "   \n\t "]) {
      expect(ingestGroupDescription(raw)).toEqual({ text: null, note: "none", removed: 0 });
    }
  });

  it("masks, trims, and says only how long it is and how many numbers went", () => {
    const r = ingestGroupDescription("  Mondays 20:30, £7.\nSort 12-34-56 Acc 12345678  ");
    expect(r.text).toBe(`Mondays 20:30, £7.\nSort ${X} Acc ${X}`);
    expect(r.removed).toBe(2);
    expect(r.note).toBe(`${r.text!.length} chars, 2 number(s) removed`);
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
    expect(r.text!.length).toBeGreaterThan(GROUP_DESCRIPTION_MAX_CHARS - 20);
    expect(r.text).not.toMatch(/\d/);
    expect(r.text!.replaceAll(X, "")).toMatch(/^a+$/);
  });

  it("drops what Postgres would refuse, and other control characters, but keeps new lines", () => {
    expect(ingestGroupDescription("Mon\u0000day\r\n9pm\u0007 \u{1f600}").text).toBe("Monday\n9pm \u{1f600}");
    // A lone surrogate is not text.
    expect(ingestGroupDescription("9pm \ud83d").text).toBe("9pm \ufffd");
  });

  it("is idempotent: what it kept, ingested again, is kept as it is", () => {
    const first = ingestGroupDescription("Mondays 20:30. Sort 12-34-56, IBAN TR33 0006 1005 1978 6457 8413 26").text;
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
