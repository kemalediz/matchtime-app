/**
 * CLUB FEE BILLING, slice P3: every billing DM in the games-played model,
 * in English and Turkish (plan 7.2, 7.3). PURE: the words from the numbers.
 *
 *   - new: the month-charged receipt, the first-zero-month "nothing to
 *     pay", Keep paying (undo, and start again after a stop);
 *   - rewritten: nothing describes a flat monthly fee or a first charge
 *     "taken on" a date any more; card added, day 21, 28, 30, paused,
 *     payment failed and the bank check (3DS) name the MONTH and its
 *     AMOUNT; payer changed and billed again say "only the games played,
 *     up to {price} a month"; the club fee tip gives the per game maximum.
 *
 * House rules for every string: no em or en dash, no time-of-day greeting,
 * the club named.
 *
 * Fixture month: the free month ends Sun 1 Nov 2026 14:00 London, so
 * month 1 is 1 Nov to 30 Nov, charged on Tue 1 Dec.
 */
import { describe, expect, it } from "vitest";
import { clubFeeTip, type ClubFeeTip, type TipActivity } from "../club-billing-rules";
import {
  approvedTipText,
  cardAddedText,
  clubFeeTipText,
  keepPayingText,
  monthChargedText,
  monthFreeText,
  paymentActionText,
  paymentFailedText,
  pausedText,
  payerChangedText,
  planBilledText,
  trialEndedText,
  trialReminderText,
} from "../club-billing-view";

const LINK = "https://matchtime.ai/r/abc";
const HOSTED = "https://invoice.stripe.com/i/x";
const TRIAL_END = new Date("2026-11-01T14:00:00Z"); // Sun 1 Nov 14:00 London
const M1 = { startsAt: TRIAL_END, endsAt: new Date("2026-12-01T00:00:00Z") };
const GRACE = new Date("2026-11-08T14:00:00Z");
const DEC1 = new Date("2026-12-01T00:00:00Z");

const act = (over: Partial<TipActivity> = {}): TipActivity => ({
  dayOfWeek: 2,
  time: "20:00",
  playersPerTeam: 5,
  feePerPlayer: null,
  feeSplitTotal: false,
  latestMatchFee: null,
  ...over,
});
const tipFor = (over: Partial<TipActivity> = {}, plan = "standard", pricePence: number | null = null, extra: TipActivity[] = []): ClubFeeTip =>
  clubFeeTip({ status: "trial", plan, pricePence, activities: [act(over), ...extra] })!;

