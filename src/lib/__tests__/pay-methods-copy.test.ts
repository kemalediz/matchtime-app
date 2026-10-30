/**
 * THE PAY COPY NAMES ONLY THE WAYS A PLAYER CAN ACTUALLY PAY (FNF, 2026-10-16).
 *
 * FNF's pay link at 22:45 said "Tap to pay (bank, card, Apple or Google
 * Pay, or pay the organiser directly)". FNF has card and Pay by Bank
 * switched off and no Stripe account connected, so the page the link
 * opened offered one button: pay the collector directly. The DM promised
 * three ways that did not exist.
 *
 * The availability is decided ONCE, by `availablePayMethods`, which the
 * /pay page renders its buttons from. The pay link, the daily chase and
 * the collector's "links sent" ack are written from the same list, and
 * name the money collector instead of "the organiser" where known.
 */
import { describe, it, expect } from "vitest";
import { availablePayMethods, priceMethods, type PayMethodSwitches } from "../payments";
import { buildFeeReleasedAck, buildPayChaseDm, buildPayLinkDm } from "../dm-copy";
import { buildHowToUseMe } from "../onboarding-conversation";
import { runCollectorFeeReply } from "../payment-flow";

const FNF: PayMethodSwitches = {
  payMethodPayByBank: false,
  payMethodCard: false,
  payMethodDirect: true,
  stripeChargesEnabled: false,
};
const ALL_LIVE: PayMethodSwitches = {
  payMethodPayByBank: true,
  payMethodCard: true,
  payMethodDirect: true,
  stripeChargesEnabled: true,
};
/** Card and bank switched on, but the collector's Stripe account is not
 *  connected or cannot take charges yet. */
const NOT_CONNECTED: PayMethodSwitches = { ...ALL_LIVE, stripeChargesEnabled: false };

const link = (methods: ReturnType<typeof availablePayMethods>, lang: "en" | "tr", collectorName: string | null = "Raihan Ahmed") =>
  buildPayLinkDm({ playerName: "Sait Demir", activityName: "Friday 7-a-side", fee: 8, url: "https://mt.example/s/pay", methods, collectorName, lang });
const chase = (methods: ReturnType<typeof availablePayMethods>, lang: "en" | "tr", collectorName: string | null = "Raihan Ahmed") =>
  buildPayChaseDm({ playerName: "Sait Demir", dayNum: 1, fee: 8, activityName: "Friday 7-a-side", url: "https://mt.example/s/pay", methods, collectorName, lang });
const ack = (methods: ReturnType<typeof availablePayMethods>, lang: "en" | "tr") =>
  buildFeeReleasedAck({ released: 12, fee: 8, matchName: "Friday 7-a-side", methods, lang });

describe("availablePayMethods: the one rule the pay page and every DM share", () => {
  it("direct only (FNF): card and bank off, nothing connected", () => {
    expect(availablePayMethods(FNF)).toEqual(["direct"]);
  });
  it("everything on and the collector's Stripe account can take charges", () => {
    expect(availablePayMethods(ALL_LIVE)).toEqual(["pay_by_bank", "card", "direct"]);
  });
  it("card and bank on but Stripe not connected: only direct", () => {
    expect(availablePayMethods(NOT_CONNECTED)).toEqual(["direct"]);
  });
  it("card only, bank only, and nothing at all", () => {
    expect(availablePayMethods({ ...ALL_LIVE, payMethodPayByBank: false, payMethodDirect: false })).toEqual(["card"]);
    expect(availablePayMethods({ ...ALL_LIVE, payMethodCard: false, payMethodDirect: false })).toEqual(["pay_by_bank"]);
    expect(availablePayMethods({ ...NOT_CONNECTED, payMethodDirect: false })).toEqual([]);
  });
});

describe("the pay page's direct button names the collector", () => {
  it("'Pay Raihan directly' when known, the old label otherwise", () => {
    expect(priceMethods(8, ["direct"], "Raihan").map((p) => p.label)).toEqual(["Pay Raihan directly"]);
    expect(priceMethods(8, ["direct"]).map((p) => p.label)).toEqual(["Pay the collector directly"]);
    expect(priceMethods(8, ["pay_by_bank", "card"], "Raihan").map((p) => p.label)).toEqual([
      "Pay by Bank",
      "Card, Apple or Google Pay",
    ]);
  });
});

