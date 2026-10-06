/**
 * Monthly squad, slice 4: the priced list and the payment messages
 * (MDs/monthly-squad-plan-2026-10-05.md, 4.2 and 4.3). The priced list
 * must read back through the slice 1 reader with every name intact, so a
 * member can add "(paid)" and paste it; the words the collector is told
 * to reply with must be the words that are read.
 */
import { describe, expect, it } from "vitest";
import { parseMonthlyList } from "@/lib/monthly-list";
import {
  buildClaimsDigest,
  buildCollectorReplyAnswer,
  buildGroupPayReminder,
  buildPaidClaimAckDm,
  buildPayBySummary,
  buildPayReminderDm,
  buildPricedListPost,
  pounds,
  type PricedLine,
} from "@/lib/month-payment-copy";
import { readCollectorReply, readPaidMessage } from "@/lib/month-payment-rules";
import { isMonthLevelList } from "@/lib/month-signup-copy";
import { monthKickoffs, type SignupList } from "@/lib/month-signup-rules";

const kickoffs = monthKickoffs("2026-11-01", 1, "20:00");
const payByAt = new Date("2026-10-30T21:00:00.000Z");
const list: SignupList = {
  slots: [
    { slot: 1, userId: "alex", name: "Alex Carter", paid: false },
    { slot: 2, userId: "bilal", name: "Bilal Aydin", paid: true },
    { slot: 3, userId: null, name: "", paid: false },
    { slot: 4, userId: "carl", name: "Carl Young", paid: true },
  ],
  payg: [{ slot: 5, userId: "omar", name: "Omar Khan", days: [9, 23] }],
  waiting: [],
  regulars: 3,
};
const lines = new Map<string, PricedLine>([
  ["alex", { amountDuePence: 3750, paid: "none", paidPence: null }],
  ["bilal", { amountDuePence: 3000, paid: "claimed", paidPence: null }],
  ["carl", { amountDuePence: 2500, paid: "confirmed", paidPence: 2500 }],
]);
const post = (lang: string, instructions: string | null = "Bank details are in the group description.") =>
  buildPricedListPost({ list, lines, kickoffs, sharePence: 750, payByAt, collectorName: "Sam Collector", instructions, lang });

describe("the priced list", () => {
  it("English", () => {
    expect(post("en")).toBe(
      [
        "📋 List for November: £7.50 a game, pay Sam by Fri 30 Oct, 21:00",
        "(5 games = £37.50. Credits are already taken off.)",
        "",
        "1. Alex Carter (£37.50)",
        "2. Bilal Aydin (paid £30)",
        "3.",
        "4. Carl Young (paid £25)",
        "",
        "Payment: Bank details are in the group description.",
        'Paid? Add (paid) after your name and paste the list, or DM me "paid".',
      ].join("\n"),
    );
  });

  it("Turkish", () => {
    const text = post("tr");
    expect(text.split("\n")[0]).toBe("📋 Kasım listesi: maç başı £7.50, son ödeme 30 Ekim Cuma 21:00 (Sam)");
    expect(text).toContain("2. Bilal Aydin (ödedi £30)");
    expect(text).toContain('bana özelden "ödedim" yaz');
  });

  it("no instructions: no payment line; instructions over several lines sit on one", () => {
    expect(post("en", null)).not.toContain("Payment:");
    expect(post("en", "Sort code in the description.\n1. Use your name as the reference")).toContain(
      "Payment: Sort code in the description. 1. Use your name as the reference",
    );
  });

  for (const lang of ["en", "tr"]) {
    it(`reads back through the list reader with every name and mark (${lang})`, () => {
      const read = parseMonthlyList(post(lang, "Sort code in the description.\n1. Use your name"))!;
      expect(read.month?.month).toBe(11);
      expect(read.slots.map((e) => [e.slot, e.name, e.marks.paid, e.marks.payg])).toEqual([
        [1, "Alex Carter", false, false],
        [2, "Bilal Aydin", true, false],
        [3, "", false, false],
        [4, "Carl Young", true, false],
      ]);
    });

    it(`a member adds (paid) to their line and it is read as their claim (${lang})`, () => {
      const mark = lang === "tr" ? "(ödedi)" : "(paid)";
      const read = parseMonthlyList(post(lang).replace("1. Alex Carter (£37.50)", `1. Alex Carter (£37.50) ${mark}`))!;
      expect(read.slots[0]).toMatchObject({ name: "Alex Carter", marks: { paid: true } });
    });

    it(`no em or en dash (${lang})`, () => {
      expect(post(lang)).not.toMatch(/[—–]/);
    });
  }
});

describe("is it one of MatchTime's own month lists?", () => {
  it("the priced list and the sign-up list are, in both languages, with or without the emoji", async () => {
    const { buildSignupListPost } = await import("@/lib/month-signup-copy");
    for (const lang of ["en", "tr"]) {
      expect(isMonthLevelList(post(lang)), lang).toBe(true);
      expect(isMonthLevelList(post(lang).replace("📋 ", "")), lang).toBe(true);
      const signup = buildSignupListPost({ list, kickoffs, carriedFrom: null, endsAt: payByAt, lang });
      expect(isMonthLevelList(signup), lang).toBe(true);
      expect(isMonthLevelList(`here you go lads\n${signup}`), lang).toBe(true);
    }
  });
  it("a list the group typed itself, and the WEEK's list, are not", async () => {
    const { buildWeekListPost } = await import("@/lib/monthly-week-copy");
    expect(isMonthLevelList("List for November:\n1. Alex\n2. Bilal (paid)")).toBe(false);
    expect(isMonthLevelList("List for November\n1. Alex (paid £37.50)")).toBe(false);
    expect(isMonthLevelList("Kasım listesi\n1. Alex")).toBe(false);
    const week = buildWeekListPost({
      list: { slots: [{ slot: 1, userId: "alex", name: "Alex Carter", mark: "paid" }], paidCantPlay: [], cantPlay: [], reserves: [], open: 1 },
      matchDate: kickoffs[0],
      paygPricePence: 800,
      lang: "en",
    });
    expect(isMonthLevelList(week)).toBe(false);
  });
});