function all(lang: "en" | "tr"): Record<string, string> {
  const base = { name: "Cole", club: "Riverside FC" };
  return {
    charged: monthChargedText(lang, { ...base, ...M1, played: 4, scheduled: 5, amountPence: 799, pricePence: 999, last4: "4242", ownCard: true, link: LINK }),
    chargedAll: monthChargedText(lang, { ...base, ...M1, played: 4, scheduled: 4, amountPence: 999, pricePence: 999, last4: "4242", ownCard: true, link: LINK }),
    chargedOther: monthChargedText(lang, { ...base, ...M1, played: 3, scheduled: 4, amountPence: 749, pricePence: 999, last4: "1881", ownCard: false, link: LINK }),
    chargedNoLast4: monthChargedText(lang, { ...base, ...M1, played: 3, scheduled: 4, amountPence: 749, pricePence: 999, last4: null, ownCard: true, link: LINK }),
    free: monthFreeText(lang, { ...base, ...M1 }),
    keep: keepPayingText(lang, { ...base, pricePence: 999, nextChargeOn: DEC1, restarted: false, link: LINK }),
    keepRestart: keepPayingText(lang, { ...base, pricePence: 999, nextChargeOn: DEC1, restarted: true, link: LINK }),
    cardAdded: cardAddedText(lang, { ...base, pricePence: 999, firstChargeOn: DEC1, first: true, resumed: false, link: LINK }),
    cardAddedNext: cardAddedText(lang, { ...base, pricePence: 999, firstChargeOn: DEC1, first: false, resumed: true, link: LINK }),
    d21: trialReminderText(lang, { kind: "trial-21", ...base, trialEndsAt: TRIAL_END, pricePence: 999, link: LINK, via: "collector", tip: tipFor() }),
    d28: trialReminderText(lang, { kind: "trial-28", ...base, trialEndsAt: TRIAL_END, pricePence: 999, link: LINK, via: "collector", tip: null }),
    d30: trialEndedText(lang, { ...base, graceEndsAt: GRACE, pricePence: 999, link: LINK, via: "collector" }),
    pausedNoCard: pausedText(lang, { ...base, amountPence: 999, reason: "no-card", link: LINK }),
    pausedPayment: pausedText(lang, { ...base, amountPence: 749, reason: "payment-failed", link: LINK }),
    pausedCancelled: pausedText(lang, { ...base, amountPence: 999, reason: "cancelled", link: LINK }),
    failed: paymentFailedText(lang, { ...base, ...M1, amountPence: 749, link: LINK, ownCard: true, retrying: true }),
    failedOther: paymentFailedText(lang, { ...base, ...M1, amountPence: 749, link: LINK, ownCard: false, retrying: true }),
    action: paymentActionText(lang, { ...base, ...M1, amountPence: 749, link: HOSTED, ownCard: true, billingLink: LINK }),
    actionOther: paymentActionText(lang, { ...base, ...M1, amountPence: 749, link: HOSTED, ownCard: false, billingLink: LINK }),
    payerCard: payerChangedText(lang, { name: "Pat", club: "Riverside FC", pricePence: 999, link: LINK, state: "card", oldName: "Cole", date: null, tip: null }),
    payerNoCard: payerChangedText(lang, { name: "Pat", club: "Riverside FC", pricePence: 999, link: LINK, state: "no-card", oldName: null, date: TRIAL_END, tip: null }),
    payerPaused: payerChangedText(lang, { name: "Pat", club: "Riverside FC", pricePence: 500, link: LINK, state: "paused", oldName: null, date: null, tip: null }),
    payerRemoved: payerChangedText(lang, { name: "Pat", club: "Riverside FC", pricePence: 999, link: LINK, state: "removed", oldName: null, date: null, tip: null }),
    planBilled: planBilledText(lang, { ...base, pricePence: 999, graceEndsAt: GRACE, link: LINK }),
    tip: clubFeeTipText(lang, tipFor()),
    approvedTip: approvedTipText(lang, tipFor()),
  };
}