describe("the pay link DM", () => {
  it("FNF, English: no card, bank or Apple Pay; names Raihan; reads naturally", () => {
    const out = link(availablePayMethods(FNF), "en");
    expect(out).toBe(
      "💷 Sait, match fee for *Friday 7-a-side* is *£8*.\n\n" +
        "Pay Raihan directly, by cash or transfer. Tap to see what you owe and tell me once you've paid:\n" +
        "https://mt.example/s/pay\n\n" +
        "You can also pay for anyone you brought along.",
    );
    expect(out).not.toMatch(/card|bank|Apple|Google|organiser/i);
  });

  it("FNF, Turkish: no card, bank or Apple Pay; names Raihan", () => {
    const out = link(availablePayMethods(FNF), "tr");
    expect(out).toBe(
      "💷 Sait, *Friday 7-a-side* için maç ücreti *£8*.\n\n" +
        "Ödemeyi doğrudan Raihan ile, nakit ya da havaleyle hallediyorsun. Ne kadar ödeyeceğini görmek ve ödeyince bana haber vermek için dokun:\n" +
        "https://mt.example/s/pay\n\n" +
        "Getirdiğin misafirlerin ücretini de birlikte ödeyebilirsin.",
    );
    expect(out).not.toMatch(/kart|banka|Apple|Google|organizatör/i);
  });

  it("card + bank + direct with charges enabled, English: all three, Raihan named", () => {
    expect(link(availablePayMethods(ALL_LIVE), "en")).toBe(
      "💷 Sait, match fee for *Friday 7-a-side* is *£8*.\n\n" +
        "Tap to pay (bank, card, Apple or Google Pay, or pay Raihan directly):\n" +
        "https://mt.example/s/pay\n\n" +
        "You can also pay for anyone you brought along.",
    );
  });

  it("card + bank + direct with charges enabled, Turkish", () => {
    expect(link(availablePayMethods(ALL_LIVE), "tr")).toBe(
      "💷 Sait, *Friday 7-a-side* için maç ücreti *£8*.\n\n" +
        "Ödemek için dokun (banka, kart, Apple ya da Google Pay, ya da doğrudan Raihan ile):\n" +
        "https://mt.example/s/pay\n\n" +
        "Getirdiğin misafirlerin ücretini de buradan ödeyebilirsin.",
    );
  });

  it("card and bank switched on but Stripe not connected: the same as direct only", () => {
    for (const lang of ["en", "tr"] as const) {
      expect(link(availablePayMethods(NOT_CONNECTED), lang)).toBe(link(availablePayMethods(FNF), lang));
    }
  });

  it("no collector on record: 'the organiser', as before", () => {
    expect(link(["pay_by_bank", "card", "direct"], "en", null)).toContain(
      "Tap to pay (bank, card, Apple or Google Pay, or pay the organiser directly):",
    );
    expect(link(["pay_by_bank", "card", "direct"], "tr", null)).toContain(
      "Ödemek için dokun (banka, kart, Apple ya da Google Pay, ya da doğrudan organizatöre):",
    );
    expect(link(["direct"], "en", null)).toContain("Pay the organiser directly, by cash or transfer.");
    expect(link(["direct"], "tr", null)).toContain("Ödemeyi doğrudan organizatör ile,");
  });

  it("card only and bank only list just that one", () => {
    expect(link(["card"], "en")).toContain("Tap to pay (card, Apple or Google Pay):\n");
    expect(link(["pay_by_bank"], "en")).toContain("Tap to pay by bank:\n");
    expect(link(["pay_by_bank", "direct"], "en")).toContain("Tap to pay (bank, or pay Raihan directly):\n");
    expect(link(["card"], "tr")).toContain("Ödemek için dokun (kart, Apple ya da Google Pay):\n");
    expect(link(["pay_by_bank"], "tr")).toContain("Bankayla ödemek için dokun:\n");
  });

  it("nothing available: claims no method and no guest payments", () => {
    const en = link([], "en");
    expect(en).toContain("Tap to see what you owe:\n");
    expect(en).not.toMatch(/card|bank|directly|brought along/i);
    const tr = link([], "tr");
    expect(tr).toContain("Ne kadar ödeyeceğini görmek için dokun:\n");
    expect(tr).not.toMatch(/kart|banka|doğrudan|misafir/i);
  });
});