describe("the collector's digest", () => {
  const digest = (lang: string) =>
    buildClaimsDigest({
      claims: [
        { slot: 1, name: "Alex Carter", amountPence: 3750 },
        { slot: 7, name: "Carl Young", amountPence: null },
      ],
      monthDate: kickoffs[0],
      lang,
    });

  it("lists each claim by its number on the month's list", () => {
    expect(digest("en")).toBe(
      "💷 2 say they've paid for November:\n1. Alex Carter £37.50\n7. Carl Young\n\nReply *PAID ALL*, or *PAID* and the numbers that arrived (PAID 1 3), or *PAID NONE*.",
    );
  });

  for (const lang of ["en", "tr"]) {
    it(`the replies it asks for are the replies that are read (${lang})`, () => {
      const text = digest(lang);
      const told = [...text.matchAll(/\*([^*]+)\*/g)].map((m) => m[1]);
      expect(readCollectorReply(told[0])).toEqual({ kind: "all" });
      expect(readCollectorReply(told[told.length - 1])).toEqual({ kind: "none" });
      const example = /\(([^)]*\d[^)]*)\)/.exec(text)![1];
      expect(readCollectorReply(example)).toEqual({ kind: "numbers", numbers: [1, 3] });
    });
  }
});

describe("the rest", () => {
  it("amounts", () => {
    expect(pounds(3750)).toBe("£37.50");
    expect(pounds(3000)).toBe("£30");
    expect(pounds(20)).toBe("20p");
  });

  it("the group's count", () => {
    expect(buildGroupPayReminder({ count: 4, monthDate: kickoffs[0], payByAt, lang: "en" })).toBe("💷 4 still to pay for November, by Fri 30 Oct, 21:00.");
  });

  it("the reminder DM carries the amount, the credits, the club's own instructions, and the word to reply with", () => {
    const dm = buildPayReminderDm({
      kind: "r1",
      name: "Bilal Aydin",
      monthDate: kickoffs[0],
      amountDuePence: 3000,
      games: 5,
      credits: 1,
      payByAt,
      collectorName: "Sam Collector",
      instructions: "Bank details are in the group description.",
      lang: "en",
    });
    expect(dm).toBe(
      "👋 Bilal, your place for November is £30, to pay by Fri 30 Oct, 21:00. That is 5 games, with 1 credit taken off. Please pay Sam by bank transfer.\n\n" +
        "Bank details are in the group description.\n\nReply *paid* when you have.",
    );
    // The word it asks for is a word that is read.
    expect(readPaidMessage(/\*([^*]+)\*/.exec(dm)![1])).toEqual({ amountPence: null });
    const tr = buildPayReminderDm({ kind: "late", name: "Bilal Aydin", monthDate: kickoffs[0], amountDuePence: 3000, games: 5, credits: 0, payByAt, collectorName: null, instructions: null, lang: "tr" });
    expect(readPaidMessage(/\*([^*]+)\*/.exec(tr)![1])).toEqual({ amountPence: null });
    expect(tr).not.toMatch(/[—–]/);
  });

  it("the claim is acknowledged as a claim", () => {
    expect(buildPaidClaimAckDm({ name: "Bilal Aydin", amountPence: 3000, monthDate: kickoffs[0], collectorName: "Sam Collector", lang: "en" })).toBe(
      "✅ Bilal, noted: you say you have paid £30 for November. Sam will confirm when it arrives.",
    );
  });

  it("the collector's answers", () => {
    expect(buildCollectorReplyAnswer({ kind: "confirmed", names: ["Alex Carter"], monthDate: kickoffs[0], lang: "en" })).toBe("✅ Marked as paid for November: Alex Carter.");
    expect(buildCollectorReplyAnswer({ kind: "unknown-numbers", numbers: [9], monthDate: kickoffs[0], lang: "en" })).toContain("number 9 on the November list, so I marked nobody");
    expect(buildCollectorReplyAnswer({ kind: "nothing", lang: "en" })).toContain("Nothing is waiting");
  });

  it("the summary after the pay-by date", () => {
    expect(
      buildPayBySummary({
        monthDate: kickoffs[0],
        confirmed: { count: 11, totalPence: 28250 },
        claimed: ["Jake"],
        unpaid: [],
        venue: { duePence: 45000, venuePence: 48000 },
        lang: "en",
      }),
    ).toBe(
      [
        "📒 November: the pay-by date has passed.",
        "Paid and confirmed: 11 (£282.50).",
        "Says paid, not confirmed: 1 (Jake).",
        "Not paid: 0 (nobody).",
        "The month's shares come to £450 against a venue cost of £480.",
      ].join("\n"),
    );
  });
});