describe("slice P3 copy: house rules, both languages", () => {
  for (const lang of ["en", "tr"] as const) {
    it(`${lang}: no em or en dash, no time-of-day greeting, the club named, no flat monthly fee, no first charge "taken on" a date`, () => {
      for (const [k, text] of Object.entries(all(lang))) {
        expect(text, k).not.toMatch(/[–—]/);
        expect(text, k).not.toMatch(/good (morning|afternoon|evening)|günaydın|iyi akşamlar/i);
        if (!k.endsWith("ip")) expect(text, k).toContain("Riverside FC");
        // The flat fee wordings of B3 and B4, gone.
        expect(text, k).not.toMatch(/(it's|MatchTime's|again at) £[\d.]+ a month|is taken on|taken today|then monthly|this month's|aylık £|bu ayın|tarihinde, sonra her ay/i);
      }
    });
  }
});

describe("the month-charged receipt (7.3), to the billing contact", () => {
  it("en: Kemal's 4 of 5 example, the card on file, VAT, the full month price, the link last", () => {
    expect(all("en").charged).toBe(
      "Hi Cole, Riverside FC played 4 of 5 games between 1 Nov and 30 Nov, so £7.99 was charged to your card ending 4242 " +
        `(VAT included; a full month is £9.99). Stripe has emailed you the receipt. Details: ${LINK}`,
    );
  });
  it("en: every game played says so; somebody else's card and no known last four are worded for it", () => {
    const en = all("en");
    expect(en.chargedAll).toContain("Riverside FC played all 4 games between 1 Nov and 30 Nov, so £9.99 was charged to your card ending 4242");
    expect(en.chargedOther).toContain("so £7.49 was charged to the card on file ending 1881");
    expect(en.chargedNoLast4).toContain("so £7.49 was charged to your card (VAT included");
  });
  it("tr: the same numbers, Turkish dates", () => {
    const tr = all("tr");
    expect(tr.charged).toBe(
      "Merhaba Cole, Riverside FC 1 Kasım ile 30 Kasım arasında 5 maçın 4 tanesini oynadı, bu yüzden 4242 ile biten kartınızdan £7.99 çekildi " +
        `(KDV dahil; tam ay £9.99). Makbuzu Stripe size e-postayla gönderdi. Ayrıntılar: ${LINK}`,
    );
    expect(tr.chargedAll).toContain("Riverside FC 1 Kasım ile 30 Kasım arasındaki 4 maçın hepsini oynadı, bu yüzden");
    expect(tr.chargedOther).toContain("1881 ile biten kayıtlı karttan £7.49 çekildi");
  });
  it("one game of one is singular", () => {
    expect(monthChargedText("en", { name: "Cole", club: "Riverside FC", ...M1, played: 1, scheduled: 1, amountPence: 999, pricePence: 999, last4: "4242", ownCard: true, link: LINK })).toContain(
      "played 1 of 1 game between",
    );
  });
});

describe("the first zero month (7.3)", () => {
  it("en and tr, exactly as the plan words them", () => {
    expect(all("en").free).toBe(
      "Hi Cole, Riverside FC played no games between 1 Nov and 30 Nov, so there is nothing to pay for that month. MatchTime only charges for the games you play.",
    );
    expect(all("tr").free).toBe(
      "Merhaba Cole, Riverside FC 1 Kasım ile 30 Kasım arasında hiç maç oynamadı, bu yüzden o ay için ödenecek bir şey yok. MatchTime yalnızca oynadığınız maçlar için ücret alır.",
    );
  });
});

describe("Keep paying", () => {
  it("en: Stop paying undone: billing carries on, the next charge date, the link", () => {
    expect(all("en").keep).toBe(
      "Hi Cole, done: MatchTime keeps running in the Riverside FC WhatsApp group and billing carries on. " +
        "As before, each month is charged only for the games played, up to £9.99, the morning after it ends; the next charge is on Tue 1 Dec. " +
        `To change your card or stop: ${LINK}`,
    );
  });
  it("en: started again after a stop: back on, say IN again", () => {
    expect(all("en").keepRestart).toContain("MatchTime is back on for Riverside FC and picks things up again in the group within a few minutes. Anyone who said IN while it was paused should say it again.");
  });
  it("tr", () => {
    expect(all("tr").keep).toContain("Merhaba Cole, tamam: MatchTime Riverside FC WhatsApp grubunda çalışmaya devam ediyor ve ödeme sürüyor.");
    expect(all("tr").keep).toContain("sonraki ödeme 1 Aralık Salı tarihinde.");
    expect(all("tr").keepRestart).toContain("Duraklatılmışken VARIM yazanlar lütfen tekrar yazsın.");
  });
});

describe("rewritten DMs", () => {
  it("card added: nothing taken, charged only for the games played, the first charge date (plan 7.3)", () => {
    expect(all("en").cardAdded).toBe(
      "Thanks Cole, your card is saved. MatchTime keeps running in the Riverside FC WhatsApp group. " +
        "Nothing has been taken: after each month I count the games played and charge only for those, up to £9.99. " +
        `The first charge is on Tue 1 Dec. You can see each charge and its receipt on your billing page, and change your card or stop there: ${LINK}`,
    );
    expect(all("en").cardAddedNext).toContain("MatchTime is back on for Riverside FC");
    expect(all("en").cardAddedNext).toContain("The next charge is on Tue 1 Dec");
    expect(all("tr").cardAdded).toContain("Şu an hiçbir ücret alınmadı: her ayın sonunda oynanan maçları sayıyorum ve yalnızca onlar için, en fazla £9.99 alıyorum. İlk ödeme 1 Aralık Salı tarihinde.");
    expect(all("tr").cardAddedNext).toContain("Sonraki ödeme 1 Aralık Salı tarihinde.");
  });

  it("day 21: the games-played sentence and the first charge (the morning after month 1 ends), then the tip", () => {
    expect(all("en").d21).toContain(
      `add a card here: ${LINK}\nAfter that you only pay for the games you play, up to £9.99 a month for the whole group, charged after each month ends. ` +
        "Nothing is taken when you add the card; the first charge is on Tue 1 Dec.",
    );
    expect(all("en").d21).toContain("💷 *Club fee tip:*");
    expect(all("tr").d21).toContain(
      "Sonrasında yalnızca oynadığınız maçlar için ödersiniz, tüm grup için ayda en fazla £9.99, her ay bittikten sonra alınır. Kartı eklediğinizde hiçbir ücret alınmaz; ilk ödeme 1 Aralık Salı tarihinde.",
    );
  });

  it("day 28 and day 30: say how it is charged", () => {
    expect(all("en").d28).toContain("a quick reminder: Riverside FC's free month ends on Sun 1 Nov.");
    expect(all("en").d28).toContain("You only pay for the games you play, up to £9.99 a month, and nothing is taken when you add the card.");
    expect(all("en").d30).toContain("until Sun 8 Nov. Add a card any time before then:");
    expect(all("en").d30).toContain("You only pay for the games you play, up to £9.99 a month, charged after each month ends.");
    expect(all("tr").d28).toContain("Yalnızca oynadığınız maçlar için ödersiniz, ayda en fazla £9.99; kartı eklediğinizde hiçbir ücret alınmaz.");
    expect(all("tr").d30).toContain("Yalnızca oynadığınız maçlar için ödersiniz, ayda en fazla £9.99, her ay bittikten sonra alınır.");
  });

  it("paused: the month's amount; the cancelled wording; each says how to switch it back on", () => {
    const en = all("en");
    expect(en.pausedPayment.startsWith("Hi Cole, we couldn't take the £7.49 for Riverside FC, so MatchTime is now paused.")).toBe(true);
    expect(en.pausedPayment).toContain(`update the card and pay here, and it restarts within a few minutes: ${LINK}`);
    expect(en.pausedCancelled.startsWith(
      "Hi Cole, you stopped paying for MatchTime for Riverside FC, so it is now paused. The last month was charged only for the games played, as usual.",
    )).toBe(true);
    expect(en.pausedCancelled).toContain(`press Keep paying here and it restarts within a few minutes: ${LINK}`);
    expect(en.pausedNoCard).toContain(`add a card here and it restarts within a few minutes: ${LINK}`);
    expect(all("tr").pausedPayment).toContain("Riverside FC için £7.49 ödemesini alamadık");
    expect(all("tr").pausedCancelled).toContain("Riverside FC için MatchTime ödemesini durdurdunuz, bu yüzden şu an duraklatıldı.");
  });

  it("payment failed and the bank check: the amount for the month's games, never 'this month's'", () => {
    const en = all("en");
    expect(en.failed).toBe(
      "Hi Cole, the £7.49 for Riverside FC's games between 1 Nov and 30 Nov didn't go through. " +
        `It will be tried again over the next few days, and MatchTime keeps running meanwhile. To update the card: ${LINK}`,
    );
    expect(en.failedOther.endsWith(`To put your own card on instead: ${LINK}`)).toBe(true);
    expect(en.action).toBe(
      `Hi Cole, your bank wants you to confirm the £7.49 for Riverside FC's games between 1 Nov and 30 Nov before it can go through. Please confirm it here: ${HOSTED}\nMatchTime keeps running meanwhile.`,
    );
    expect(en.actionOther).toContain(`the card on file for Riverside FC needs the bank to confirm the £7.49 for the games between 1 Nov and 30 Nov before it can go through. You can confirm and pay it here: ${HOSTED}\nOr put your own card on instead: ${LINK}`);
    expect(all("tr").failed).toContain("Riverside FC için 1 Kasım ile 30 Kasım arasındaki maçların £7.49 ödemesi alınamadı.");
    expect(all("tr").action).toContain("Riverside FC için 1 Kasım ile 30 Kasım arasındaki maçların £7.49 ödemesinin geçebilmesi için bankanız onayınızı istiyor.");
  });

  it("payer changed and billed again: only the games played, up to the price", () => {
    const en = all("en");
    for (const k of ["payerCard", "payerNoCard", "payerRemoved"]) {
      expect(en[k], k).toContain(
        "Hi Pat, you're now the money collector for Riverside FC, so you look after MatchTime's club fee for the Riverside FC WhatsApp group: only the games played, up to £9.99 a month.",
      );
    }
    expect(en.payerPaused).toContain("only the games played, up to £5 a month. Add a card to switch it back on:");
    expect(en.payerCard).toContain("Cole's card keeps paying until you put yours on, whenever suits you:");
    expect(en.planBilled.startsWith("Hi Cole, Riverside FC is on the MatchTime plan again: only the games played, up to £9.99 a month.")).toBe(true);
    expect(all("tr").payerCard).toContain("Riverside FC WhatsApp grubu için MatchTime kulüp ücretiyle siz ilgileniyorsunuz: yalnızca oynanan maçlar, ayda en fazla £9.99.");
    expect(all("tr").planBilled).toContain("Riverside FC yeniden MatchTime planında: yalnızca oynanan maçlar, ayda en fazla £9.99.");
  });
});

describe("the club fee tip (7.2): the per game maximum", () => {
  it("perGamePence: the monthly price over the month's games, up to the penny", () => {
    expect(tipFor().perGamePence).toBe(250); // 999 / 4 = 249.75
    expect(tipFor({}, "custom", 500).perGamePence).toBe(125);
    // Two weekly games: 8 a month.
    expect(tipFor({}, "standard", null, [act({ dayOfWeek: 4 })]).perGamePence).toBe(125); // 999 / 8 = 124.875
  });

  it("en: exactly as the plan words it", () => {
    expect(all("en").tip).toBe(
      "💷 *Club fee tip:* MatchTime only charges for the games you play, up to £9.99 a month. " +
        "Each game played costs the club at most £2.50, which is about *25p a player per game* for your 10 players. " +
        "If your game costs £8 each, charge *£8.25* and the club fee is covered. Weeks you don't play cost nothing.",
    );
    expect(clubFeeTipText("en", tipFor({ playersPerTeam: 7, feePerPlayer: 7 }))).toContain("Your game is £7 each, so charging *£7.20* covers it. Weeks you don't play cost nothing.");
    expect(clubFeeTipText("en", tipFor({ feeSplitTotal: true }))).toContain("When you split the pitch cost, add about 25p to each player's share.");
  });

  it("tr: exactly as the plan words it", () => {
    expect(all("tr").tip).toBe(
      "💷 *Kulüp ücreti ipucu:* MatchTime yalnızca oynadığınız maçlar için ücret alır, ayda en fazla £9.99. " +
        "Oynanan her maç kulübe en fazla £2.50 tutar; bu da 10 oyuncunuz için *oyuncu başına maç başına yaklaşık 25p* eder. " +
        "Maç ücreti kişi başı £8 ise *£8.25* alın, kulüp ücreti karşılanmış olur. Oynamadığınız haftalar için hiçbir şey ödemezsiniz.",
    );
  });

  it("the 'you're live' tip (sj_dm_approved_tip)", () => {
    expect(all("en").approvedTip).toBe(
      "💷 *Club fee tip:* after that MatchTime only charges for the games you play, up to £9.99 a month for the group, paid by card by whoever collects the match fees. " +
        "Each game played costs at most £2.50, about *25p a player per game* with 10 players, so a £8 game could be charged at *£8.25*.",
    );
    expect(all("tr").approvedTip).toBe(
      "💷 *Kulüp ücreti ipucu:* sonrasında MatchTime yalnızca oynadığınız maçlar için ücret alır, grup için ayda en fazla £9.99; ücreti maç ücretlerini toplayan kişi kartla öder. " +
        "Oynanan her maç en fazla £2.50 tutar, 10 oyuncuyla *oyuncu başına maç başına yaklaşık 25p* eder; £8 olan bir maç için *£8.25* alabilirsiniz.",
    );
  });
});