describe("the daily pay chase", () => {
  it("FNF: direct only, Raihan named, EN and TR", () => {
    const en = chase(availablePayMethods(FNF), "en");
    expect(en).toBe(
      "💷 Quick one Sait: your *£8* for *Friday 7-a-side* is still outstanding.\n\n" +
        "Pay Raihan directly, then tap here to tell me you've paid:\nhttps://mt.example/s/pay",
    );
    const tr = chase(availablePayMethods(FNF), "tr");
    expect(tr).toBe(
      "💷 Sait, kısa bir not: *Friday 7-a-side* için *£8* ödemen hâlâ açık.\n\n" +
        "Doğrudan Raihan ile ödeyebilirsin, ödeyince buradan bana haber ver:\nhttps://mt.example/s/pay",
    );
    expect(en).not.toMatch(/card|bank|Apple/i);
    expect(tr).not.toMatch(/kart|banka|Apple/i);
  });

  it("everything live: all three, Raihan named, EN and TR", () => {
    expect(chase(availablePayMethods(ALL_LIVE), "en")).toContain(
      "Pay by bank, card, Apple or Google Pay, or pay Raihan directly:\n",
    );
    expect(chase(availablePayMethods(ALL_LIVE), "tr")).toContain(
      "Bankayla, kartla, Apple ya da Google Pay ile veya doğrudan Raihan ile ödeyebilirsin:\n",
    );
  });

  it("Stripe not connected reads as direct only", () => {
    for (const lang of ["en", "tr"] as const) {
      expect(chase(availablePayMethods(NOT_CONNECTED), lang)).toBe(chase(availablePayMethods(FNF), lang));
    }
  });

  it("no collector name: the old Turkish wording, 'the organiser' in English", () => {
    expect(chase(["pay_by_bank", "card", "direct"], "en", null)).toContain(
      "Pay by bank, card, Apple or Google Pay, or pay the organiser directly:\n",
    );
    expect(chase(["pay_by_bank", "card", "direct"], "tr", null)).toContain(
      "Bankayla, kartla, Apple ya da Google Pay ile veya doğrudan organizatöre ödeyebilirsin:\n",
    );
  });

  it("card only and bank only", () => {
    expect(chase(["card"], "en")).toContain("Pay by card, Apple or Google Pay:\n");
    expect(chase(["pay_by_bank"], "en")).toContain("Pay by bank:\n");
    expect(chase(["card"], "tr")).toContain("Kartla, Apple ya da Google Pay ile ödeyebilirsin:\n");
    expect(chase(["pay_by_bank"], "tr")).toContain("Bankayla ödeyebilirsin:\n");
  });
});

describe("the collector's 'links sent' ack", () => {
  it("FNF: says players pay the collector directly, no card or bank", () => {
    const en = ack(availablePayMethods(FNF), "en");
    expect(en).toBe(
      "✅ Done, sent 12 pay links at *£8* each for *Friday 7-a-side*. " +
        "Players pay you directly, and I'll let you know when someone says they have. I'll chase anyone who hasn't paid.",
    );
    const tr = ack(availablePayMethods(FNF), "tr");
    expect(tr).toBe(
      "✅ Tamam, *Friday 7-a-side* için kişi başı *£8* üzerinden 12 ödeme linki gönderdim. " +
        "Oyuncular doğrudan sana ödeyecek, ödediğini söyleyen olursa sana haber veririm. Ödemeyenlere ben hatırlatırım.",
    );
  });

  it("everything live: unchanged from before", () => {
    expect(ack(availablePayMethods(ALL_LIVE), "en")).toContain(
      "Players can pay by bank, card, Apple or Google Pay, or settle with you directly. I'll chase",
    );
    expect(ack(availablePayMethods(ALL_LIVE), "tr")).toContain(
      "Oyuncular bankayla, kartla, Apple ya da Google Pay ile veya doğrudan sana ödeyebilir. Ödemeyenlere",
    );
  });

  it("Stripe not connected reads as direct only", () => {
    for (const lang of ["en", "tr"] as const) {
      expect(ack(availablePayMethods(NOT_CONNECTED), lang)).toBe(ack(availablePayMethods(FNF), lang));
    }
  });

  it("the collector fee flow passes the match's methods to the ack", async () => {
    const r = await runCollectorFeeReply("✅", {
      pendingMatch: async () => ({ id: "m1", name: "Friday 7-a-side", feePendingConfirm: 8, payMethods: ["direct"] }),
      headcount: async () => 12,
      judge: async () => ({ intent: "yes", amount: null, amountIs: null, confidence: 0.95, reasoning: "stub" }),
      release: async () => 12,
      cancel: async () => {},
      stage: async () => {},
    });
    expect(r?.released).toBe(12);
    expect(r?.reply).toBe(ack(["direct"], "en"));
  });
});

describe("the help line does not promise card or bank to a club that may not take them", () => {
  const features = {
    attendance: true,
    teamBalancing: false,
    momVoting: false,
    playerRating: false,
    statsQa: false,
    reminders: false,
    bench: false,
    paymentTracking: false,
    paymentCollection: true,
  };
  it("English", () => {
    const out = buildHowToUseMe(features, "en");
    expect(out).toContain("💷 After each game I'll DM you a link to pay your match fee.");
    expect(out).not.toMatch(/Apple|Google Pay/);
  });
  it("Turkish", () => {
    const out = buildHowToUseMe(features, "tr");
    expect(out).toContain("💷 Her maçtan sonra size özelden maç ücreti için bir ödeme bağlantısı gönderirim.");
    expect(out).not.toMatch(/Apple|Google Pay/);
  });
});
