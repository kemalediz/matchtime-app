/**
 * CLUB FEE BILLING, slice B2: the words on the billing page, the settings
 * card, the banner and the "you're live" DM's tip, EN and TR.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 7.2 and 8.
 *
 * Pure: no database, no model. House rules checked on every string: no em
 * or en dashes, nothing about how players pay, no claim that MatchTime
 * collects the club fee.
 */
import { describe, expect, it } from "vitest";
import { clubFeeTip, type ClubFeeTip, type TipActivity } from "@/lib/club-billing-rules";
import {
  approvedTipText,
  bannerText,
  billingCardView,
  billingPageView,
  type BillingViewClub,
  billingButtons,
  billingNoticeText,
  billingStateLines,
  clubFeeTipText,
  moneyLabel,
  shareLabel,
  type BillingStateInput,
} from "@/lib/club-billing-view";
import { t } from "@/lib/i18n/t";

const DASH = /[—–]/;
const COLLECTS = /(collects?|charges?) the (club|monthly) fee (for you|automatically)|automatically (collect|split|charge)/i;

function act(over: Partial<TipActivity> = {}): TipActivity {
  return { dayOfWeek: 2, time: "20:00", playersPerTeam: 5, feePerPlayer: null, feeSplitTotal: false, latestMatchFee: null, ...over };
}
function tipFor(over: Partial<TipActivity> = {}, plan = "standard", pricePence: number | null = null): ClubFeeTip {
  const tip = clubFeeTip({ status: "trial", plan, pricePence, activities: [act(over)] });
  if (!tip) throw new Error("no tip");
  return tip;
}

describe("money labels", () => {
  it("prices and fees in pounds, shares in pence under GBP 1", () => {
    expect(moneyLabel(999)).toBe("£9.99");
    expect(moneyLabel(500)).toBe("£5");
    expect(moneyLabel(825)).toBe("£8.25");
    expect(moneyLabel(720)).toBe("£7.20");
    expect(shareLabel(25)).toBe("25p");
    expect(shareLabel(5)).toBe("5p");
    expect(shareLabel(105)).toBe("£1.05");
    expect(shareLabel(100)).toBe("£1.00");
  });
});

describe("clubFeeTipText (7.2)", () => {
  it("en, 5-a-side with no fee of its own: the plan's worked example, word for word", () => {
    expect(clubFeeTipText("en", tipFor())).toBe(
      "💷 *Club fee tip:* your weekly 5-a-side is 10 players and about 4 games a month, so £9.99 works out at about " +
        "*25p a player per game*. If your game costs £8 each, charge *£8.25* and the club fee is covered.",
    );
  });

  it("en, 7-a-side with its own GBP 7 fee: 20p and GBP 7.20", () => {
    expect(clubFeeTipText("en", tipFor({ playersPerTeam: 7, feePerPlayer: 7 }))).toBe(
      "💷 *Club fee tip:* your weekly 7-a-side is 14 players and about 4 games a month, so £9.99 works out at about " +
        "*20p a player per game*. Your game is £7 each, so charging *£7.20* covers it.",
    );
  });

  it("en, the latest match fee counts as the club's own", () => {
    expect(clubFeeTipText("en", tipFor({ playersPerTeam: 9, latestMatchFee: 6 }))).toContain(
      "Your game is £6 each, so charging *£6.15* covers it.",
    );
  });

  it("en, a club that splits the pitch cost", () => {
    expect(clubFeeTipText("en", tipFor({ feeSplitTotal: true }))).toContain(
      "When you split the pitch cost, add about 25p to each player's share.",
    );
  });

  it("en, a Custom GBP 5 plan", () => {
    expect(clubFeeTipText("en", tipFor({}, "custom", 500))).toContain("so £5 works out at about *15p a player per game*");
  });

  it("tr: the plan's Turkish, with the Turkish per-side form", () => {
    expect(clubFeeTipText("tr", tipFor())).toBe(
      "💷 *Kulüp ücreti ipucu:* haftalık 5'e 5 maçınız 10 oyunculu ve ayda yaklaşık 4 maç oynanıyor, yani £9.99 oyuncu " +
        "başına maç başına yaklaşık *25p* ediyor. Maç ücreti kişi başı £8 ise *£8.25* alın, kulüp ücreti karşılanmış olur.",
    );
    expect(clubFeeTipText("tr", tipFor({ playersPerTeam: 7, feePerPlayer: 7 }))).toContain(
      "haftalık 7'ye 7 maçınız 14 oyunculu",
    );
    expect(clubFeeTipText("tr", tipFor({ playersPerTeam: 7, feePerPlayer: 7 }))).toContain(
      "Maç ücretiniz kişi başı £7, *£7.20* alırsanız karşılanır.",
    );
    expect(clubFeeTipText("tr", tipFor({ feeSplitTotal: true }))).toContain(
      "Saha ücretini bölüştürürken her oyuncunun payına yaklaşık 25p ekleyin.",
    );
  });

  it("every variant: no dashes, no card wording, never claims MatchTime collects the fee", () => {
    for (const lang of ["en", "tr"] as const) {
      for (const tip of [tipFor(), tipFor({ feePerPlayer: 7 }), tipFor({ feeSplitTotal: true }), tipFor({}, "custom", 500)]) {
        const s = clubFeeTipText(lang, tip);
        expect(s).not.toMatch(DASH);
        expect(s).not.toMatch(/card|kart/i);
        expect(s).not.toMatch(COLLECTS);
      }
    }
  });
});

