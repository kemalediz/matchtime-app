/**
 * Club fee billing, slice P4 (games played): the billing page's month box
 * and past months, the state lines and the banner without any flat fee
 * wording, the owner's columns and totals on /admin/clubs, and the copy
 * fixes from the P3 review (receipt wording, retries, the total owed).
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 7.3, 8.1 to 8.3.
 *
 * Pure: words from numbers. English and Turkish, no dashes.
 */
import { describe, it, expect } from "vitest";
import {
  bannerText,
  billingStateLines,
  cardAddedText,
  gameLine,
  monthBoxText,
  monthChargedText,
  ownerChargeDateLabel,
  ownerLastMonthLabel,
  ownerThisMonthLabel,
  pastMonthLine,
  pausedText,
  paymentFailedText,
  type BillingStateInput,
} from "../club-billing-view";
import { billingTotals, receiptAllowed } from "../club-billing-rules";
import { billingRetriesOn, bothRetrySourcesOn } from "../club-billing-schedule-rules";

const DASH = /[—–]/;
const LINK = "https://matchtime.ai/r/abc";
// Month 1 of a free month that ended 1 Nov 14:00 London: 1 Nov to 30 Nov.
const NOV = { startsAt: new Date("2026-11-01T14:00:00Z"), endsAt: new Date("2026-12-01T00:00:00Z") };

