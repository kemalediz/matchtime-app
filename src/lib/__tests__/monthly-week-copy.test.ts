/**
 * Monthly squad, slice 5: the weekly flow's words, English and Turkish
 * (MDs/monthly-squad-plan-2026-10-05.md, 5.3, 5.4, 6.2). Made-up names.
 */
import { describe, it, expect } from "vitest";
import { parseMonthlyList } from "../monthly-list";
import {
  buildPasteIgnoredAdminNotice,
  buildPasteNotAddedNotice,
  buildPasteSenderNotListDm,
  buildPasteSenderNotMatchedDm,
  buildSeedBumpedDm,
  buildPasteUndoDm,
  buildPaygPoolDm,
  buildPaygPoolGroupPost,
  buildWeekListPost,
  pasteResidual,
  paygPriceLabel,
} from "../monthly-week-copy";
import type { WeekList } from "../monthly-week-rules";

// Monday 12 October 2026, 20:00 London (BST).
const MATCH = new Date("2026-10-12T19:00:00.000Z");

const LIST: WeekList = {
  slots: [
    { slot: 1, userId: "a", name: "Alex Carter", mark: "paid" },
    { slot: 2, userId: "o", name: "Omar Khan", mark: "payg" },
    { slot: 3, userId: null, name: "", mark: null },
    { slot: 4, userId: "j", name: "Jake Moss", mark: null },
  ],
  paidCantPlay: [{ userId: "s", name: "Sam Dean" }],
  cantPlay: [{ userId: "c", name: "Chris Bell" }],
  reserves: [{ userId: "z", name: "Zed Wait" }],
  open: 1,
};

describe("buildWeekListPost", () => {
  it("English: their format, in one message", () => {
    expect(buildWeekListPost({ list: LIST, matchDate: MATCH, paygPricePence: 800, lang: "en" })).toBe(
      [
        "📋 List for October: Mon 12 Oct, 20:00",
        "",
        "1. Alex Carter (paid)",
        "2. Omar Khan (PAYG)",
        "3.",
        "4. Jake Moss",
        "",
        "Paid but can't play",
        "1. Sam Dean",
        "",
        "Can't play",
        "1. Chris Bell",
        "",
        "Reserves",
        "1. Zed Wait",
        "",
        "1 place open, £8 PAYG: say *IN* to take it.",
      ].join("\n"),
    );
  });

  it("Turkish", () => {
    expect(buildWeekListPost({ list: LIST, matchDate: MATCH, paygPricePence: 750, lang: "tr" })).toBe(
      [
        "📋 Ekim listesi: 12 Ekim Pazartesi 20:00",
        "",
        "1. Alex Carter (ödedi)",
        "2. Omar Khan (PAYG)",
        "3.",
        "4. Jake Moss",
        "",
        "Ödedi gelemiyor",
        "1. Sam Dean",
        "",
        "Gelemeyenler",
        "1. Chris Bell",
        "",
        "Yedekler",
        "1. Zed Wait",
        "",
        "1 yer boş, maç başı £7.50 (PAYG): almak için *VARIM* yazın.",
      ].join("\n"),
    );
  });

  it("a full list has no 'places open' line, and empty sections are left out", () => {
    const full: WeekList = { ...LIST, paidCantPlay: [], cantPlay: [], reserves: [], open: 0 };
    expect(buildWeekListPost({ list: full, matchDate: MATCH, paygPricePence: 800, lang: "en" })).toBe(
      ["📋 List for October: Mon 12 Oct, 20:00", "", "1. Alex Carter (paid)", "2. Omar Khan (PAYG)", "3.", "4. Jake Moss"].join("\n"),
    );
  });

  it("no price set, several places, and an organiser-pick club", () => {
    const two: WeekList = { ...LIST, paidCantPlay: [], cantPlay: [], reserves: [], open: 2 };
    expect(buildWeekListPost({ list: two, matchDate: MATCH, paygPricePence: null, lang: "en" }).split("\n").pop()).toBe(
      "2 places open: say *IN* to take one.",
    );
    expect(
      buildWeekListPost({ list: two, matchDate: MATCH, paygPricePence: 800, organiserPicks: true, lang: "en" }).split("\n").pop(),
    ).toBe("2 places open. Say *IN* to go on the waiting list, and the organisers will pick who plays.");
  });

  it.each(["en", "tr"] as const)("the list reader reads our own post back (%s): a member can copy it and paste it", (lang) => {
    const read = parseMonthlyList(buildWeekListPost({ list: LIST, matchDate: MATCH, paygPricePence: 800, lang }))!;
    expect(read.month).toEqual({ month: 10, year: null });
    expect(read.slots.map((e) => [e.slot, e.name, e.marks.paid, e.marks.payg])).toEqual([
      [1, "Alex Carter", true, false],
      [2, "Omar Khan", false, true],
      [3, "", false, false],
      [4, "Jake Moss", false, false],
    ]);
    expect(read.sections.cantPlay.map((e) => e.name)).toEqual(["Sam Dean", "Chris Bell"]);
    // Nobody under a header is ever read as a playing name.
    expect(read.slots.some((e) => e.name === "Zed Wait")).toBe(false);
  });
});

