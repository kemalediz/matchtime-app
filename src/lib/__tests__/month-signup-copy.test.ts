/**
 * Monthly squad, slice 3: the sign-up list as MatchTime posts it
 * (MDs/monthly-squad-plan-2026-10-05.md, 4.1). The post must read back
 * through the slice 1 reader, the words it tells a member to type must be
 * the words `readSignupMessage` reads, and a member who pastes the post
 * back must not have its footer read as their own message.
 */
import { describe, expect, it } from "vitest";
import { parseMonthlyList } from "@/lib/monthly-list";
import { buildSignupListPost, isMonthLevelList, paygMark, quotedSignupMonth, signupPasteResidual } from "@/lib/month-signup-copy";
import { buildWeekListPost } from "@/lib/monthly-week-copy";
import { monthKickoffs, readSignupMessage, type SignupList } from "@/lib/month-signup-rules";

const kickoffs = monthKickoffs("2026-11-01", 1, "20:00");
const list: SignupList = {
  slots: [
    { slot: 1, userId: "alex", name: "Alex Carter", paid: true },
    { slot: 2, userId: null, name: "", paid: false },
    { slot: 3, userId: "chris", name: "Chris Bell", paid: false },
    { slot: 4, userId: null, name: "", paid: false },
  ],
  payg: [{ slot: 5, userId: "omar", name: "Omar Khan", days: [9, 23] }],
  waiting: [{ userId: "eve", name: "Eve Stone" }],
  regulars: 2,
};
const facts = { kickoffs, carriedFrom: new Date("2026-10-15T12:00:00.000Z"), endsAt: new Date("2026-10-27T10:00:00.000Z") };

describe("the sign-up list post", () => {
  it("English, in the group's own format", () => {
    expect(buildSignupListPost({ list, ...facts, lang: "en" })).toBe(
      [
        "📋 List for November (5 Mondays: 2, 9, 16, 23, 30)",
        "",
        "1. Alex Carter (paid)",
        "2.",
        "3. Chris Bell",
        "4.",
        "5. Omar Khan (PAYG 9, 23)",
        "",
        "Reserves",
        "1. Eve Stone",
        "",
        "Regulars from October are on already. Not in for November? Say *OUT FOR NOVEMBER*.",
        "Want a place for November? Copy the list and add your name, or say *IN FOR NOVEMBER*.",
        "Playing some weeks only? Add your name with (PAYG), or (PAYG 9 only).",
        "Or sign up here: https://matchtime.ai/month",
        "Names in by Tue 27 Oct, 10:00. Price and payment details follow once numbers are in.",
      ].join("\n"),
    );
  });

  it("Turkish", () => {
    const text = buildSignupListPost({ list, ...facts, lang: "tr" });
    expect(text.split("\n")[0]).toBe("📋 Kasım listesi (5 Pazartesi: 2, 9, 16, 23, 30)");
    expect(text).toContain("Ekim ayının daimi oyuncuları listede. Kasım ayında yok musun? *KASIM YOKUM* yaz.");
    expect(text).toContain("*KASIM VARIM* yaz.");
    expect(text).toContain("1. Alex Carter (ödedi)");
    expect(text).toContain("İsimler için son an: 27 Ekim Salı 10:00.");
  });

  it("nobody carried over: no line about last month", () => {
    const text = buildSignupListPost({ list, ...facts, carriedFrom: null, lang: "en" });
    expect(text).not.toContain("Regulars from");
    expect(text).toContain("Not in for November? Say *OUT FOR NOVEMBER*.");
  });

  it("no em or en dash, in either language", () => {
    for (const lang of ["en", "tr"]) expect(buildSignupListPost({ list, ...facts, lang })).not.toMatch(/[—–]/);
  });

  for (const lang of ["en", "tr"]) {
    it(`reads back through the list reader (${lang})`, () => {
      const read = parseMonthlyList(buildSignupListPost({ list, ...facts, lang }))!;
      expect(read.month?.month).toBe(11);
      expect(read.slots.map((e) => [e.slot, e.name, e.marks.paid, e.marks.payg])).toEqual([
        [1, "Alex Carter", true, false],
        [2, "", false, false],
        [3, "Chris Bell", false, false],
        [4, "", false, false],
        [5, "Omar Khan", false, true],
      ]);
      expect(read.slots[4].marks.paygDates.map((d) => d.day)).toEqual([9, 23]);
      // Whoever is waiting is never read as a place on the list.
      expect(read.slots.some((e) => e.name === "Eve Stone")).toBe(false);
    });

    it(`the words it tells a member to type are the words that are read (${lang})`, () => {
      const text = buildSignupListPost({ list, ...facts, lang });
      const told = [...text.matchAll(/\*([^*]+)\*/g)].map((m) => m[1]);
      expect(told).toHaveLength(2);
      expect(told.map((w) => readSignupMessage(w, { quoted: false }))).toEqual([
        { choice: "out", month: 11, days: [] },
        { choice: "in", month: 11, days: [] },
      ]);
    });

    it(`a member who pastes the whole post back has typed nothing (${lang})`, () => {
      const text = buildSignupListPost({ list, ...facts, lang });
      expect(signupPasteResidual(text, { ...facts, lang })).toBe("");
      expect(signupPasteResidual(`${text}\n\ncan't do the 16th lads`, { ...facts, lang })).toBe("can't do the 16th lads");
      // A copy of an OLDER post (another deadline) is still our own furniture.
      const older = buildSignupListPost({ list, ...facts, endsAt: new Date("2026-10-26T18:00:00.000Z"), lang });
      expect(signupPasteResidual(older, { ...facts, lang })).toBe("");
    });
  }

  it("the PAYG mark", () => {
    expect(paygMark([])).toBe("(PAYG)");
    expect(paygMark([9])).toBe("(PAYG 9)");
  });
});

describe("is it MatchTime's own MONTH list?", () => {
  const week = buildWeekListPost({
    list: { slots: [{ slot: 1, userId: "alex", name: "Alex Carter", mark: "paid" }], paidCantPlay: [], cantPlay: [], reserves: [], open: 1 },
    matchDate: kickoffs[0],
    paygPricePence: 800,
    lang: "en",
  });

  it("the sign-up list is, in both languages, with or without the emoji, with words typed above it", () => {
    for (const lang of ["en", "tr"]) {
      const text = buildSignupListPost({ list, ...facts, lang });
      expect(isMonthLevelList(text), lang).toBe(true);
      expect(isMonthLevelList(text.replace("📋 ", "")), lang).toBe(true);
      expect(isMonthLevelList(`here you go lads\n${text}`), lang).toBe(true);
    }
  });

  it("a list the group typed itself, and the WEEK's list, are not", () => {
    expect(isMonthLevelList("List for November:\n1. Alex\n2. Bilal (paid)")).toBe(false);
    expect(isMonthLevelList("Kasım listesi\n1. Alex")).toBe(false);
    expect(isMonthLevelList(week)).toBe(false);
  });

  it("a bare IN counts for the month ONLY as a reply to the sign-up list, never to the week's list", () => {
    expect(quotedSignupMonth(buildSignupListPost({ list, ...facts, lang: "en" }))).toBe(11);
    expect(quotedSignupMonth(buildSignupListPost({ list, ...facts, lang: "tr" }))).toBe(11);
    // "📋 List for November: Mon 2 Nov, 20:00" is this week's game.
    expect(quotedSignupMonth(week)).toBeNull();
    expect(quotedSignupMonth("List for November\n1. Alex")).toBeNull();
    expect(quotedSignupMonth("see you in November")).toBeNull();
    expect(quotedSignupMonth(null)).toBeNull();
  });
});