describe("sj_dm_approved with the tip (billed clubs only)", () => {
  const LINKS = { scheduleUrl: "https://x/s", ratingsUrl: "https://x/r", settingsUrl: "https://x/t" };

  it("en: the tip FOLLOWS the free-month sentence, with the club's own numbers", () => {
    const tip = approvedTipText("en", tipFor());
    expect(tip).toBe(
      "💷 *Club fee tip:* after that it's £9.99 a month for the group, paid by card by whoever collects the match fees. " +
        "With 10 players and about 4 games a month, that's about *25p a player per game*, so a £8 game could be charged at *£8.25*.",
    );
    const dm = t("en").sj_dm_approved({ club: "Riverside FC", group: "Riverside Tuesday 5s", ...LINKS, tip });
    expect(dm.endsWith(`Your first month is free.\n\n${tip}`)).toBe(true);
    expect(dm).not.toMatch(DASH);
    expect(dm).not.toMatch(COLLECTS);
  });

  it("tr: the same, in Turkish", () => {
    const tip = approvedTipText("tr", tipFor());
    expect(tip).toBe(
      "💷 *Kulüp ücreti ipucu:* sonrasında grup için aylık £9.99, maç ücretlerini toplayan kişi kartla öder. " +
        "10 oyuncu ve ayda yaklaşık 4 maçla bu, oyuncu başına maç başına yaklaşık *25p* ediyor; £8 olan bir maç için *£8.25* alabilirsiniz.",
    );
    const dm = t("tr").sj_dm_approved({ club: "Kartallar", group: null, ...LINKS, tip });
    expect(dm.endsWith(`İlk ayınız ücretsiz.\n\n${tip}`)).toBe(true);
    expect(dm).not.toMatch(DASH);
  });

  it("the split wording", () => {
    expect(approvedTipText("en", tipFor({ feeSplitTotal: true }))).toContain(
      "*25p a player per game*, to add to each player's share of the pitch cost.",
    );
    expect(approvedTipText("tr", tipFor({ feeSplitTotal: true }))).toContain(
      "saha ücretini bölüştürürken her oyuncunun payına ekleyebilirsiniz.",
    );
  });

  it("no tip (billing off, Free, exempt): exactly today's DM, ending on the free sentence, no amount", () => {
    for (const [lang, free] of [["en", "Your first month is free."], ["tr", "İlk ayınız ücretsiz."]] as const) {
      const today = t(lang).sj_dm_approved({ club: "Riverside FC", group: "G", ...LINKS });
      for (const tip of [null, undefined, ""]) {
        expect(t(lang).sj_dm_approved({ club: "Riverside FC", group: "G", ...LINKS, tip })).toBe(today);
      }
      expect(today.endsWith(free)).toBe(true);
      expect(today).not.toMatch(/£|\d+[.,]\d\d/);
    }
  });
});

const TRIAL_END = new Date("2026-10-31T09:00:00Z");
const GRACE_END = new Date("2026-11-07T09:00:00Z");
const PERIOD_END = new Date("2026-12-01T09:00:00Z");