describe("the PAYG pool offer and the paste DMs", () => {
  it("the group line and the DM, English and Turkish", () => {
    expect(buildPaygPoolGroupPost({ matchDate: MATCH, paygPricePence: 800, lang: "en" })).toBe(
      "🎟 1 place open for *Mon 12 Oct, 20:00*, £8 PAYG. First to say *IN* gets it.",
    );
    expect(buildPaygPoolGroupPost({ matchDate: MATCH, paygPricePence: null, lang: "tr" })).toBe(
      "🎟 *12 Ekim Pazartesi 20:00* maçında 1 yer açık. İlk *VARIM* yazan alır.",
    );
    // One line covers every open place.
    expect(buildPaygPoolGroupPost({ open: 2, matchDate: MATCH, paygPricePence: 800, lang: "en" })).toBe(
      "🎟 2 places open for *Mon 12 Oct, 20:00*, £8 PAYG. First to say *IN* gets one.",
    );
    expect(buildPaygPoolGroupPost({ open: 2, matchDate: MATCH, paygPricePence: 800, lang: "tr" })).toBe(
      "🎟 *12 Ekim Pazartesi 20:00* maçında 2 yer açık, maç başı £8 (PAYG). İlk *VARIM* yazan alır.",
    );
    expect(buildPasteSenderNotMatchedDm({ names: ["Gaz"], lang: "en" })).toBe(
      "📋 I couldn't match Gaz on the list you pasted to a player, so I added nobody. " +
        "To play, say *IN* in the group yourself, or ask an organiser to add them.",
    );
    expect(buildPasteSenderNotListDm({ matchDate: MATCH, lang: "en" })).toBe(
      "📋 I couldn't read the list you posted as the squad list for October, so I changed nothing. " +
        'If it was the squad list, paste it with its title line ("List for October").',
    );
    expect(buildPasteSenderNotListDm({ matchDate: MATCH, lang: "tr" })).toContain('("Ekim listesi")');
    expect(buildPaygPoolDm({ name: "Omar Khan", activityName: "Monday 7-a-side", matchDate: MATCH, paygPricePence: 800, lang: "en" })).toBe(
      "👋 Omar, a place has opened for *Monday 7-a-side* on Mon 12 Oct, 20:00, £8 pay-as-you-go.\n\n" +
        "Want it? Reply *IN*. The first to say so plays. Not this time? No need to reply.",
    );
    expect(buildPaygPoolDm({ name: null, activityName: "Pazartesi 7'ye 7", matchDate: MATCH, paygPricePence: 800, lang: "tr" })).toBe(
      "👋 *Pazartesi 7'ye 7* için bir yer açıldı: 12 Ekim Pazartesi 20:00, maç başı £8.\n\n" +
        "İster misin? *VARIM* yaz. İlk yazan oynar. Bu sefer olmuyorsa cevap yazmana gerek yok.",
    );
  });

  it("D4: the undo DM names who changed the line and the one word that undoes it", () => {
    const base = { actorName: "Rob Admin", activityName: "Monday 7-a-side", matchDate: MATCH };
    expect(buildPasteUndoDm({ ...base, change: "out-paid", lang: "en" })).toBe(
      `📋 Rob Admin moved you to "Paid but can't play" for *Monday 7-a-side* on Mon 12 Oct, 20:00.\n\nWrong? Reply *IN* and I'll put you back.`,
    );
    expect(buildPasteUndoDm({ ...base, change: "out", lang: "en" })).toBe(
      "📋 Rob Admin took you off the list for *Monday 7-a-side* on Mon 12 Oct, 20:00.\n\nWrong? Reply *IN* and I'll put you back.",
    );
    expect(buildPasteUndoDm({ ...base, change: "in", lang: "en" })).toBe(
      "📋 Rob Admin added you to the list for *Monday 7-a-side* on Mon 12 Oct, 20:00.\n\nWrong? Reply *OUT* and I'll take you off.",
    );
    expect(buildPasteUndoDm({ ...base, change: "out-paid", lang: "tr" })).toBe(
      `📋 Rob Admin seni *Monday 7-a-side* (12 Ekim Pazartesi 20:00) için "Ödedi gelemiyor" bölümüne aldı.\n\nYanlış mı? *VARIM* yaz, seni geri alayım.`,
    );
    expect(buildPasteUndoDm({ ...base, change: "in", lang: "tr" })).toContain("*YOKUM* yaz, seni çıkarayım.");
  });

  it("the organisers' note about an old copy", () => {
    expect(buildPasteIgnoredAdminNotice({ actorName: "Alex", names: ["Bilal"], matchDate: MATCH, lang: "en" })).toBe(
      "📋 Alex pasted an older copy of the list for Mon 12 Oct, 20:00. I left Bilal as they were: " +
        "a pasted list cannot bring back a player who dropped out, or take out somebody else by blanking their line. " +
        "If the change is right, the player can say so, or you can make it on the match page.",
    );
  });

  it("no em or en dash anywhere, and prices read as money", () => {
    for (const lang of ["en", "tr"] as const) {
      const all = [
        buildWeekListPost({ list: LIST, matchDate: MATCH, paygPricePence: 800, lang }),
        buildPaygPoolGroupPost({ matchDate: MATCH, paygPricePence: 800, lang }),
        buildPaygPoolDm({ name: "Omar", activityName: "X", matchDate: MATCH, paygPricePence: 800, lang }),
        buildPasteUndoDm({ change: "out", actorName: "Rob", activityName: "X", matchDate: MATCH, lang }),
        buildPasteIgnoredAdminNotice({ actorName: "Alex", names: ["Bilal", "Chris"], matchDate: MATCH, lang }),
      ].join("\n");
      expect(all).not.toMatch(/[—–]/);
    }
    expect(paygPriceLabel(800)).toBe("£8");
    expect(paygPriceLabel(750)).toBe("£7.50");
    expect(paygPriceLabel(null)).toBeNull();
  });
});

