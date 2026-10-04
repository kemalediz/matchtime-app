/**
 * Club fee billing, slice B4: every DM the scheduler and the webhook send,
 * in English and Turkish (plan 7.3). Reworded for games played in slice P3
 * (its exact copy: club-billing-p3-copy.test.ts). No em or en dashes in either
 * language, no time-of-day greeting, the link last where the plan puts it,
 * and the "set a money collector" line only when the owner is asked.
 */
import { describe, expect, it } from "vitest";
import type { ClubFeeTip } from "../club-billing-rules";
import {
  cardAddedText,
  feeTipAdminText,
  paymentActionText,
  paymentFailedText,
  pausedText,
  payerChangedText,
  trialEndedText,
  trialReminderText,
} from "../club-billing-view";

const TIP: ClubFeeTip = { pricePence: 999, perSide: 7, players: 14, games: 4, perGamePence: 250, sharePence: 20, feePence: 700, feePlusPence: 720, feeSource: "own", split: false };
const M1 = { startsAt: new Date("2026-11-01T14:00:00Z"), endsAt: new Date("2026-12-01T00:00:00Z") };
const LINK = "https://matchtime.ai/r/abc";
const END = new Date("2026-10-31T09:00:00Z");
const GRACE = new Date("2026-11-07T09:00:00Z");

function all(lang: "en" | "tr"): Record<string, string> {
  return {
    d21collector: trialReminderText(lang, { kind: "trial-21", name: "Cole", club: "Riverside FC", trialEndsAt: END, pricePence: 999, link: LINK, via: "collector", tip: TIP }),
    d21owner: trialReminderText(lang, { kind: "trial-21", name: "Owen", club: "Riverside FC", trialEndsAt: END, pricePence: 999, link: LINK, via: "owner", tip: TIP }),
    d28: trialReminderText(lang, { kind: "trial-28", name: "Cole", club: "Riverside FC", trialEndsAt: END, pricePence: 999, link: LINK, via: "collector", tip: null }),
    d28tip: trialReminderText(lang, { kind: "trial-28", name: "Owen", club: "Riverside FC", trialEndsAt: END, pricePence: 999, link: LINK, via: "owner", tip: TIP }),
    d30: trialEndedText(lang, { name: "Owen", club: "Riverside FC", graceEndsAt: GRACE, pricePence: 999, link: LINK, via: "owner" }),
    pausedNoCard: pausedText(lang, { name: "Cole", club: "Riverside FC", amountPence: 999, reason: "no-card", link: LINK }),
    pausedPayment: pausedText(lang, { name: "Cole", club: "Riverside FC", amountPence: 999, reason: "payment-failed", link: LINK }),
    pausedCancelled: pausedText(lang, { name: "Cole", club: "Riverside FC", amountPence: 999, reason: "cancelled", link: LINK }),
    failedOwn: paymentFailedText(lang, { name: "Cole", club: "Riverside FC", amountPence: 999, ...M1, link: LINK, ownCard: true, retrying: true }),
    failedOther: paymentFailedText(lang, { name: "Cole", club: "Riverside FC", amountPence: 999, ...M1, link: LINK, ownCard: false, retrying: true }),
    action: paymentActionText(lang, { name: "Cole", club: "Riverside FC", amountPence: 999, ...M1, link: "https://invoice.stripe.com/i/x", ownCard: true, billingLink: LINK }),
    actionOther: paymentActionText(lang, { name: "Cole", club: "Riverside FC", amountPence: 999, ...M1, link: "https://invoice.stripe.com/i/x", ownCard: false, billingLink: LINK }),
    payerCard: payerChangedText(lang, { name: "Pat", club: "Riverside FC", pricePence: 999, link: LINK, state: "card", oldName: "Cole", date: null, tip: TIP }),
    payerNoCard: payerChangedText(lang, { name: "Pat", club: "Riverside FC", pricePence: 999, link: LINK, state: "no-card", oldName: null, date: END, tip: TIP }),
    payerPaused: payerChangedText(lang, { name: "Pat", club: "Riverside FC", pricePence: 500, link: LINK, state: "paused", oldName: null, date: null, tip: null }),
    cardAdded: cardAddedText(lang, { name: "Cole", club: "Riverside FC", pricePence: 999, firstChargeOn: END, first: true, resumed: false, link: LINK }),
    payerRemoved: payerChangedText(lang, { name: "Pat", club: "Riverside FC", pricePence: 999, link: LINK, state: "removed", oldName: null, date: null, tip: null }),
    adminTip: feeTipAdminText(lang, TIP, { noCollector: false, link: "" }),
    adminTipNoCollector: feeTipAdminText(lang, TIP, { noCollector: true, link: LINK }),
  };
}

