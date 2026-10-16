/**
 * THE CLUB'S PAYMENT INSTRUCTIONS, FOR WEEKLY MATCH FEES (Kemal, 2026-10-16).
 *
 * `Organisation.paymentInstructions` was written for the monthly squad
 * only. FNF collects weekly match fees with card and bank off and "pay
 * the collector directly" on, and the collector's bank details lived only
 * in the WhatsApp group description. The same field now reaches a weekly
 * player wherever paying the collector directly is offered: the /pay
 * page, the pay link DM and the daily chase. Shown verbatim, one short
 * line in the DMs, and only when direct is actually available.
 */
import { describe, it, expect } from "vitest";
import { directPayInstructions, type PayMethodSwitches } from "../payments";
import { buildPayChaseDm, buildPayLinkDm } from "../dm-copy";
import { settingInfo } from "../settings-info";

const FNF: PayMethodSwitches = { payMethodPayByBank: false, payMethodCard: false, payMethodDirect: true, stripeChargesEnabled: false };
const CARD_ONLY: PayMethodSwitches = { payMethodPayByBank: false, payMethodCard: true, payMethodDirect: false, stripeChargesEnabled: true };
const TEXT = "Sort code 12-34-56, account 12345678.\nReference: your name";

const link = (methods: ("pay_by_bank" | "card" | "direct")[], lang: "en" | "tr", instructions: string | null) =>
  buildPayLinkDm({
    playerName: "Sait Demir",
    activityName: "Friday 7-a-side",
    fee: 8,
    url: "https://mt.example/s/pay",
    methods,
    collectorName: "Raihan Ahmed",
    instructions,
    lang,
  });
const chase = (methods: ("pay_by_bank" | "card" | "direct")[], lang: "en" | "tr", instructions: string | null) =>
  buildPayChaseDm({
    playerName: "Sait Demir",
    dayNum: 1,
    fee: 8,
    activityName: "Friday 7-a-side",
    url: "https://mt.example/s/pay",
    methods,
    collectorName: "Raihan Ahmed",
    instructions,
    lang,
  });

describe("directPayInstructions: the instructions, only where direct is offered", () => {
  it("direct available and text set: the trimmed text, verbatim", () => {
    expect(directPayInstructions({ ...FNF, paymentInstructions: `  ${TEXT}  ` })).toBe(TEXT);
  });
  it("direct not available: nothing, whatever the text", () => {
    expect(directPayInstructions({ ...CARD_ONLY, paymentInstructions: TEXT })).toBeNull();
  });
  it("a monthly club: nothing, its PAYG pay links stay as they were", () => {
    expect(directPayInstructions({ ...FNF, squadMode: "monthly", paymentInstructions: TEXT })).toBeNull();
    expect(directPayInstructions({ ...FNF, squadMode: "weekly", paymentInstructions: TEXT })).toBe(TEXT);
  });
  it("not set, blank or missing: nothing", () => {
    expect(directPayInstructions({ ...FNF, paymentInstructions: null })).toBeNull();
    expect(directPayInstructions({ ...FNF, paymentInstructions: "   " })).toBeNull();
    expect(directPayInstructions(FNF)).toBeNull();
  });
});

describe("the pay link DM carries one short line when set and direct is available", () => {
  it("English, FNF", () => {
    expect(link(["direct"], "en", TEXT)).toBe(
      "💷 Sait, match fee for *Friday 7-a-side* is *£8*.\n\n" +
        "Pay Raihan directly, by cash or transfer. Tap to see what you owe and tell me once you've paid:\n" +
        "https://mt.example/s/pay\n\n" +
        `How to pay Raihan: ${TEXT}\n\n` +
        "You can also pay for anyone you brought along.",
    );
  });
  it("Turkish, FNF", () => {
    expect(link(["direct"], "tr", TEXT)).toBe(
      "💷 Sait, *Friday 7-a-side* için maç ücreti *£8*.\n\n" +
        "Ödemeyi doğrudan Raihan ile, nakit ya da havaleyle hallediyorsun. Ne kadar ödeyeceğini görmek ve ödeyince bana haber vermek için dokun:\n" +
        "https://mt.example/s/pay\n\n" +
        `Ödeme bilgisi: ${TEXT}\n\n` +
        "Getirdiğin misafirlerin ücretini de birlikte ödeyebilirsin.",
    );
  });
  it("all three methods: the line is there too (direct is one of them)", () => {
    expect(link(["pay_by_bank", "card", "direct"], "en", TEXT)).toContain(`\n\nHow to pay Raihan: ${TEXT}\n\n`);
  });
  it("no line when not set, or when direct is not offered", () => {
    for (const lang of ["en", "tr"] as const) {
      const without = link(["direct"], lang, null);
      expect(link(["direct"], lang, "  ")).toBe(without);
      expect(without).not.toMatch(/How to pay|Ödeme bilgisi/);
      expect(link(["card"], lang, TEXT)).not.toContain("Sort code");
    }
  });
  it("no collector on record: 'the organiser'", () => {
    const out = buildPayLinkDm({
      playerName: "Sait Demir",
      activityName: "Friday 7-a-side",
      fee: 8,
      url: "https://mt.example/s/pay",
      methods: ["direct"],
      collectorName: null,
      instructions: TEXT,
      lang: "en",
    });
    expect(out).toContain(`How to pay the organiser: ${TEXT}`);
  });
});

describe("the daily chase carries the same line", () => {
  it("English and Turkish, FNF", () => {
    expect(chase(["direct"], "en", TEXT)).toBe(
      "💷 Quick one Sait: your *£8* for *Friday 7-a-side* is still outstanding.\n\n" +
        "Pay Raihan directly, then tap here to tell me you've paid:\nhttps://mt.example/s/pay\n\n" +
        `How to pay Raihan: ${TEXT}`,
    );
    expect(chase(["direct"], "tr", TEXT)).toBe(
      "💷 Sait, kısa bir not: *Friday 7-a-side* için *£8* ödemen hâlâ açık.\n\n" +
        "Doğrudan Raihan ile ödeyebilirsin, ödeyince buradan bana haber ver:\nhttps://mt.example/s/pay\n\n" +
        `Ödeme bilgisi: ${TEXT}`,
    );
  });
  it("no line when not set, or when direct is not offered", () => {
    for (const lang of ["en", "tr"] as const) {
      expect(chase(["direct"], lang, null)).not.toMatch(/How to pay|Ödeme bilgisi/);
      expect(chase(["card"], lang, TEXT)).not.toContain("Sort code");
    }
  });
});

describe("the info popup says where the instructions show", () => {
  const joined = (lang: "en" | "tr") => {
    const i = settingInfo(lang, "paymentInstructions");
    return [...i.what, ...(i.together ?? [])].join(" ");
  };
  it("English: monthly as before, plus the weekly pay page, pay link and reminder", () => {
    const en = joined("en");
    expect(en).not.toContain("Only used with a monthly squad");
    expect(en).toContain("in the month's list");
    expect(en).toMatch(/pay page/);
    expect(en).toMatch(/pay link/);
    expect(en).toMatch(/pay .*directly/);
  });
  it("Turkish: the same", () => {
    const tr = joined("tr");
    expect(tr).not.toContain("Yalnızca aylık kadroda kullanılır");
    expect(tr).toContain("ayın listesinde");
    expect(tr).toMatch(/ödeme sayfası/);
    expect(tr).toMatch(/ödeme linki/);
    expect(tr).toMatch(/doğrudan/);
  });
});