function state(over: Partial<BillingStateInput> = {}): BillingStateInput {
  return {
    status: "trial",
    plan: "standard",
    pricePence: null,
    trialEndsAt: TRIAL_END,
    graceEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    cardBrand: null,
    cardLast4: null,
    cardHolderUserId: null,
    cardHolderName: null,
    viewerUserId: "u1",
    role: "contact",
    ...over,
  };
}

describe("billingStateLines (8.1)", () => {
  it("trial", () => {
    expect(billingStateLines("en", state())).toEqual(["Free month until Sat 31 Oct. Then £9.99 a month for the whole group."]);
    expect(billingStateLines("tr", state())).toEqual(["Ücretsiz ay 31 Ekim Cumartesi tarihine kadar. Sonrasında tüm grup için aylık £9.99."]);
    expect(billingStateLines("en", state({ plan: "custom", pricePence: 500 }))[0]).toContain("Then £5 a month");
  });

  it("grace and past due name the stop date; paused says the data is kept", () => {
    expect(billingStateLines("en", state({ status: "grace", graceEndsAt: GRACE_END }))).toEqual([
      "The free month has ended. MatchTime stops on Sat 7 Nov unless a card is added.",
    ]);
    // A grace with no stored end falls back to the trial end + 7 days.
    expect(billingStateLines("en", state({ status: "grace" }))[0]).toContain("Sat 7 Nov");
    expect(billingStateLines("en", state({ status: "past_due", graceEndsAt: GRACE_END }))[0]).toBe(
      "Last payment didn't go through. Stripe is retrying. MatchTime stops on Sat 7 Nov if it can't be taken.",
    );
    expect(billingStateLines("en", state({ status: "paused" }))).toEqual([
      "MatchTime is paused. All the data is kept. Add a card to switch it back on.",
    ]);
  });

  it("subscribed, own card: price, next payment and the card (only to its holder)", () => {
    const own = state({
      status: "subscribed",
      currentPeriodEnd: PERIOD_END,
      cardBrand: "Visa",
      cardLast4: "4242",
      cardHolderUserId: "u1",
      cardHolderName: "Colin",
    });
    expect(billingStateLines("en", own)).toEqual(["£9.99 a month. Next payment Tue 1 Dec.", "Card Visa ending 4242."]);
    // An admin who reads only never sees the brand and last four.
    expect(billingStateLines("en", { ...own, role: "viewer", viewerUserId: "admin" })).toEqual([
      "£9.99 a month. Next payment Tue 1 Dec.",
    ]);
  });

  it("subscribed, someone else's card, to the new contact", () => {
    expect(
      billingStateLines(
        "en",
        state({ status: "subscribed", currentPeriodEnd: PERIOD_END, cardHolderUserId: "old", cardHolderName: "Elvin" }),
      ),
    ).toEqual(["£9.99 a month, paid with Elvin's card until you put yours on. Next payment Tue 1 Dec."]);
  });

  it("subscribed and cancelled: Ends on", () => {
    expect(
      billingStateLines("en", state({ status: "subscribed", currentPeriodEnd: PERIOD_END, cancelAtPeriodEnd: true, cardHolderUserId: "u1" })),
    ).toEqual(["£9.99 a month. Ends on Tue 1 Dec."]);
  });

  it("every line, every state, both languages: no dashes, no undefined or null", () => {
    for (const lang of ["en", "tr"] as const) {
      for (const status of ["trial", "grace", "subscribed", "past_due", "paused"]) {
        for (const role of ["contact", "card-holder", "viewer"] as const) {
          for (const s of billingStateLines(lang, state({ status, role, graceEndsAt: GRACE_END, currentPeriodEnd: PERIOD_END }))) {
            expect(s).not.toMatch(DASH);
            expect(s).not.toMatch(/undefined|null|NaN/);
          }
        }
      }
    }
  });
});

