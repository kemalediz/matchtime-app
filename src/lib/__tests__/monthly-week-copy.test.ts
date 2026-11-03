/**
 * Monthly squad, slice 5: the weekly flow's words, English and Turkish
 * (MDs/monthly-squad-plan-2026-10-05.md, 5.3, 5.4, 6.2). Made-up names.
 */
import { describe, it, expect } from "vitest";
import { buildPasteIgnoredAdminNotice, buildPasteNotAddedNotice, buildPasteSenderNotListDm, buildPasteSenderNotMatchedDm, buildSeedBumpedDm, buildPasteUndoDm, buildPaygPoolDm, buildPaygPoolGroupPost, buildWeekListPost, paygPriceLabel, weekListFirstNames } from "../monthly-week-copy";
import { pasteResidual } from "@/lib/__tests__/fixtures/monthly-legacy";
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

const TITLE = "Monday 7-a-side";

describe("buildWeekListPost (reworded 2026-11-03: the squad first, first names, no paid marks)", () => {
  it("English: header, squad by first name under real slot numbers, can't play, bench, pay as you go", () => {
    expect(buildWeekListPost({ list: LIST, matchDate: MATCH, title: TITLE, paygPricePence: 800, lang: "en" })).toBe(
      [
        "📋 *Monday 7-a-side, Mon 12 Oct at 20:00*",
        "",
        "*October squad:*",
        "1. Alex",
        "4. Jake",
        "",
        "You're all in, no need to say anything. Can't make it? Say *Out* and your place opens up.",
        "",
        "*Can't play:*",
        "1. Sam",
        "2. Chris",
        "",
        "*Bench:*",
        "1. Zed",
        "",
        "*Pay as you go:*",
        "2. Omar",
        "1 place open, £8. Say *IN* to take it.",
      ].join("\n"),
    );
  });

  it("Turkish", () => {
    expect(buildWeekListPost({ list: LIST, matchDate: MATCH, title: TITLE, paygPricePence: 750, lang: "tr" })).toBe(
      [
        "📋 *Monday 7-a-side, 12 Ekim Pazartesi 20:00*",
        "",
        "*Ekim kadrosu:*",
        "1. Alex",
        "4. Jake",
        "",
        "Hepiniz listedesiniz, bir şey yazmanıza gerek yok. Gelemeyecek olan *YOKUM* yazsın, yeri açılır.",
        "",
        "*Gelemeyenler:*",
        "1. Sam",
        "2. Chris",
        "",
        "*Yedekler:*",
        "1. Zed",
        "",
        "*Maç başı ödeyenler:*",
        "2. Omar",
        "1 yer boş, £7.50. Almak için *VARIM* yazın.",
      ].join("\n"),
    );
  });

  it("the Vets' week: thirteen regulars, one place open, exactly the approved format", () => {
    const names = ["Davide De Sousa", "Dan Archer", "Nabz", "Steff", "Craig", "Ben", "Kerem Aksoy", "Steve", "Andrew", "Jon", "Shane Walton", "Cj - Barber Lab", "Oumesh"];
    const list: WeekList = {
      slots: [
        ...names.map((name, i) => ({ slot: i + 1, userId: `u${i + 1}`, name, mark: "paid" as const })),
        { slot: 14, userId: null, name: "", mark: null },
      ],
      paidCantPlay: [],
      cantPlay: [],
      reserves: [],
      open: 1,
    };
    // Mon 9 Nov 2026, 20:30 London (GMT).
    const nov9 = new Date("2026-11-09T20:30:00.000Z");
    expect(buildWeekListPost({ list, matchDate: nov9, title: "Football 7-a-side", paygPricePence: 800, lang: "en" })).toBe(
      [
        "📋 *Football 7-a-side, Mon 9 Nov at 20:30*",
        "",
        "*November squad:*",
        "1. Davide",
        "2. Dan",
        "3. Nabz",
        "4. Steff",
        "5. Craig",
        "6. Ben",
        "7. Kerem",
        "8. Steve",
        "9. Andrew",
        "10. Jon",
        "11. Shane",
        "12. Cj",
        "13. Oumesh",
        "",
        "You're all in, no need to say anything. Can't make it? Say *Out* and your place opens up.",
        "",
        "*Pay as you go:* 1 place open, £8. Say *IN* to take it.",
      ].join("\n"),
    );
  });

  it("no paid mark and no PAYG mark anywhere, in either language", () => {
    for (const lang of ["en", "tr"] as const) {
      const text = buildWeekListPost({ list: LIST, matchDate: MATCH, title: TITLE, paygPricePence: 800, lang });
      expect(text).not.toMatch(/\((?:paid|ödedi|PAYG)\)/i);
      expect(text).not.toMatch(/Paid but|Ödedi gelemiyor/);
    }
  });

  it("open places: none (full), one, two; with and without a price", () => {
    const base: WeekList = { ...LIST, slots: LIST.slots.filter((x) => x.mark !== "payg"), paidCantPlay: [], cantPlay: [], reserves: [] };
    const last = (list: WeekList, price: number | null, lang: "en" | "tr" = "en", organiserPicks = false) =>
      buildWeekListPost({ list, matchDate: MATCH, title: TITLE, paygPricePence: price, organiserPicks, lang }).split("\n").pop();
    expect(last({ ...base, open: 0 }, 800)).toBe("The squad is full.");
    expect(last({ ...base, open: 0 }, 800, "tr")).toBe("Kadro tam.");
    expect(last({ ...base, open: 1 }, 800)).toBe("*Pay as you go:* 1 place open, £8. Say *IN* to take it.");
    expect(last({ ...base, open: 2 }, 800)).toBe("*Pay as you go:* 2 places open, £8. Say *IN* to take one.");
    expect(last({ ...base, open: 1 }, null)).toBe("*Pay as you go:* 1 place open. Say *IN* to take it.");
    expect(last({ ...base, open: 2 }, null)).toBe("*Pay as you go:* 2 places open. Say *IN* to take one.");
    expect(last({ ...base, open: 2 }, null, "tr")).toBe("*Maç başı ödeyenler:* 2 yer boş. Almak için *VARIM* yazın.");
  });

  it("an organiser-pick club keeps its own line, in the same style", () => {
    const two: WeekList = { ...LIST, paidCantPlay: [], cantPlay: [], reserves: [], open: 2 };
    expect(buildWeekListPost({ list: two, matchDate: MATCH, title: TITLE, paygPricePence: 800, organiserPicks: true, lang: "en" }).split("\n").slice(-3)).toEqual([
      "*Pay as you go:*",
      "2. Omar",
      "2 places open, £8. Say *IN* to go on the bench, and the organisers will pick who plays.",
    ]);
    const noPayg: WeekList = { ...two, slots: two.slots.filter((x) => x.mark !== "payg"), open: 1 };
    expect(buildWeekListPost({ list: noPayg, matchDate: MATCH, title: TITLE, paygPricePence: null, organiserPicks: true, lang: "tr" }).split("\n").pop()).toBe(
      "*Maç başı ödeyenler:* 1 yer boş. Yedeğe girmek için *VARIM* yazın, kimin oynayacağını organizatörler seçer.",
    );
  });

  it("pay-as-you-go players with every place taken: listed, then the squad is full", () => {
    const full: WeekList = { ...LIST, paidCantPlay: [], cantPlay: [], reserves: [], open: 0 };
    expect(buildWeekListPost({ list: full, matchDate: MATCH, title: TITLE, paygPricePence: 800, lang: "en" }).split("\n").slice(-3)).toEqual([
      "*Pay as you go:*",
      "2. Omar",
      "The squad is full.",
    ]);
  });

  it("empty sections are left out", () => {
    const text = buildWeekListPost({ list: { ...LIST, paidCantPlay: [], cantPlay: [], reserves: [] }, matchDate: MATCH, title: TITLE, paygPricePence: 800, lang: "en" });
    expect(text).not.toContain("*Can't play:*");
    expect(text).not.toContain("*Bench:*");
  });
});

