/**
 * The group description masker, second review of PR #233: link handling,
 * one mapping bug, idempotence, and over-masking of short descriptions.
 * Every input here came out wrong before these fixes. The rules are in
 * src/lib/group-description.ts; the first review's cases are in
 * group-description.test.ts. Pure: no database, no model.
 */
import { describe, expect, it } from "vitest";
import {
  EMAIL_REMOVED,
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
const table = (cases: Array<[string, string]>) =>
  it.each(cases)("%j", (input, expected) => {
    expect(mask(input)).toBe(expected);
    expect(mask(mask(input))).toBe(mask(input));
  });

describe("fix 1: a link straight after dots", () => {
  table([
    ["Pay here...monzo.me/kemal", `Pay here...${LINK}`],
    ["Pay here\u2026monzo.me/kemal", `Pay here\u2026${LINK}`],
    ["pay\u2026paypal.me/kemal/5", `pay\u2026${LINK}`],
    ["\u2026revolut.me/kemal", `\u2026${LINK}`],
    ["...t.me/kemalediz", `...${LINK}`],
    ["\u2026www.monzo.me/kemal", `\u2026${LINK}`],
    ["Pay here...https://monzo.me/kemal", `Pay here...${LINK}`],
    ["Pay:.monzo.me/kemal", `Pay:.${LINK}`],
  ]);
});

describe("fix 2: a link ends where a link ends, and what is glued to it is judged", () => {
  table([
    ["\u{1f4cd}maps.app.goo.gl/AbC123\u{1f4de}07700900123", `\u{1f4cd}maps.app.goo.gl/AbC123\u{1f4de}${X}`],
    ["https://maps.app.goo.gl/AbC123,07700900123", `https://maps.app.goo.gl/AbC123,${X}`],
    ["(https://maps.app.goo.gl/AbC123)07700900123", `(https://maps.app.goo.gl/AbC123)${X}`],
    ["https://maps.app.goo.gl/AbC123,monzo.me/kemal", `https://maps.app.goo.gl/AbC123,${LINK}`],
    ["Pitch:https://maps.app.goo.gl/AbC,pay:monzo.me/kemal", `Pitch:https://maps.app.goo.gl/AbC,pay:${LINK}`],
    ["https://maps.app.goo.gl/AbC123-Kemal:07700900123", `https://maps.app.goo.gl/AbC123-Kemal:${X}`],
    ["https://what3words.com/filled.count.soap,07700900123", `https://what3words.com/filled.count.soap,${X}`],
    ["https://www.google.com/maps/place/Goals/@51.42,-0.21,17z\u{1f4de}07700900123", `https://www.google.com/maps/place/Goals/@51.42,-0.21,17z\u{1f4de}${X}`],
    // A phone number glued INTO the link: the link is no longer a map link.
    ["https://maps.app.goo.gl/AbC12307700900123", LINK],
    ["https://maps.app.goo.gl/AbC123/07700900123", LINK],
    ["https://maps.app.goo.gl/AbC123\u200b07700900123", LINK],
    ["https://maps.google.com/?q=51.36,-0.19,07700900123", LINK],
    // The share suffix of a real short link is left as it is.
    ["https://maps.app.goo.gl/AbC123xyz?g_st=iw", "https://maps.app.goo.gl/AbC123xyz?g_st=iw"],
    ["See (https://example.com/a_(b)). Thanks", `See (${LINK}). Thanks`],
  ]);
});

describe("fix 3: the earliest link in a run of link characters wins, and takes the rest with it", () => {
  table([
    ["monzo.me/kemal/https://maps.google.com/x", LINK],
    ["Pay monzo.me/kemal(https://maps.app.goo.gl/AbC)", `Pay ${LINK}`],
    ["paypal.me/kemal,www.waze.com", LINK],
    ["monzo.me/kemal?u=https://x.com", LINK],
    ["monzo.me/kemal#www.maps.google.com/x", LINK],
    ["wa.me/447700900123?https://maps.google.com", LINK],
  ]);
});

describe("fix 4: the map allow-list", () => {
  const notMaps = [
    // a. look-alike hosts: a map host is plain ASCII, as written.
    "https://maps.g\u00f6\u00f6gle.com/pay",
    "https://what3w\u00f6rds.com/pay",
    "https://\u00f6sm.org/pay",
    "https://maps.goo\u0301gle.com/pay",
    "https://maps.go\u200bogle.com/pay",
    "https://m\u0430ps.google.com/pay",
    // b. only Google's own country domains.
    "https://google.xyz/maps",
    "https://maps.google.xyz/pay",
    "https://maps.google.com.ev/pay",
    "https://google.evil/maps",
    // c. a map link that carries something else.
    "https://maps.google.com/?q=x&redirect=https://monzo.me/kemal",
    "https://www.google.com/maps/dir//monzo.me/kemal",
    "https://maps.google.com/?q=07700900123",
    "https://maps.google.com/?q=kemal@evil.example",
    "https://maps.google.com/?u=www.evil.example",
    "waze.com/ul?ll=51.5,-0.1&n=07700900123",
    "what3words.com/12345678",
    "maps.app.goo.gl/07700900123",
    "osm.org/go/07700900123",
    // Still refused, as before.
    "https://maps.google.com@evil.example/x",
    "https://maps.google.com.evil.example/x",
    "https://maps.google.com:443/x",
    "https://maps.google.com./x",
    "ftp://maps.google.com/x",
    "goo.gl/abc123456",
  ];
  it.each(notMaps)("not a map link, removed whole: %s", (url) => {
    expect(isMapLink(url)).toBe(false);
    const out = maskGroupDescription(`Pitch ${url} ok`);
    expect(out.text).toBe(`Pitch ${LINK} ok`);
    expect(out.kept.mapLinks).toEqual([]);
  });

  const realShaped = [
    "https://www.google.com/maps/place/Goals+Sutton/@51.3618,-0.1945,17z/data=!3m1!4b1!4m6!3m5!1s0x4876089e0b9f6c0d:0x5e6e5f0d1f0b7a0a!8m2!3d51.361800!4d-0.194500",
    "https://maps.apple.com/?ll=51.361800,-0.194500&q=Goals%20Sutton",
    "https://waze.com/ul?ll=51.36180000,-0.19450000&navigate=yes",
    "https://what3words.com/filled.count.soap",
    "https://www.openstreetmap.org/?mlat=51.36180&mlon=-0.19450#map=17/51.36180/-0.19450",
  ];
  it.each(realShaped)("a real-shaped map link is kept whole: %s", (url) => {
    expect(isMapLink(url)).toBe(true);
    expect(mask(`Pitch: ${url}. Sort 12-34-56`)).toBe(`Pitch: ${url}. Sort ${X}`);
  });

  const googleDomains = ["com", "co.uk", "com.tr", "de", "fr", "es", "it", "nl", "ie", "pt", "be", "ch", "at", "se", "no", "dk", "pl", "gr", "ca", "com.au"];
  it.each(googleDomains)("Google's domain .%s is a map host", (cc) => {
    expect(isMapLink(`https://maps.google.${cc}/?q=51.36,-0.19`)).toBe(true);
    expect(isMapLink(`https://www.google.${cc}/maps/place/Goals`)).toBe(true);
    expect(isMapLink(`https://www.google.${cc}/search?q=x`)).toBe(false);
  });

  it("the digit-run limits: 8 in a row in a long map link (coordinates), 6 in a short one", () => {
    expect(isMapLink("https://waze.com/ul?ll=51.36180000,-0.19450000")).toBe(true);
    expect(isMapLink("https://waze.com/ul?ll=51.361800001,-0.19450000")).toBe(false);
    expect(isMapLink("https://maps.app.goo.gl/Ab123456Cd")).toBe(true);
    expect(isMapLink("https://maps.app.goo.gl/Ab1234567Cd")).toBe(false);
  });
});

describe("fix 5: two removals that share one original character", () => {
  const cases = [
    "kemal@x.co\u33a807700900123", // U+33A8 is "m/s2" in one character
    "kemal@x.co\u33a8 07700 900123",
    "a@b.co\u33a84929123456789012",
    "GB29 NWBK 6016 1331 9268 1\u00bd07700900123", // one half is "1/2"
    "GB29 NWBK 6016 1331 9268 1\u00bd345678",
    "TR33 0006 1005 1978 6457 8413 2\u215207700900123", // one tenth is "1/10"
  ];
  it.each(cases)("a single pass leaves no number: %j", (input) => {
    const out = maskGroupDescription(input);
    expect(out.text.normalize("NFKC")).not.toMatch(/[\p{Nd}\p{No}]{2}/u);
    expect(out.text).toContain(X);
    expect(mask(out.text)).toBe(out.text);
  });
});

describe("fix 6: a placeholder is one token to every rule", () => {
  table([
    ["x.co/[link removed]", "x.co/[link removed]"],
    ["pay x.co/y[number removed]", `pay ${LINK}[number removed]`],
    ["[link removed]/07700900123", `[link removed]/${X}`],
    ["[email removed]@x.com", "[email removed]@x.com"],
    ["x.[link removed]/y", "x.[link removed]/y"],
    ["a@[email removed].com", "a@[email removed].com"],
    ["GB29 NWBK 6016 1331 9268 [number removed]19", `GB29 NWBK ${X} [number removed]${X}`],
    // Digits on both sides of a placeholder are one number with a hole in
    // it: a placeholder does not end a cluster.
    ["07700[number removed]900123", `${X}[number removed]${X}`],
    ["12345 [link removed] 6789", `${X} [link removed] ${X}`],
    ["1234 monzo.me/x 5678", `${X} ${LINK} ${X}`],
    ["12345[number removed]", "12345[number removed]"],
    // But it sets a shape apart, like a comma.
    ["20:30 [link removed] 07700 900123", `20:30 [link removed] ${X}`],
    ["Pitch 12 https://maps.app.goo.gl/AbC 20:30", "Pitch 12 https://maps.app.goo.gl/AbC 20:30"],
    ["tel [number removed]pm", "tel [number removed]pm"],
    ["Mon [number removed] 12 10 26", `Mon [number removed] ${X}`],
  ]);
});

describe("fix 7: short telegraphic descriptions keep the kick-off and the squad size", () => {
  const kept = [
    "Mondays 20:30 14 players",
    "Ma\u00e7 saati 21:00 14 ki\u015fi 150 TL",
    "Every Tuesday 19.30 12 players",
    "Thursday 20:00-21:00 12 players 6 a side £5.50",
    "KO 20:30 14 max £6",
    "Pitch 12 20:30",
    "Court 10 19:00",
    "20:30 60 mins",
    "12/10 14 players",
    "Wed 6 a side 21:00 Pitch 12 20:30 arrival",
    "Ma\u00e7 12.10 21.00",
    "Cmt 12.10 21.00",
    // The same rules, other spellings.
    "Ma\u00e7 21.00 14 ki\u015fi",
    "21.00-22.00 14 ki\u015fi",
    "8-9pm 14 players",
    "20.30 21.30",
    "£6 14 players",
    "12/10 20:30 14",
    "20:30 14 kisi 150 TL saha 3",
  ];
  it.each(kept)("%s", (s) => {
    expect(mask(s)).toBe(s);
  });

  table([
    // More than one loose group beside the time: not a count, a number.
    ["20:45 17 30", X],
    ["Sort code 1:12 34 56", `Sort code ${X}`],
    ["20:30 14 12", X],
    // A loose group of three digits or more.
    ["20:30 147", X],
    ["12/10/2026 5678", X],
    // A dashed pair is how a sort code is written: it keeps giving way.
    ["Sort 20-45 77", `Sort ${X}`],
    ["Sort 20-10 25", `Sort ${X}`],
    // Three dotted pairs, or two with anything loose, are not a date and a time.
    ["12.10 21.00 34.56", X],
    ["07.30 09.00 12.30", X],
    ["12.34 56.78", X],
    ["12.10 21.00 14", X],
    ["12.10 19.10 26.10", X],
  ]);

  it("what the new rule knowingly lets through: a sort code written as a time and a pair", () => {
    // One group of two digits beside a time is a count. Nobody writes a
    // sort code this way, and the account number beside it still goes.
    expect(mask("12:34 56")).toBe("12:34 56");
    expect(mask("12.34 56")).toBe("12.34 56");
    expect(mask("Sort 12:34 56 acc 12345678")).toBe(`Sort 12:34 56 acc ${X}`);
  });
});

describe("fix 8: email addresses that survived, and what is left of a card", () => {
  table([
    ["jos\u00e9@gmail.com", EMAIL],
    ["kemal@ex\u00e4mple.com", EMAIL],
    ["kemal@gmail.com-Kemal", `${EMAIL}-Kemal`],
    ["kemal@m\u00fcller.de", EMAIL],
    ["kemal@gmail.com07700900123", `${EMAIL}${X}`],
    ["kemal@gmail.com,ali@x.org", `${EMAIL},${EMAIL}`],
    ["mailto:kemal@x.com", `mailto:${EMAIL}`],
    ["PayPal: kemal.ediz@cressoft.io.", `PayPal: ${EMAIL}.`],
    ["4929-1234-5678-9012 exp 12/27 cvv 123", `${X} exp ${X} cvv ${X}`],
    ["Kart no: 4543 1234 5678 9012 son kullanma 12/27", `Kart no: ${X} son kullanma ${X}`],
    ["Card 4929 1234 5678 9012, expiry: 12/2027, CVC 1234", `Card ${X}, expiry: ${X}, CVC ${X}`],
    // Only on the line a number was removed from.
    ["exp 12/27 cvv 123", "exp 12/27 cvv 123"],
    ["Card 4929 1234 5678 9012\nNext game 12/27, exp 12/27", `Card ${X}\nNext game 12/27, exp 12/27`],
    ["Expect 14 players. Acc 12345678", `Expect 14 players. Acc ${X}`],
  ]);
});

describe("ingest: the same through the door", () => {
  it("is stable on the review's link and placeholder inputs", () => {
    for (const s of ["monzo.me/kemal?u=https://x.com", "x.co/[link removed]", "07700[number removed]900123", "kemal@x.co\u33a807700900123"]) {
      const first = ingestGroupDescription(s).text;
      expect(ingestGroupDescription(first).text).toBe(first);
    }
  });
});

describe("the cut at the limit", () => {
  it("a placeholder cut in half at the limit is dropped, and what came before it is kept", () => {
    const words = "a".repeat(4080);
    const r = ingestGroupDescription(`${words} 1234567`);
    expect(r.text).toBe(words);
    expect(ingestGroupDescription(r.text).text).toBe(words);
  });

  it("one enormous word is not thrown away for being cut", () => {
    const raw = `${"123456a".repeat(10)}${"b".repeat(4020)}`;
    const r = ingestGroupDescription(raw).text!;
    expect(r.length).toBeGreaterThan(3800);
    expect(ingestGroupDescription(r).text).toBe(r);
  });
});

describe("a bracket around a removed number goes with it", () => {
  table([
    ["bank transfer (20-45-77 / 83142267)", `bank transfer ${X}`],
    ["Call (020) 7946 0958", `Call ${X}`],
    ["(07700 900123) or (20:30)", `${X} or (20:30)`],
  ]);
});

// ── The golden descriptions ──────────────────────────────────────────────

/**
 * Thirty realistic group descriptions, English and Turkish, from the second
 * review. `null` means "kept exactly as written". What is removed is bank
 * details, phone numbers and payment links; kick-off, squad size, price,
 * pitch and map link all survive.
 */
const GOLDEN: Array<[input: string, expected: string | null]> = [
  [
    "Sutton Monday 7s \u26bd\nEvery Monday 20:30 - 21:30 at Goals Sutton, pitch 4\n14 players max, £6 each\nPay Kemal: 20-45-77 83142267\nhttps://maps.app.goo.gl/AbC123xyz",
    `Sutton Monday 7s \u26bd\nEvery Monday 20:30 - 21:30 at Goals Sutton, pitch 4\n14 players max, £6 each\nPay Kemal: ${X}\nhttps://maps.app.goo.gl/AbC123xyz`,
  ],
  [
    "Tuesday 5 a side. KO 8pm sharp, Powerleague Shoreditch. £7 pp. First 10 names in. Pay by monzo.me/kemaled or cash. No shows pay double. Kemal 07700 900123",
    `Tuesday 5 a side. KO 8pm sharp, Powerleague Shoreditch. £7 pp. First 10 names in. Pay by ${LINK} or cash. No shows pay double. Kemal ${X}`,
  ],
  [
    "Thursday Vets (over 35s)\nKick off 7.30pm, 3G pitch 2, Whitgift School CR2 6YT\n7v7, 14 max + 2 subs\n£5 per game or £18 for the month\nSort 20 45 77 Acc 83142267 ref your name",
    `Thursday Vets (over 35s)\nKick off 7.30pm, 3G pitch 2, Whitgift School CR2 6YT\n7v7, 14 max + 2 subs\n£5 per game or £18 for the month\nSort ${X} Acc ${X} ref your name`,
  ],
  ["Mondays 20:30 14 players", null],
  [
    "Sunday league 2025/26 season. Home games 10:30 at King George's Field. Training Wed 19:00-20:30. Subs £40 for the season, match fee £8. Treasurer: Dave 07700 900456",
    `Sunday league 2025/26 season. Home games 10:30 at King George's Field. Training Wed 19:00-20:30. Subs £40 for the season, match fee £8. Treasurer: Dave ${X}`,
  ],
  ["Wed 6 a side 21:00 Pitch 12 20:30 arrival. £5.50 each, 12 players", null],
  [
    "\u26bd Friday footy \u26bd\n\u{1f4cd} Goals Wimbledon https://www.google.com/maps/place/Goals+Wimbledon/@51.42,-0.21,17z\n\u{1f557} 8-9pm\n\u{1f4b7} £6\n\u{1f465} 5v5, max 10\n\u{1f4de} Kemal 07700900123",
    `\u26bd Friday footy \u26bd\n\u{1f4cd} Goals Wimbledon https://www.google.com/maps/place/Goals+Wimbledon/@51.42,-0.21,17z\n\u{1f557} 8-9pm\n\u{1f4b7} £6\n\u{1f465} 5v5, max 10\n\u{1f4de} Kemal ${X}`,
  ],
  ["Game on 12/10 moved to 13/10 at 9pm. From 3/11 we're back to Mondays 8pm. 2 teams of 7.", null],
  ["Saturday 9am, 11 a side, 22 players + 3 subs. £4. Ref costs £30 split between 22. Bibs: Ali. Postcode SM1 4BX. what3words.com/filled.count.soap", null],
  [
    "Pazartesi hal\u0131 saha \u26bd Her pazartesi 21.00-22.00, Kad\u0131k\u00f6y Arena saha 3. 14 ki\u015fi, ki\u015fi ba\u015f\u0131 150 TL. IBAN: TR33 0006 1005 1978 6457 8413 26 Ali Veli",
    `Pazartesi hal\u0131 saha \u26bd Her pazartesi 21.00-22.00, Kad\u0131k\u00f6y Arena saha 3. 14 ki\u015fi, ki\u015fi ba\u015f\u0131 150 TL. IBAN: ${X} Ali Veli`,
  ],
  [
    "\u00c7ar\u015famba 20:30 ma\u00e7. 7'ye 7. \u00dccret 200 TL. \u00d6deme: Papara 1234567890 veya elden. Konum: https://maps.app.goo.gl/XyZ987\n\u0130leti\u015fim: Mehmet 0532 123 45 67",
    `\u00c7ar\u015famba 20:30 ma\u00e7. 7'ye 7. \u00dccret 200 TL. \u00d6deme: Papara ${X} veya elden. Konum: https://maps.app.goo.gl/XyZ987\n\u0130leti\u015fim: Mehmet ${X}`,
  ],
  [
    "Cuma ak\u015fam\u0131 22.00 Be\u015fikta\u015f hal\u0131 saha. Saha \u00fccreti 2.800 TL, 14 ki\u015fi 200'er TL. Gelmeyen 24 saat \u00f6nce haber versin. Hesap: Ziraat 1234-56789012-5001",
    `Cuma ak\u015fam\u0131 22.00 Be\u015fikta\u015f hal\u0131 saha. Saha \u00fccreti 2.800 TL, 14 ki\u015fi 200'er TL. Gelmeyen 24 saat \u00f6nce haber versin. Hesap: Ziraat ${X}`,
  ],
  ["Sal\u0131 ve Per\u015fembe 19:30-20:30, 6v6, 12 ki\u015fi + 2 yedek. Ayl\u0131k 800 TL, tek ma\u00e7 250 TL. \u0130lk ma\u00e7 14.10.2026. Kaptan: Emre", null],
  ["Her cumartesi saat 10'da, 8'e 8, 16 ki\u015fi. Ma\u00e7 ba\u015f\u0131 175 TL nakit. Saha: Ata\u015fehir Spor Tesisleri 2. saha. Yer ay\u0131rtmak i\u00e7in gruba yaz\u0131n.", null],
  [
    "Monday 8pm & Thursday 9pm. 5 a side x 2 pitches = 20 players. £5 (£4 students). 2026 fees unchanged. Rules: 1) shin pads 2) no slide tackles 3) pay before you play. Acc 83142267 SC 204577",
    `Monday 8pm & Thursday 9pm. 5 a side x 2 pitches = 20 players. £5 (£4 students). 2026 fees unchanged. Rules: 1) shin pads 2) no slide tackles 3) pay before you play. Acc ${X} SC ${X}`,
  ],
  [
    "7 a side Tuesdays 7-8pm @ Harris Academy, 14 players. £5 cash or bank transfer (20-45-77 / 83142267)",
    `7 a side Tuesdays 7-8pm @ Harris Academy, 14 players. £5 cash or bank transfer ${X}`,
  ],
  ["KO 20:00. 16 players. £6. Astro pitch 3.", null],
  ["Ma\u00e7 saati 21:00 14 ki\u015fi 150 TL", null],
  ["Sundays 10am-11am, 10 players, £5", null],
  ["Next games: Mon 12 Oct 20:30, Mon 19 Oct 20:30, Mon 26 Oct 21:00. 14 a game. £6.", null],
  ["Mon 20:30 / Wed 21:00 / Fri 19:30 - 5 a side - 10 max - £7", null],
  ["8pm kick off, 10 players, 2 teams of 5, 60 mins, £6", null],
  ["Pitch 3, 20:30, 14 players, £5", null],
  ["20:30 14 ki\u015fi 150 TL saha 3", null],
  ["Mondays 8.30pm 14 players £6 pitch 2", null],
  ["Every Tuesday 19.30 12 players", null],
  ["Ma\u00e7 21.00 14 ki\u015fi", null],
  ["Thursday 20:00-21:00 12 players 6 a side £5.50", null],
  ["U16s training Tue 18:00 & Thu 18:30, match Sat 10:30. Season 2026/27. 18 in squad.", null],
  ["5-a-side, 40 mins, 2 x 20 min halves, 10 players, £35 pitch split 10 ways", null],
];

describe("thirty realistic descriptions", () => {
  it.each(GOLDEN.map(([input, expected], n) => [n + 1, input, expected] as const))("description %i", (_n, input, expected) => {
    const out = ingestGroupDescription(input).text;
    expect(out).toBe(expected ?? input);
    expect(ingestGroupDescription(out).text).toBe(out);
  });
});