function state(over: Partial<BillingStateInput> = {}): BillingStateInput {
  return {
    status: "subscribed",
    plan: "standard",
    pricePence: null,
    trialEndsAt: new Date("2026-11-01T14:00:00Z"),
    graceEndsAt: null,
    currentPeriodEnd: new Date("2026-12-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
    cardBrand: "Visa",
    cardLast4: "4242",
    cardHolderUserId: "u1",
    cardHolderName: "Colin",
    viewerUserId: "u1",
    role: "contact",
    now: new Date("2026-11-20T12:00:00Z"),
    ...over,
  };
}

describe("the month box (8.1)", () => {
  it("games so far, still to come, so far and if every game is played, charge date", () => {
    expect(monthBoxText("en", { ...NOV, played: 2, scheduled: 4, upcoming: 2, pricePence: 999 })).toBe(
      "This month (1 Nov to 30 Nov): 2 of 4 games played so far, 2 still to come. So far that's £4.99; if every game still to come is played it's £9.99. Charged on Tue 1 Dec.",
    );
    expect(monthBoxText("tr", { ...NOV, played: 2, scheduled: 4, upcoming: 2, pricePence: 999 })).toBe(
      "Bu ay (1 Kasım ile 30 Kasım arası): şu ana kadar 4 maçın 2 tanesi oynandı, 2 maç daha var. Şu ana kadar £4.99; kalan tüm maçlar oynanırsa £9.99. Ödeme 1 Aralık Salı tarihinde alınır.",
    );
  });

  it("a missed week lowers the most it can be (3 of 5 with 1 to come: £5.99, at most £7.99)", () => {
    expect(monthBoxText("en", { ...NOV, played: 3, scheduled: 5, upcoming: 1, pricePence: 999 })).toContain(
      "So far that's £5.99; if every game still to come is played it's £7.99.",
    );
  });

  it("nothing still to come: the month's charge so far", () => {
    expect(monthBoxText("en", { ...NOV, played: 4, scheduled: 5, upcoming: 0, pricePence: 999 })).toBe(
      "This month (1 Nov to 30 Nov): 4 of 5 games played. That's £7.99, charged on Tue 1 Dec.",
    );
    expect(monthBoxText("tr", { ...NOV, played: 4, scheduled: 5, upcoming: 0, pricePence: 999 })).toBe(
      "Bu ay (1 Kasım ile 30 Kasım arası): 5 maçın 4 tanesi oynandı. Bu £7.99 eder, ödeme 1 Aralık Salı tarihinde alınır.",
    );
  });

  it("nothing played yet, and no games at all: nothing", () => {
    expect(monthBoxText("en", { ...NOV, played: 0, scheduled: 4, upcoming: 4, pricePence: 999 })).toContain("So far that's nothing;");
    expect(monthBoxText("en", { ...NOV, played: 0, scheduled: 0, upcoming: 0, pricePence: 999 })).toBe(
      "This month (1 Nov to 30 Nov): no games so far, so nothing to pay.",
    );
    expect(monthBoxText("tr", { ...NOV, played: 0, scheduled: 0, upcoming: 0, pricePence: 999 })).toBe(
      "Bu ay (1 Kasım ile 30 Kasım arası): şu ana kadar maç yok, bu yüzden ödenecek bir şey yok.",
    );
  });

  it("one game: singular", () => {
    expect(monthBoxText("en", { ...NOV, played: 1, scheduled: 1, upcoming: 0, pricePence: 999 })).toContain("1 of 1 game played.");
  });

  it("a Custom maximum scales the same way (3 of 4 on £5 is £3.75)", () => {
    expect(monthBoxText("en", { ...NOV, played: 3, scheduled: 4, upcoming: 0, pricePence: 500 })).toContain("That's £3.75");
  });
});

describe("past months (8.1)", () => {
  const m = (over: Record<string, unknown>) => ({ ...NOV, status: "paid", played: 4, scheduled: 5, amountPence: 799, ...over }) as Parameters<typeof pastMonthLine>[1];
  it("one line per state, en and tr", () => {
    const en = (over: Record<string, unknown>) => pastMonthLine("en", m(over));
    expect(en({})).toBe("1 Nov to 30 Nov: 4 of 5 games, £7.99 paid");
    expect(en({ status: "invoiced" })).toBe("1 Nov to 30 Nov: 4 of 5 games, £7.99 being taken");
    expect(en({ status: "failed" })).toBe("1 Nov to 30 Nov: 4 of 5 games, £7.99 not paid yet");
    expect(en({ status: "void" })).toBe("1 Nov to 30 Nov: 4 of 5 games, £7.99 cancelled, nothing to pay");
    expect(en({ status: "no-games", played: 0, amountPence: null })).toBe("1 Nov to 30 Nov: no games, nothing to pay");
    expect(en({ status: "below-minimum", played: 1, scheduled: 10, amountPence: null })).toBe("1 Nov to 30 Nov: 1 of 10 games, under 30p, so nothing to pay");
    expect(en({ status: "waived", amountPence: null })).toBe("1 Nov to 30 Nov: nothing to pay");
    expect(en({ status: "no-card", amountPence: null })).toBe("1 Nov to 30 Nov: 4 of 5 games, not charged (no card on file)");
    expect(en({ status: "closing", amountPence: null })).toBe("1 Nov to 30 Nov: being worked out");
    expect(pastMonthLine("tr", m({}))).toBe("1 Kasım ile 30 Kasım arası: 5 maçın 4 tanesi, £7.99 ödendi");
    expect(pastMonthLine("tr", m({ status: "no-games", played: 0, amountPence: null }))).toBe("1 Kasım ile 30 Kasım arası: maç yok, ödenecek bir şey yok");
  });

  it("a game's line: its day and why it was or was not played", () => {
    const at = new Date("2026-11-03T20:00:00Z");
    expect(gameLine("en", { kickoff: at, outcome: "played" })).toBe("Tue 3 Nov: played");
    expect(gameLine("en", { kickoff: at, outcome: "cancelled" })).toBe("Tue 3 Nov: cancelled");
    expect(gameLine("en", { kickoff: at, outcome: "nobody-in" })).toBe("Tue 3 Nov: nobody said IN");
    expect(gameLine("en", { kickoff: at, outcome: "paused" })).toBe("Tue 3 Nov: MatchTime was paused");
    expect(gameLine("en", { kickoff: at, outcome: "no-match" })).toBe("Tue 3 Nov: no match");
    expect(gameLine("en", { kickoff: at, outcome: "not-completed" })).toBe("Tue 3 Nov: not played");
    expect(gameLine("en", { kickoff: at, outcome: "upcoming" })).toBe("Tue 3 Nov: still to come");
    expect(gameLine("tr", { kickoff: at, outcome: "played" })).toBe("3 Kasım Salı: oynandı");
  });
});

describe("state lines: no flat fee left (8.1)", () => {
  it("trial: only the games played, up to the price", () => {
    expect(billingStateLines("en", state({ status: "trial", cardHolderUserId: null, cardLast4: null, trialEndsAt: new Date("2026-10-31T09:00:00Z") }))).toEqual([
      "Free month until Sat 31 Oct. After that you only pay for the games you play, up to £9.99 a month for the whole group.",
    ]);
    expect(billingStateLines("tr", state({ status: "trial", cardHolderUserId: null, cardLast4: null, trialEndsAt: new Date("2026-10-31T09:00:00Z") }))).toEqual([
      "Ücretsiz ay 31 Ekim Cumartesi tarihine kadar. Sonrasında yalnızca oynadığınız maçlar için ödersiniz, tüm grup için ayda en fazla £9.99.",
    ]);
  });

  it("subscribed: up to the price, the next charge, the card to its holder only", () => {
    expect(billingStateLines("en", state())).toEqual([
      "Only the games played are charged, up to £9.99 a month. Next charge Tue 1 Dec.",
      "Card Visa ending 4242.",
    ]);
    expect(billingStateLines("en", state({ role: "viewer", viewerUserId: "admin" }))).toEqual([
      "Only the games played are charged, up to £9.99 a month. Next charge Tue 1 Dec.",
    ]);
    expect(billingStateLines("tr", state())[0]).toBe("Yalnızca oynanan maçlar için ücret alınır, ayda en fazla £9.99. Sonraki ödeme 1 Aralık Salı.");
  });

  it("subscribed inside the free month: card saved, nothing taken until the first charge", () => {
    const inFree = state({ trialEndsAt: new Date("2026-11-01T14:00:00Z"), now: new Date("2026-10-20T12:00:00Z"), currentPeriodEnd: null });
    expect(billingStateLines("en", inFree)).toEqual(["Card saved. Nothing is taken until Tue 1 Dec.", "Card Visa ending 4242."]);
    expect(billingStateLines("tr", inFree)[0]).toBe("Kart kaydedildi. 1 Aralık Salı tarihine kadar hiçbir ücret alınmaz.");
    expect(billingStateLines("en", { ...inFree, cardHolderUserId: "old", cardHolderName: "Elvin" })).toEqual([
      "Paid with Elvin's card until you put yours on. Nothing is taken until Tue 1 Dec.",
    ]);
  });

  it("someone else's card, to the new contact", () => {
    expect(billingStateLines("en", state({ cardHolderUserId: "old", cardHolderName: "Elvin" }))).toEqual([
      "Paid with Elvin's card until you put yours on. Only the games played are charged, up to £9.99 a month. Next charge Tue 1 Dec.",
    ]);
  });

  it("stopping: billing ends when this month ends", () => {
    expect(billingStateLines("en", state({ cancelAtPeriodEnd: true }))).toEqual([
      "Billing ends on Tue 1 Dec, after this month is charged for its games.",
    ]);
    expect(billingStateLines("tr", state({ cancelAtPeriodEnd: true }))).toEqual([
      "Ödeme 1 Aralık Salı tarihinde, bu ay oynanan maçlar için ücret alındıktan sonra sona eriyor.",
    ]);
  });

  it("past due: the month and its amount; retrying or how to pay now", () => {
    const unpaid = { totalPence: 749, count: 1, ...NOV };
    const pd = state({ status: "past_due", graceEndsAt: new Date("2026-12-08T10:00:00Z"), unpaid });
    expect(billingStateLines("en", { ...pd, retrying: true })).toEqual([
      "The £7.49 for 1 Nov to 30 Nov didn't go through. It will be tried again over the next few days. MatchTime stops on Tue 8 Dec if it can't be taken.",
    ]);
    expect(billingStateLines("en", { ...pd, retrying: false })).toEqual([
      "The £7.49 for 1 Nov to 30 Nov didn't go through. Update the card and pay it to keep MatchTime running. MatchTime stops on Tue 8 Dec if it can't be taken.",
    ]);
    expect(billingStateLines("en", { ...pd, unpaid: { ...unpaid, totalPence: 1548, count: 2 }, retrying: true })[0]).toContain(
      "The £15.48 for 2 months of games didn't go through.",
    );
    expect(billingStateLines("tr", { ...pd, retrying: true })[0]).toBe(
      "1 Kasım ile 30 Kasım arası için £7.49 ödemesi alınamadı. Önümüzdeki birkaç gün içinde tekrar denenecek. Ödeme alınamazsa MatchTime 8 Aralık Salı tarihinde durur.",
    );
  });

  it("paused for a payment: the total owed; paused after Stop paying: Keep paying", () => {
    expect(billingStateLines("en", state({ status: "paused", pausedReason: "payment-failed", unpaid: { totalPence: 1548, count: 2, ...NOV } }))).toEqual([
      "MatchTime is paused because £15.48 for 2 months of games is unpaid. All the data is kept. Update the card and pay to switch it back on.",
    ]);
    expect(billingStateLines("en", state({ status: "paused", pausedReason: "payment-failed", unpaid: { totalPence: 749, count: 1, ...NOV } }))[0]).toContain(
      "because £7.49 is unpaid.",
    );
    expect(billingStateLines("en", state({ status: "paused", pausedReason: "cancelled" }))).toEqual([
      "Billing was stopped, so MatchTime is paused. All the data is kept. Press Keep paying to switch it back on.",
    ]);
  });

  it("no flat fee wording anywhere, every state, both languages, no dashes", () => {
    for (const lang of ["en", "tr"] as const) {
      for (const status of ["trial", "grace", "subscribed", "past_due", "paused"]) {
        for (const pausedReason of [null, "no-card", "payment-failed", "cancelled", "removed"]) {
          for (const cancelAtPeriodEnd of [false, true]) {
            const lines = billingStateLines(lang, state({ status, pausedReason, cancelAtPeriodEnd, unpaid: { totalPence: 749, count: 1, ...NOV } }));
            for (const l of lines) {
              expect(l).not.toMatch(DASH);
              expect(l).not.toMatch(/undefined|null|NaN/);
              expect(l).not.toMatch(/a month\. Next payment|Next payment|Aylık £/);
            }
          }
        }
      }
    }
  });
});

describe("banner (8.2)", () => {
  const dates = { trialEndsAt: new Date("2026-11-01T14:00:00Z"), graceEndsAt: new Date("2026-12-08T10:00:00Z") };
  it("past due names the month and its amount, never 'this month's club fee'", () => {
    expect(bannerText("en", { status: "past_due", ...dates, unpaid: { totalPence: 749, count: 1, ...NOV } })).toBe(
      "The club fee for 1 Nov to 30 Nov (£7.49) didn't go through. MatchTime stops on Tue 8 Dec if it can't be taken.",
    );
    expect(bannerText("en", { status: "past_due", ...dates, unpaid: { totalPence: 1548, count: 2, ...NOV } })).toBe(
      "£15.48 of club fees for 2 months didn't go through. MatchTime stops on Tue 8 Dec if it can't be taken.",
    );
    expect(bannerText("en", { status: "past_due", ...dates })).toBe(
      "The last club fee payment didn't go through. MatchTime stops on Tue 8 Dec if it can't be taken.",
    );
    expect(bannerText("tr", { status: "past_due", ...dates, unpaid: { totalPence: 749, count: 1, ...NOV } })).toBe(
      "1 Kasım ile 30 Kasım arası kulüp ücreti (£7.49) alınamadı. Ödeme alınamazsa MatchTime 8 Aralık Salı tarihinde durur.",
    );
  });

  it("paused for a payment or after Stop paying: says what switches it back on", () => {
    expect(bannerText("en", { status: "paused", ...dates, pausedReason: "payment-failed" })).toBe(
      "MatchTime is paused for this club because a club fee payment is unpaid. It can be paid on the billing page.",
    );
    expect(bannerText("en", { status: "paused", ...dates, pausedReason: "cancelled" })).toBe(
      "MatchTime is paused for this club because billing was stopped. Keep paying on the billing page switches it back on.",
    );
  });
});

describe("P3 review copy fixes", () => {
  const p = { name: "Colin", club: "Riverside FC", link: LINK };

  it("(1) the receipt DM says Stripe emailed the receipt only when the card is the contact's own", () => {
    const own = monthChargedText("en", { ...p, ...NOV, played: 4, scheduled: 5, amountPence: 799, pricePence: 999, last4: "4242", ownCard: true });
    expect(own).toContain("Stripe has emailed you the receipt. Details: " + LINK);
    const other = monthChargedText("en", { ...p, ...NOV, played: 3, scheduled: 4, amountPence: 749, pricePence: 999, last4: "1881", ownCard: false });
    expect(other).not.toMatch(/emailed|e-posta/i);
    expect(other).toContain("You can see the month's games and charge on your billing page: " + LINK);
    const otherTr = monthChargedText("tr", { ...p, ...NOV, played: 3, scheduled: 4, amountPence: 749, pricePence: 999, last4: "1881", ownCard: false });
    expect(otherTr).not.toMatch(/e-posta/i);
    expect(otherTr).toContain("Ayın maçlarını ve ücretini ödeme sayfanızda görebilirsiniz: " + LINK);
  });

  it("(1) card added: receipts on the billing page, no promise about Stripe's emails", () => {
    for (const lang of ["en", "tr"] as const) {
      const text = cardAddedText(lang, { ...p, pricePence: 999, firstChargeOn: new Date("2026-12-01T00:00:00Z"), first: true, resumed: false });
      expect(text).not.toMatch(/Stripe emails|e-postayla/);
    }
    expect(cardAddedText("en", { ...p, pricePence: 999, firstChargeOn: new Date("2026-12-01T00:00:00Z"), first: true, resumed: false })).toContain(
      "The first charge is on Tue 1 Dec. You can see each charge and its receipt on your billing page, and change your card or stop there: " + LINK,
    );
    expect(cardAddedText("tr", { ...p, pricePence: 999, firstChargeOn: new Date("2026-12-01T00:00:00Z"), first: false, resumed: false })).toContain(
      "Sonraki ödeme 1 Aralık Salı tarihinde. Her ödemeyi ve makbuzunu ödeme sayfanızda görebilir, kartınızı orada değiştirebilir ya da durdurabilirsiniz: " + LINK,
    );
  });

  it("(2) payment failed: 'tried again' only when retries are on; otherwise how to pay now", () => {
    const base = { ...p, ...NOV, amountPence: 749 };
    expect(paymentFailedText("en", { ...base, ownCard: true, retrying: true })).toContain("It will be tried again over the next few days, and MatchTime keeps running meanwhile. To update the card: " + LINK);
    const off = paymentFailedText("en", { ...base, ownCard: true, retrying: false });
    expect(off).not.toMatch(/tried again/);
    expect(off).toBe(
      `Hi Colin, the £7.49 for Riverside FC's games between 1 Nov and 30 Nov didn't go through. MatchTime keeps running for now. To pay it now, update the card and pay here: ${LINK}`,
    );
    expect(paymentFailedText("en", { ...base, ownCard: false, retrying: false })).toContain("To pay it now with your own card instead: " + LINK);
    const offTr = paymentFailedText("tr", { ...base, ownCard: true, retrying: false });
    expect(offTr).not.toMatch(/tekrar denenecek/);
    expect(offTr).toContain("MatchTime şimdilik çalışmaya devam ediyor. Şimdi ödemek için buradan kartı güncelleyip ödeyin: " + LINK);
  });

  it("(3) paused for a payment: the total owed across unpaid months, and how many", () => {
    expect(pausedText("en", { ...p, amountPence: 1548, unpaidMonths: 2, reason: "payment-failed" })).toContain(
      "Hi Colin, we couldn't take the £15.48 owed for 2 months of Riverside FC's games, so MatchTime is now paused.",
    );
    expect(pausedText("tr", { ...p, amountPence: 1548, unpaidMonths: 2, reason: "payment-failed" })).toContain(
      "Merhaba Colin, Riverside FC için 2 ayın maçlarına ait toplam £15.48 ödemesini alamadık, bu yüzden MatchTime şu an duraklatıldı.",
    );
    // One month: the P3 sentence, unchanged.
    expect(pausedText("en", { ...p, amountPence: 749, unpaidMonths: 1, reason: "payment-failed" })).toContain(
      "Hi Colin, we couldn't take the £7.49 for Riverside FC, so MatchTime is now paused.",
    );
  });

  it("billingRetriesOn: 'it will be tried again' only when a retry source is EXPLICITLY on (review L2)", () => {
    // Unset: nothing claims a retry (the dashboard setting is not known here).
    expect(billingRetriesOn({})).toBe(false);
    expect(billingRetriesOn({ BILLING_STRIPE_RETRIES: "" })).toBe(false);
    expect(billingRetriesOn({ BILLING_STRIPE_RETRIES: "1" })).toBe(true);
    expect(billingRetriesOn({ BILLING_STRIPE_RETRIES: "on" })).toBe(true);
    expect(billingRetriesOn({ BILLING_STRIPE_RETRIES: "0" })).toBe(false);
    expect(billingRetriesOn({ BILLING_CRON_RETRIES: "1" })).toBe(true);
    expect(billingRetriesOn({ BILLING_STRIPE_RETRIES: "0", BILLING_CRON_RETRIES: "0" })).toBe(false);
  });

  it("bothRetrySourcesOn: true only when BOTH are explicitly on", () => {
    expect(bothRetrySourcesOn({ BILLING_STRIPE_RETRIES: "1", BILLING_CRON_RETRIES: "1" })).toBe(true);
    expect(bothRetrySourcesOn({ BILLING_STRIPE_RETRIES: "1" })).toBe(false);
    expect(bothRetrySourcesOn({ BILLING_CRON_RETRIES: "1" })).toBe(false);
  });
});

describe("receipts on the billing page", () => {
  const invoicedAt = new Date("2026-12-01T10:05:00Z");
  it("only the billing contact, only their own card, only months invoiced since that card went on", () => {
    expect(receiptAllowed({ role: "contact", ownCard: true, status: "paid", hasInvoice: true, invoicedAt, cardSince: new Date("2026-10-20T10:00:00Z") })).toBe(true);
    expect(receiptAllowed({ role: "contact", ownCard: true, status: "paid", hasInvoice: true, invoicedAt, cardSince: null })).toBe(true);
    // Invoiced while an earlier collector paid: their address is on that invoice.
    expect(receiptAllowed({ role: "contact", ownCard: true, status: "paid", hasInvoice: true, invoicedAt, cardSince: new Date("2026-12-05T10:00:00Z") })).toBe(false);
    expect(receiptAllowed({ role: "contact", ownCard: false, status: "paid", hasInvoice: true, invoicedAt, cardSince: null })).toBe(false);
    expect(receiptAllowed({ role: "viewer", ownCard: true, status: "paid", hasInvoice: true, invoicedAt, cardSince: null })).toBe(false);
    expect(receiptAllowed({ role: "contact", ownCard: true, status: "failed", hasInvoice: true, invoicedAt: null, cardSince: null })).toBe(false);
    expect(receiptAllowed({ role: "contact", ownCard: true, status: "paid", hasInvoice: false, invoicedAt, cardSince: null })).toBe(false);
  });
});

describe("/admin/clubs: the next charge date (test mode: it showed 'Next charge Thu 1 Oct, 00:00')", () => {
  // A month ends at 00:00 London (BST here, 23:00 UTC the day before); its
  // charge runs that day from 10:00 London.
  it("the London DAY the month ends, and 'from 10:00', never 00:00 or the UTC day before", () => {
    const endsAt = new Date("2026-09-30T23:00:00Z"); // 00:00 BST on Thu 1 Oct
    expect(ownerChargeDateLabel(endsAt)).toBe("Thu 1 Oct, from 10:00");
    expect(ownerChargeDateLabel(new Date("2026-12-01T00:00:00Z"))).toBe("Tue 1 Dec, from 10:00"); // GMT
  });
});

describe("/admin/clubs (8.3): this month so far, last month, totals", () => {
  it("this month so far and last month, per club", () => {
    expect(ownerThisMonthLabel({ played: 2, scheduled: 5, amountPence: 399 })).toBe("2 of 5 so far, £3.99");
    expect(ownerThisMonthLabel({ played: 0, scheduled: 4, amountPence: 0 })).toBe("0 of 4 so far, nothing yet");
    expect(ownerThisMonthLabel(null)).toBe("no month open");
    expect(ownerLastMonthLabel({ status: "paid", amountPence: 749 })).toBe("£7.49 paid");
    expect(ownerLastMonthLabel({ status: "no-games", amountPence: null })).toBe("no games");
    expect(ownerLastMonthLabel({ status: "failed", amountPence: 749 })).toBe("£7.49 failed");
    expect(ownerLastMonthLabel({ status: "invoiced", amountPence: 749 })).toBe("£7.49 being taken");
    expect(ownerLastMonthLabel({ status: "waived", amountPence: null })).toBe("waived");
    expect(ownerLastMonthLabel({ status: "no-card", amountPence: null })).toBe("not charged, no card");
    expect(ownerLastMonthLabel(null)).toBe("none yet");
  });

  it("totals: with a card, charged last month, this month so far, failed or unpaid, VAT country checks", () => {
    const t = billingTotals([
      { status: "subscribed", cardOnFile: true, vatCheck: false, thisMonthPence: 399, lastMonth: { status: "paid", amountPence: 749 }, unpaidPence: 0 },
      { status: "past_due", cardOnFile: true, vatCheck: true, thisMonthPence: 0, lastMonth: { status: "failed", amountPence: 999 }, unpaidPence: 999 },
      { status: "trial", cardOnFile: false, vatCheck: false, thisMonthPence: null, lastMonth: null, unpaidPence: 0 },
      { status: "paused", cardOnFile: false, vatCheck: false, thisMonthPence: null, lastMonth: { status: "no-games", amountPence: null }, unpaidPence: 0 },
      { status: "grace", cardOnFile: false, vatCheck: false, thisMonthPence: 200, lastMonth: null, unpaidPence: 0 },
    ]);
    expect(t).toEqual({
      withCard: 2,
      lastMonthChargedPence: 749,
      thisMonthPence: 599,
      unpaidClubs: 1,
      unpaidPence: 999,
      vatCheck: 1,
      trial: 1,
      grace: 1,
      pastDue: 1,
      paused: 1,
    });
  });
});

describe("the month summary reads only, and knows the card session marker", () => {
  it("CARD_SESSION_MARKER is the type club-billing-stripe.ts writes", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const stripeSrc = readFileSync(path.resolve(__dirname, "../club-billing-stripe.ts"), "utf8");
    const summarySrc = readFileSync(path.resolve(__dirname, "../club-billing-month-summary.ts"), "utf8");
    const written = /CARD_SESSION_EVENT_TYPE = "([^"]+)"/.exec(stripeSrc)?.[1];
    const read = /CARD_SESSION_MARKER = "([^"]+)"/.exec(summarySrc)?.[1];
    expect(written).toBe("mt.card-session");
    expect(read).toBe(written);
    // Never a write: no create, update, upsert or delete on any model.
    expect(summarySrc).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  });
});