describe("weekListFirstNames: first names, told apart when two share one", () => {
  const names = (people: Array<[string, string | null]>, lang: "en" | "tr" = "en") =>
    [...weekListFirstNames(people.map(([userId, name]) => ({ userId, name })), lang).values()];

  it("the first word that is a name: 'Davide De Sousa' is Davide, 'Cj - Barber Lab' is Cj", () => {
    expect(names([["a", "Davide De Sousa"], ["b", "Cj - Barber Lab"], ["c", "  Nabz  "], ["d", "⚽ Kerem Aksoy"]])).toEqual(["Davide", "Cj", "Nabz", "Kerem"]);
  });

  it("two people with one first name get a surname initial; a shared initial too, the whole name", () => {
    expect(names([["a", "Dan Archer"], ["b", "Dan Moss"], ["c", "Steve"]])).toEqual(["Dan A", "Dan M", "Steve"]);
    expect(names([["a", "dan Smith"], ["b", "Dan Smyth"]])).toEqual(["dan Smith", "Dan Smyth"]);
    // Only one of them has a surname.
    expect(names([["a", "Dan"], ["b", "Dan Moss"]])).toEqual(["Dan", "Dan M"]);
  });

  it("no usable name, or a phone number, is the club's word for unnamed, never the number", () => {
    expect(names([["a", null], ["b", ""], ["c", "+44 7700 900123"]])).toEqual(["(unnamed)", "(unnamed)", "(unnamed)"]);
    expect(names([["a", null]], "tr")).toEqual(["(isimsiz)"]);
  });

  it("across the whole post: a Dan on the bench and a Dan in the squad are told apart", () => {
    const list: WeekList = {
      slots: [{ slot: 1, userId: "a", name: "Dan Archer", mark: "paid" }],
      paidCantPlay: [],
      cantPlay: [],
      reserves: [{ userId: "b", name: "Dan Moss" }],
      open: 0,
    };
    const text = buildWeekListPost({ list, matchDate: MATCH, title: TITLE, paygPricePence: 800, lang: "en" });
    expect(text).toContain("1. Dan A\n");
    expect(text).toContain("*Bench:*\n1. Dan M");
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
        buildWeekListPost({ list: LIST, matchDate: MATCH, title: TITLE, paygPricePence: 800, lang }),
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
      for (const open of [0, 1, 2]) {
        const list = { ...LIST, open };
        const own = buildWeekListPost({ list, matchDate: MATCH, title: TITLE, paygPricePence: 800, lang });
        expect(pasteResidual(own, { ...ctx, lang }), own).toBe("");
        const organiser = buildWeekListPost({ list, matchDate: MATCH, title: TITLE, paygPricePence: 800, organiserPicks: true, lang });
        expect(pasteResidual(organiser, { ...ctx, lang }), organiser).toBe("");
        const noPayg = buildWeekListPost({ list: { ...list, slots: LIST.slots.filter((x) => x.mark !== "payg") }, matchDate: MATCH, title: TITLE, paygPricePence: null, lang });
        expect(pasteResidual(noPayg, { ...ctx, lang, paygPricePence: null }), noPayg).toBe("");
      }
    }
  });

  it("a post copied in an OLDER wording (before 2026-11-03, and before 'bench' on 2026-10-12) still leaves nothing", () => {
    // Posts in the old wording are still in the groups' histories, and a
    // member can copy one and paste it back for as long as that match is on.
    const old = [
      "📋 List for October: Mon 12 Oct, 20:00",
      "",
      "1. Alex Carter (paid)",
      "2. Omar Khan (PAYG)",
      "3.",
      "",
      "Paid but can't play",
      "1. Sam Dean",
      "",
      "Reserves",
      "1. Zed Wait",
      "",
    ];
    expect(pasteResidual([...old, "1 place open, £8 PAYG: say *IN* to take it."].join("\n"), ctx)).toBe("");
    expect(pasteResidual([...old, "1 place open. Say *IN* to go on the bench, and the organisers will pick who plays."].join("\n"), ctx)).toBe("");
    expect(pasteResidual([...old, "1 place open. Say *IN* to go on the waiting list, and the organisers will pick who plays."].join("\n"), ctx)).toBe("");
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
        "so you are on the bench for now. I'll message you if a place opens.",
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