describe("pasteResidual: what a member typed around the list", () => {
  const ctx = { lang: "en", maxPlayers: 14, paygPricePence: 800 };

  it("a message that is only a list leaves nothing for a model to read", () => {
    expect(pasteResidual("List for October:\n1. Alex\n2. Bilal\n3.\n\nPaid but can't play\n1. Sam", ctx)).toBe("");
  });

  it("MatchTime's own post, copied whole and pasted back, leaves nothing: 'say IN' is never the sender's IN", () => {
    for (const lang of ["en", "tr"] as const) {
      const own = buildWeekListPost({ list: LIST, matchDate: MATCH, paygPricePence: 800, lang });
      expect(pasteResidual(own, { ...ctx, lang })).toBe("");
      const organiser = buildWeekListPost({ list: LIST, matchDate: MATCH, paygPricePence: 800, organiserPicks: true, lang });
      expect(pasteResidual(organiser, { ...ctx, lang })).toBe("");
    }
  });

  it("'Can't make it' typed ABOVE the list is the sender speaking, not a header", () => {
    expect(pasteResidual("Can't make it\nList for October:\n1. Alex\n2.\n3. Chris\n\nCan't play\n1. Dave", ctx)).toBe("Can't make it");
  });

  it("what the member typed above or below the list is kept, in order", () => {
    const body = "can't make it lads, someone take my spot\nList for October:\n1. Alex\n2.\n3. Chris\nsee you next week";
    expect(pasteResidual(body, ctx)).toBe("can't make it lads, someone take my spot\nsee you next week");
  });
});

describe("review fixes: the two new messages", () => {
  it("a non-regular moved to the waiting list when the regulars are put on the match", () => {
    expect(buildSeedBumpedDm({ name: "Zed Wait", activityName: "Monday 7-a-side", matchDate: MATCH, lang: "en" })).toBe(
      "👋 Zed, the regulars who have paid for the month have their places for *Monday 7-a-side* on Mon 12 Oct, 20:00, " +
        "so you are on the waiting list for now. I'll message you if a place opens.",
    );
    expect(buildSeedBumpedDm({ name: null, activityName: "Pazartesi 7'ye 7", matchDate: MATCH, lang: "tr" })).toBe(
      "👋 *Pazartesi 7'ye 7* (12 Ekim Pazartesi 20:00) maçında yerler önce ayı ödeyen daimi oyuncuların, " +
        "bu yüzden şimdilik yedek listesindesin. Yer açılırsa sana yazarım.",
    );
  });

  it("names on a pasted list that were not added, with how to add them", () => {
    expect(buildPasteNotAddedNotice({ actorName: "Alex Carter", names: ["Tariq", "Big O"], matchDate: MATCH, lang: "en" })).toBe(
      "📋 Alex Carter pasted the list for Mon 12 Oct, 20:00 with Tariq, Big O on it. I could not match that to a player on this month's list, " +
        "so I added nobody. A player can say *IN* in the group themselves, or you can add them on the match page.",
    );
    const tr = buildPasteNotAddedNotice({ actorName: "Alex Carter", names: ["Tariq"], matchDate: MATCH, lang: "tr" });
    expect(tr).toContain("Tariq");
    expect(tr).toContain("*VARIM*");
    expect(tr).not.toMatch(/[—–]/);
  });
});