describe("billingButtons (8.1): which card buttons the page shows", () => {
  it("the contact: Add a card before a card is on", () => {
    for (const status of ["trial", "grace", "paused"]) expect(billingButtons(state({ status }))).toEqual(["add-card"]);
  });

  it("the contact with their own card AND the dedicated Portal configured: change or cancel", () => {
    expect(billingButtons(state({ status: "subscribed", cardHolderUserId: "u1", subscriptionStatus: "active", portalAvailable: true }))).toEqual(["change-card"]);
  });

  it("review fix 4: no Portal configuration, or no card of their own on file (null holder): setup mode, never the Portal", () => {
    expect(billingButtons(state({ status: "subscribed", cardHolderUserId: "u1", subscriptionStatus: "active", portalAvailable: false }))).toEqual(["use-mine"]);
    expect(billingButtons(state({ status: "subscribed", cardHolderUserId: null, subscriptionStatus: "active", portalAvailable: true }))).toEqual(["use-mine"]);
  });

  it("the contact with someone else's card: use mine", () => {
    expect(billingButtons(state({ status: "subscribed", cardHolderUserId: "old", subscriptionStatus: "active", portalAvailable: true }))).toEqual(["use-mine"]);
  });

  it("review fix 2: an UNPAID subscription always shows 'Update card and pay' (setup mode, open invoice retried)", () => {
    for (const [status, sub] of [
      ["past_due", "past_due"],
      ["past_due", "unpaid"],
      ["paused", "past_due"],
      ["paused", "unpaid"],
      ["grace", "incomplete"],
    ] as const) {
      for (const holder of ["u1", "old", null]) {
        expect(billingButtons(state({ status, subscriptionStatus: sub, cardHolderUserId: holder, portalAvailable: true })), `${status}/${sub}/${holder}`).toEqual(["update-card"]);
      }
    }
    expect(t("en").billing_btn_update_card).toBe("Update card and pay");
    expect(t("tr").billing_btn_update_card).toBe("Kartı güncelle ve öde");
  });

  it("paused or grace with no live subscription: Add a card", () => {
    for (const sub of [null, "canceled", "incomplete_expired"]) {
      expect(billingButtons(state({ status: "paused", subscriptionStatus: sub }))).toEqual(["add-card"]);
    }
  });

  it("an old card holder: remove mine, nothing else", () => {
    expect(billingButtons(state({ status: "subscribed", role: "card-holder", cardHolderUserId: "u1" }))).toEqual(["remove-mine"]);
  });

  it("a viewer and an exempt owner: no buttons at all", () => {
    for (const status of ["trial", "grace", "subscribed", "past_due", "paused"]) {
      expect(billingButtons(state({ status, role: "viewer" }))).toEqual([]);
    }
    expect(billingButtons(state({ status: "exempt", role: "exempt-owner" }))).toEqual([]);
  });
});

describe("bannerText (8.2): grace, past due and paused only", () => {
  it("no banner in trial, subscribed or exempt", () => {
    for (const status of ["exempt", "trial", "subscribed"]) {
      expect(bannerText("en", { status, trialEndsAt: TRIAL_END, graceEndsAt: GRACE_END })).toBeNull();
    }
  });

  it("en and tr, with the date", () => {
    expect(bannerText("en", { status: "grace", trialEndsAt: TRIAL_END, graceEndsAt: GRACE_END })).toBe(
      "The free month has ended. Add a card before Sat 7 Nov to keep MatchTime running.",
    );
    expect(bannerText("en", { status: "past_due", trialEndsAt: TRIAL_END, graceEndsAt: GRACE_END })).toBe(
      "This month's club fee didn't go through. MatchTime stops on Sat 7 Nov if it can't be taken.",
    );
    expect(bannerText("en", { status: "paused", trialEndsAt: TRIAL_END, graceEndsAt: null })).toBe(
      "MatchTime is paused for this club. Add a card to switch it back on.",
    );
    expect(bannerText("tr", { status: "grace", trialEndsAt: TRIAL_END, graceEndsAt: GRACE_END })).toBe(
      "Ücretsiz ay sona erdi. MatchTime'ın çalışmaya devam etmesi için 7 Kasım Cumartesi tarihinden önce kart ekleyin.",
    );
  });
});