describe("slice B4 copy", () => {
  for (const lang of ["en", "tr"] as const) {
    it(`${lang}: no em or en dash, no time-of-day greeting, every DM names the club`, () => {
      for (const [k, text] of Object.entries(all(lang))) {
        expect(text, k).not.toMatch(/[–—]/);
        expect(text, k).not.toMatch(/good (morning|afternoon|evening)|günaydın|iyi akşamlar/i);
        if (!k.startsWith("adminTip")) expect(text, k).toContain("Riverside FC");
        if (lang === "en") expect(text, k).not.toContain("Riverside FC's WhatsApp group");
      }
    });
  }

  it("English, exactly as the plan words it (7.3), with the group named as the {club} WhatsApp group", () => {
    const en = all("en");
    expect(en.d21collector).toBe(
      "Hi Cole, Riverside FC's free month on MatchTime ends on Sat 31 Oct. As the person who collects the match fees, you're the one I'll ask for the card. " +
        `To keep MatchTime running in the Riverside FC WhatsApp group, add a card here: ${LINK}\n` +
        "After that you only pay for the games you play, up to £9.99 a month for the whole group, charged after each month ends. " +
        "Nothing is taken when you add the card; the first charge is on Mon 30 Nov.\n\n" +
        "💷 *Club fee tip:* MatchTime only charges for the games you play, up to £9.99 a month. Each game played costs the club at most £2.50, " +
        "which is about *20p a player per game* for your 14 players. Your game is £7 each, so charging *£7.20* covers it. Weeks you don't play cost nothing.",
    );
    expect(en.cardAdded).toContain("MatchTime keeps running in the Riverside FC WhatsApp group.");
    expect(en.d21owner).not.toContain("As the person who collects");
    expect(en.d21owner.endsWith("Tip: if someone else collects the match fees, make them the money collector in Settings and they'll look after the card instead.")).toBe(true);
    expect(en.d28).not.toContain("Club fee tip");
    expect(en.d28tip).toContain("Club fee tip");
    expect(en.d30).toContain("until Sat 7 Nov. Add a card any time before then:");
    expect(en.d30).toContain("make them the money collector");
    expect(en.pausedNoCard.startsWith("Hi Cole, MatchTime is now paused for Riverside FC. I'm still in")).toBe(true);
    expect(en.pausedPayment.startsWith("Hi Cole, we couldn't take the £9.99 for Riverside FC, so MatchTime is now paused.")).toBe(true);
    expect(en.pausedCancelled.startsWith("Hi Cole, you stopped paying for MatchTime for Riverside FC, so it is now paused.")).toBe(true);
    expect(en.failedOwn.endsWith(`To update the card: ${LINK}`)).toBe(true);
    expect(en.failedOther.endsWith(`To put your own card on instead: ${LINK}`)).toBe(true);
    expect(en.payerCard).toContain("Cole's card keeps paying until you put yours on, whenever suits you:");
    expect(en.payerNoCard).toContain("Add a card before Sat 31 Oct to keep it running:");
    expect(en.payerPaused).toContain("only the games played, up to £5 a month. Add a card to switch it back on:");
    expect(en.adminTip).not.toContain("Nobody is set");
    expect(en.adminTipNoCollector).toContain(`Nobody is set as the money collector yet. Choose one in Settings: they'll look after the card for the club fee and get this tip too. ${LINK}`);
  });

  it("Turkish: Turkish dates and the plan's wording", () => {
    const tr = all("tr");
    expect(tr.d21collector).toContain("Merhaba Cole, Riverside FC için MatchTime'daki ücretsiz ay 31 Ekim Cumartesi tarihinde bitiyor. Maç ücretlerini siz topladığınız için kartı sizden istiyorum.");
    expect(tr.d21collector).toContain("Kulüp ücreti ipucu");
    expect(tr.d21owner).toContain("İpucu: maç ücretlerini başka biri topluyorsa, Ayarlar'dan onu para toplayan kişi yapın, kartla o ilgilensin.");
    expect(tr.d30).toContain("7 Kasım Cumartesi tarihine kadar");
    expect(tr.pausedPayment).toContain("Riverside FC için £9.99 ödemesini alamadık");
    expect(tr.failedOther).toContain("Bunun yerine kendi kartınızı eklemek için:");
    expect(tr.payerCard).toContain("Cole kişisinin kartından ödenmeye devam ediyor");
    expect(tr.actionOther).toContain("Bunun yerine kendi kartınızı ekleyin:");
    expect(tr.adminTipNoCollector).toContain("Henüz para toplayan kişi seçilmedi.");
  });
});