describe("slice B5: paused because MatchTime was removed from the group", () => {
  const removed = (over: Partial<BillingStateInput> = {}) => state({ status: "paused", pausedReason: "removed", ...over });

  it("the state line asks for MatchTime to be added back, not for a card (EN and TR)", () => {
    expect(billingStateLines("en", removed())).toEqual([
      "MatchTime was removed from the club's WhatsApp group, so it is paused. All the data is kept. To carry on, add MatchTime back to the group.",
    ]);
    expect(billingStateLines("tr", removed())).toEqual([
      "MatchTime kulübün WhatsApp grubundan çıkarıldığı için duraklatıldı. Tüm veriler saklanıyor. Devam etmek için MatchTime'ı gruba geri ekleyin.",
    ]);
    // Any other pause still asks for a card.
    expect(billingStateLines("en", state({ status: "paused", pausedReason: "no-card" }))[0]).toContain("Add a card");
  });

  it("no card buttons at all, with or without the subscription still running to its end", () => {
    expect(billingButtons(removed())).toEqual([]);
    expect(billingButtons(removed({ subscriptionStatus: "active", cardHolderUserId: "u1", portalAvailable: true }))).toEqual([]);
    expect(billingButtons(removed({ subscriptionStatus: "past_due" }))).toEqual([]);
    expect(billingButtons(state({ status: "paused", pausedReason: "no-card" }))).toEqual(["add-card"]);
  });

  it("the banner says the same", () => {
    expect(bannerText("en", { status: "paused", pausedReason: "removed", trialEndsAt: TRIAL_END, graceEndsAt: null })).toBe(
      "MatchTime was removed from this club's WhatsApp group, so it is paused. Add it back to the group to carry on.",
    );
    expect(bannerText("tr", { status: "paused", pausedReason: "removed", trialEndsAt: TRIAL_END, graceEndsAt: null })).toBe(
      "MatchTime bu kulübün WhatsApp grubundan çıkarıldığı için duraklatıldı. Devam etmek için gruba geri ekleyin.",
    );
  });

  it("the notice when a card is refused for it", () => {
    expect(billingNoticeText("en", "re-add")).toBe("MatchTime isn't in the club's WhatsApp group. Add it back to the group first.");
    expect(billingNoticeText("tr", "re-add")).toBe("MatchTime kulübün WhatsApp grubunda değil. Önce gruba geri ekleyin.");
  });

  it("the page view for the contact and the settings card carry the removed line", () => {
    const c = club({ status: "paused", billing: { ...club().billing!, pausedReason: "removed" } });
    const page = billingPageView("en", c, "contact", "colin", null);
    expect(page.buttons).toEqual([]);
    expect(page.lines[0]).toContain("add MatchTime back to the group");
    expect(billingCardView("en", c, null)!.lines[0]).toContain("add MatchTime back to the group");
  });

  it("no dashes, EN or TR", () => {
    for (const lang of ["en", "tr"] as const) {
      const s = t(lang);
      for (const x of [s.billing_state_paused_removed, s.billing_banner_paused_removed, s.billing_notice_re_add]) expect(x).not.toMatch(DASH);
    }
  });
});

describe("the web strings in both tables", () => {
  it("no dashes in any billing string, EN or TR", () => {
    for (const lang of ["en", "tr"] as const) {
      const s = t(lang);
      const all = [
        s.billing_page_title,
        s.billing_state_paused,
        s.billing_who_owner,
        s.billing_who_none,
        s.billing_btn_add_card,
        s.billing_btn_change_card,
        s.billing_btn_use_mine,
        s.billing_btn_update_card,
        s.billing_btn_remove_mine,
        s.billing_notice_done,
        s.billing_notice_replaced,
        s.billing_notice_removed,
        s.billing_notice_not_set_up,
        s.billing_notice_already,
        s.billing_notice_failed,
        s.billing_open,
        s.billing_choose_collector,
        s.billing_banner_paused,
        s.billing_banner_link,
        s.billing_exempt({ club: "X" }),
        s.billing_who_collector({ name: "Colin" }),
        s.billing_card_holder_note({ club: "X", contact: "Colin" }),
        s.billing_card_on_file({ yes: true }),
        s.billing_card_on_file({ yes: false }),
      ];
      for (const x of all) expect(x).not.toMatch(DASH);
    }
  });
});

function club(over: Partial<BillingViewClub> = {}): BillingViewClub {
  return {
    club: "Riverside FC",
    status: "trial",
    plan: "standard",
    pricePence: null,
    paymentHolderId: "colin",
    contact: { userId: "colin", via: "collector", name: "Colin" },
    billing: {
      trialEndsAt: TRIAL_END,
      graceEndsAt: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      cardBrand: null,
      cardLast4: null,
      cardHolderUserId: null,
    },
    cardHolderName: null,
    ...over,
  };
}

describe("billingPageView: /billing/[orgId] per role (8.1)", () => {
  const tip = tipFor({ playersPerTeam: 7, feePerPlayer: 7 });

  it("the contact: the state, the tip and Add a card (live since B3, no 'soon' line)", () => {
    const v = billingPageView("en", club(), "contact", "colin", tip);
    expect(v.exempt).toBeNull();
    expect(v.lines).toEqual(["Free month until Sat 31 Oct. Then £9.99 a month for the whole group."]);
    expect(v.buttons).toEqual([{ key: "add-card", label: "Add a card" }]);
    expect(v).not.toHaveProperty("soon");
    expect(v.tip).toContain("*20p a player per game*");
    expect(v.tip).toContain("*£7.20*");
    expect(v.who).toBeNull();
  });

  it("an admin who is not the contact: state, who pays, tip, NO buttons", () => {
    const v = billingPageView("en", club(), "viewer", "owner", tip);
    expect(v.buttons).toEqual([]);
    expect(v).not.toHaveProperty("soon");
    expect(v.who).toBe("Colin looks after the card.");
    expect(v.tip).not.toBeNull();
  });

  it("the old card holder: their note and Remove my card, nothing else", () => {
    const c = club({
      status: "subscribed",
      billing: { ...club().billing!, cardHolderUserId: "elvin", currentPeriodEnd: PERIOD_END },
      cardHolderName: "Elvin",
    });
    const v = billingPageView("en", c, "card-holder", "elvin", tip);
    expect(v.lines).toEqual([]);
    expect(v.holderNote).toBe("Your card still pays Riverside FC's MatchTime fee until Colin adds theirs.");
    expect(v.buttons).toEqual([{ key: "remove-mine", label: "Remove my card" }]);
    expect(v.tip).toBeNull();
  });

  it("the owner of an exempt club: one exempt line, nothing about billing", () => {
    const v = billingPageView("en", club({ status: "exempt", billing: null, club: "Sutton FC" }), "exempt-owner", "kemal", null);
    expect(v).toMatchObject({ exempt: "Sutton FC has no club fee. MatchTime is free for this club.", lines: [], buttons: [], tip: null, who: null });
  });

  it("Turkish", () => {
    const v = billingPageView("tr", club(), "contact", "colin", tip);
    expect(v.title).toBe("Kulüp ücreti");
    expect(v.buttons[0].label).toBe("Kart ekle");
    expect(v.tip).toContain("7'ye 7");
  });
});

describe("billingCardView: the /admin/settings card (8.1)", () => {
  it("an exempt club (Sutton FC) gets no card at all", () => {
    expect(billingCardView("en", club({ status: "exempt", billing: null }), null)).toBeNull();
  });

  it("with a collector: state, who pays, card on file, tip, Open billing; no 'choose a collector'", () => {
    const v = billingCardView("en", club(), tipFor())!;
    expect(v).toMatchObject({
      title: "Club fee",
      lines: ["Free month until Sat 31 Oct. Then £9.99 a month for the whole group."],
      who: "Colin looks after the card.",
      cardOnFile: "Card on file: no.",
      openLabel: "Open billing",
      chooseCollectorLabel: null,
    });
    expect(v.tip).toContain("25p");
  });

  it("no collector: the owner fallback line and 'Choose a money collector'", () => {
    const v = billingCardView("en", club({ paymentHolderId: null, contact: { userId: "owner", via: "owner", name: "Olly" } }), null)!;
    expect(v.who).toBe("No money collector set: the owner is asked for the card.");
    expect(v.chooseCollectorLabel).toBe("Choose a money collector");
  });

  it("a card on file is a yes, and its brand and last four are never on the card", () => {
    const c = club({
      status: "subscribed",
      billing: { ...club().billing!, cardHolderUserId: "colin", cardBrand: "Visa", cardLast4: "4242", currentPeriodEnd: PERIOD_END },
      cardHolderName: "Colin",
    });
    const v = billingCardView("en", c, null)!;
    expect(v.cardOnFile).toBe("Card on file: yes.");
    expect(JSON.stringify(v)).not.toContain("4242");
  });
});
