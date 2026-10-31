/**
 * EVERY HQ-BOUND ASK SAYS TO TAG MATCHTIME (2026-10-31, after #482).
 *
 * Since #482 nothing in the admin group (HQ) is read without the Pi's real
 * mention flag: a YES, a pick, PAID, the score, a 1 or 2 to a pairing
 * (`admin-group.ts` step 0, `admin-group-understand.ts`'s gate, the pick
 * check). So every notice that lands in HQ and asks for a reply must ask
 * for it tagged. Where the same notice can go by DM, the DM keeps the plain
 * reply (DMs need no tag), chosen by the channel, never one wording for
 * both. No database, no model.
 */
import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n/t";
import { buildFirstTeamsNotice } from "@/lib/admin-onboarding-rules";
import { buildClaimsDigest, buildCollectorReplyAnswer, buildOtherMonthHint, claimsDigestHow } from "@/lib/month-payment-copy";
import { monthSetupCopy } from "@/lib/i18n/month-setup";
import { inviteCopy as poolInviteCopy } from "@/lib/i18n/pool-invite";
import { poolCopy as poolOfferCopy } from "@/lib/i18n/pool-offer";

const TAG_EN = "To tag me, type *@* and pick *Match Time* from the list.";
const TAG_TR = "Etiketlemek için *@* yazıp listeden *Match Time*'ı seçin.";
const en = t("en");
const tr = t("tr");
const DASH = /[–—]/;

describe("the first-teams notice (ao_teams_approve) knows its channel", () => {
  const args = { lang: "en", matchDate: new Date("2026-11-06T20:00:00Z"), readyTime: "10:00", confirmed: 14, maxPlayers: 14, seed: null };
  it("EN, HQ: tagged YES and the tag explanation; DM: the plain YES as before", () => {
    expect(en.ao_teams_approve({ organisers: true, audience: "group" })).toBe(
      `Say *@Match Time YES* to make them final, or tag me and say *swap* or *move* if you want changes (for brand new teams: *@Match Time reshuffle*). For the team sheet, a graphic to share with the players, tag me and ask any time: *@Match Time team sheet*. ${TAG_EN}`,
    );
    expect(en.ao_teams_approve({ organisers: false, audience: "group" })).toBe(
      `Say *@Match Time YES* to make them final and I'll post them in the main chat, or tag me and say *swap* or *move* if you want changes (for brand new teams: *@Match Time reshuffle*). ${TAG_EN}`,
    );
    expect(en.ao_teams_approve({ organisers: true, audience: "dm" })).toBe(
      `Reply *YES* to make them final, or say *swap* or *move* if you want changes (tag me for brand new teams: *@Match Time reshuffle*). For the team sheet, a graphic to share with the players, tag me and ask any time: *@Match Time team sheet*.`,
    );
    expect(en.ao_teams_approve({ organisers: false, audience: "dm" })).toBe(
      `Reply *YES* to make them final and I'll post them in the main chat, or say *swap* or *move* if you want changes (tag me for brand new teams: *@Match Time reshuffle*).`,
    );
  });
  it("TR, HQ and DM", () => {
    expect(tr.ao_teams_approve({ organisers: true, audience: "group" })).toBe(
      `Kesinleştirmek için *@Match Time EVET* yazın; değişiklik isterseniz beni etiketleyip *değiş* ya da *taşı* yazın (tamamen yeni takımlar için: *@Match Time yeniden kur*). Oyunculara paylaşmanız için takım listesi görselini istediğiniz zaman beni etiketleyerek isteyin: *@Match Time takım listesi*. ${TAG_TR}`,
    );
    expect(tr.ao_teams_approve({ organisers: false, audience: "group" })).toBe(
      `Kesinleştirmek için *@Match Time EVET* yazın, ana grupta ben paylaşırım; değişiklik isterseniz beni etiketleyip *değiş* ya da *taşı* yazın (tamamen yeni takımlar için: *@Match Time yeniden kur*). ${TAG_TR}`,
    );
    expect(tr.ao_teams_approve({ organisers: true, audience: "dm" })).toContain("Kesinleştirmek için *EVET* yazın;");
  });
  it("the builder passes the channel through", () => {
    expect(buildFirstTeamsNotice({ ...args, organisers: true, audience: "group" })).toContain("*@Match Time YES*");
    expect(buildFirstTeamsNotice({ ...args, organisers: true, audience: "dm" })).toContain("Reply *YES*");
    expect(buildFirstTeamsNotice({ ...args, lang: "tr", organisers: true, audience: "group" })).toContain("*@Match Time EVET*");
  });
});

describe("the organiser pick in HQ", () => {
  it("the list's instructions: tagged in HQ, plain by DM", () => {
    expect(en.pick_instructions_group).toBe(
      `Tag me with a number, a name or an @tag, e.g. *@Match Time 2*, or *@Match Time 2 3* for two. *@Match Time NONE* leaves it open. ${TAG_EN}`,
    );
    expect(tr.pick_instructions_group).toBe(
      `Beni etiketleyip numara, isim ya da @etiket yazın, örneğin *@Match Time 2*, iki kişi için *@Match Time 2 3*. *@Match Time HİÇBİRİ* yazarsanız yer boş kalır. ${TAG_TR}`,
    );
    expect(en.pick_instructions_dm).toContain("Reply with a number or a name");
  });
  it("the follow-ups: someone not on the bench, two of the same name", () => {
    expect(en.pick_not_on_list({ name: "Sam", audience: "group" })).toBe("*Sam* isn't on the bench. Bring them in anyway? Say *@Match Time YES*.");
    expect(en.pick_not_on_list({ name: "Sam", audience: "dm" })).toBe("*Sam* isn't on the bench. Bring them in anyway? Reply *YES*.");
    expect(tr.pick_not_on_list({ name: "Sam", audience: "group" })).toBe("*Sam* yedek listesinde değil. Yine de kadroya alayım mı? *@Match Time EVET* yazın.");
    expect(tr.pick_not_on_list({ name: "Sam", audience: "dm" })).toBe("*Sam* yedek listesinde değil. Yine de kadroya alayım mı? *EVET* yazın.");
    expect(en.pick_ambiguous({ first: "Ali", names: ["Ali A", "Ali B"], audience: "group" })).toMatch(/Which one\? Tag me with the full name\.$/);
    expect(en.pick_ambiguous({ first: "Ali", names: ["Ali A", "Ali B"], audience: "dm" })).toMatch(/Which one\? Reply with the full name\.$/);
    expect(tr.pick_ambiguous({ first: "Ali", names: ["Ali A", "Ali B"], audience: "group" })).toMatch(/Hangisi\? Beni etiketleyip tam adını yazın\.$/);
    expect(tr.pick_ambiguous({ first: "Ali", names: ["Ali A", "Ali B"], audience: "dm" })).toMatch(/Hangisi\? Tam adını yazın\.$/);
  });
});

describe("the teams proposal, posted in HQ", () => {
  const uneven = { redLabel: "Red", red: 7, yellowLabel: "Yellow", yellow: 6 };
  it.each([
    ["tp_how_to_change", en.tp_how_to_change({ a: "Sam", b: "Alex" }), "*@Match Time swap Sam and Alex*"],
    ["tp_ask_yes_quiet", en.tp_ask_yes_quiet, `Say *@Match Time YES* when they are final. I won't post them in the players' group. ${TAG_EN}`],
    ["tp_ask_yes_post", en.tp_ask_yes_post, `Say *@Match Time YES* when they are final and I'll post them in the players' group. ${TAG_EN}`],
    ["tp_reminder", en.tp_reminder({ kickoff: "20:00" }), "then say *@Match Time YES*."],
    ["tp_uneven", en.tp_uneven(uneven), "or say *@Match Time YES* twice to keep them."],
    ["tp_uneven_confirm", en.tp_uneven_confirm(uneven), "Say *@Match Time YES* again"],
    ["tp_restore_none", en.tp_restore_none, "*@Match Time use these*"],
    ["tp_restored_earlier", en.tp_restored_earlier({ day: "Fri", time: "10:00" }), "*@Match Time YES*"],
    ["tp_set_pasted", en.tp_set_pasted, "*@Match Time YES*"],
    ["tp_teams_set_aside", en.tp_teams_set_aside, "*@Match Time show me the teams*"],
  ])("EN %s", (_k, text, want) => {
    expect(text).toContain(want);
    expect(text.replace(/@Match Time YES/g, "")).not.toContain("YES");
  });
  it.each([
    ["tp_how_to_change", tr.tp_how_to_change({ a: "Sam", b: "Alex" }), "*@Match Time Sam ile Alex yer değiştirsin*"],
    ["tp_ask_yes_quiet", tr.tp_ask_yes_quiet, `Kesinleşince *@Match Time EVET* yazın. Oyuncu grubuna ben göndermeyeceğim. ${TAG_TR}`],
    ["tp_ask_yes_post", tr.tp_ask_yes_post, `Kesinleşince *@Match Time EVET* yazın, oyuncu grubuna ben gönderirim. ${TAG_TR}`],
    ["tp_reminder", tr.tp_reminder({ kickoff: "20:00" }), "sonra *@Match Time EVET* yazın."],
    ["tp_uneven", tr.tp_uneven(uneven), "iki kez *@Match Time EVET* yazın."],
    ["tp_uneven_confirm", tr.tp_uneven_confirm(uneven), "yine *@Match Time EVET* yazın"],
    ["tp_restore_none", tr.tp_restore_none, "*@Match Time bunları kullan*"],
    ["tp_restored_earlier", tr.tp_restored_earlier({ day: "Cuma", time: "10:00" }), "*@Match Time EVET*"],
    ["tp_set_pasted", tr.tp_set_pasted, "*@Match Time EVET*"],
    ["tp_teams_set_aside", tr.tp_teams_set_aside, "*@Match Time takımları göster*"],
  ])("TR %s", (_k, text, want) => {
    expect(text).toContain(want);
    expect(text.replace(/@Match Time EVET/g, "")).not.toContain("EVET");
  });
});

describe("other HQ-only asks", () => {
  it.each([
    ["ag_paste_confirm", en.ag_paste_confirm, "Say *@Match Time YES* to apply.", tr.ag_paste_confirm, "Uygulamak için *@Match Time EVET* yazın."],
    [
      "hq_confirm_which",
      en.hq_confirm_which({ items: ["the teams", "the list"] }),
      "Reply to that message with *@Match Time YES*.",
      tr.hq_confirm_which({ items: ["takımlar mı", "liste mi"] }),
      "O mesaja *@Match Time EVET* diye cevap verin.",
    ],
    ["hq_fee_free_ask", en.hq_fee_free_ask({ names: "Bilal", day: "Friday", notes: "" }), "Say *@Match Time YES*.", tr.hq_fee_free_ask({ names: "Bilal", day: "Cuma", notes: "" }), "Onaylamak için *@Match Time EVET* yazın."],
    ["hq_fee_unfree_ask", en.hq_fee_unfree_ask({ names: "Bilal", day: "Friday" }), "Say *@Match Time YES*.", tr.hq_fee_unfree_ask({ names: "Bilal", day: "Cuma" }), "Onaylamak için *@Match Time EVET* yazın."],
    ["ask_score_hq", en.ask_score_hq({ activityName: "Friday 7s" }), `Tag me here with it and I'll record it. ${TAG_EN}`, tr.ask_score_hq({ activityName: "Cuma" }), `Beni etiketleyip buraya yazın, kaydedeyim. ${TAG_TR}`],
    [
      "ask_score_hq_mom",
      en.ask_score_hq_mom({ activityName: "Friday 7s", mvpLabel: "Man of the Match" }),
      `Tag me here with it and I'll record it. ${TAG_EN}`,
      tr.ask_score_hq_mom({ activityName: "Cuma", mvpLabel: "maçın adamı" }),
      `Beni etiketleyip buraya yazın, kaydedeyim. ${TAG_TR}`,
    ],
    [
      "mwk_dm_seed_from_group (to HQ)",
      en.mwk_dm_seed_from_group({ month: "November", count: 2, names: "A, B", unknown: null, link: "L", hq: true }),
      "say *@Match Time YES* in the organisers' group",
      tr.mwk_dm_seed_from_group({ month: "Kasım", count: 2, names: "A, B", unknown: null, link: "L", hq: true }),
      "organizatör grubunda *@Match Time EVET* yaz",
    ],
    [
      "month hq_seed_proposal",
      monthSetupCopy("en").hq_seed_proposal({ month: "November", count: 2, names: "A, B", unknown: null, link: "L" }),
      "Say *@Match Time YES* to start November with them.",
      monthSetupCopy("tr").hq_seed_proposal({ month: "Kasım", count: 2, names: "A, B", unknown: null, link: "L" }),
      "Kasım ayını onlarla başlatmak için *@Match Time EVET* yazın.",
    ],
    [
      "month held_notice (HQ)",
      monthSetupCopy("en").held_notice({ month: "November", link: "L", inGroup: true }),
      "Or tag me and paste the list in this group",
      monthSetupCopy("tr").held_notice({ month: "Kasım", link: "L", inGroup: true }),
      "Ya da beni etiketleyip listeyi bu gruba yapıştırın",
    ],
    [
      "pool notice_wants_join_hq",
      poolInviteCopy("en").notice_wants_join_hq({ name: "Ali", day: "Friday", link: "L" }),
      "Say *@Match Time YES* here to send them",
      poolInviteCopy("tr").notice_wants_join_hq({ name: "Ali", day: "Cuma", link: "L" }),
      "burada *@Match Time EVET* yazın",
    ],
    [
      "pool notice_offer_line_hq",
      poolOfferCopy("en").notice_offer_line_hq({ band: "2 to 5 miles", link: "L" }),
      "say *@Match Time YES* here",
      poolOfferCopy("tr").notice_offer_line_hq({ band: "2 ile 5 mil", link: "L" }),
      "burada *@Match Time EVET* yazın",
    ],
  ])("%s, EN and TR", (_k, e, wantEn, tx, wantTr) => {
    expect(e).toContain(wantEn);
    expect(tx).toContain(wantTr);
    for (const s of [e, tx]) expect(s).not.toMatch(DASH);
  });
});

describe("partner club notices: tagged in HQ, plain by DM", () => {
  const xask = {
    asker: "Harbour FC",
    places: 1,
    day: "Friday",
    venue: "Goals",
    format: null,
    fee: null,
    own: null,
    link: "L",
  };
  it("the ask's approval", () => {
    expect(en.xask_approval_notice({ ...xask, inGroup: true })).toContain("Reply to this message with *@Match Time YES*, or open L.");
    expect(tr.xask_approval_notice({ ...xask, inGroup: true })).toContain("Bu mesajı yanıtlayıp *@Match Time EVET* yazın ya da şunu açın: L.");
    expect(en.xask_approval_notice({ ...xask, inGroup: false })).toContain("Tap to say yes or no: L");
  });
  it("the partner request", () => {
    const a = { asker: "Harbour FC", club: "FNF", card: "1.2 miles away", link: "L" };
    expect(en.pr_request_notice({ ...a, inGroup: true })).toMatch(/Answer by replying to this message with \*@Match Time 1\* to accept or \*@Match Time 2\* to decline, or open L$/);
    expect(en.pr_request_notice({ ...a, inGroup: false })).toMatch(/Reply \*1\* to accept or \*2\* to decline, or open L$/);
    expect(tr.pr_request_notice({ ...a, inGroup: true })).toMatch(/Bu mesajı yanıtlayıp kabul etmek için \*@Match Time 1\*, reddetmek için \*@Match Time 2\* yazın ya da şunu açın: L$/);
    expect(tr.pr_request_notice({ ...a, inGroup: false })).toMatch(/Kabul etmek için \*1\*, reddetmek için \*2\* yazın ya da şunu açın: L$/);
  });
  it("the pairing, both sides", () => {
    const a = { club: "FNF", other: "Harbour FC", link: "L" };
    for (const k of ["pc_paired_notice_asker", "pc_paired_notice_partner"] as const) {
      expect(en[k]({ ...a, inGroup: true })).toMatch(/Club owner: reply to this message with \*@Match Time 1\* to accept or \*@Match Time 2\* to decline, or open L$/);
      expect(en[k]({ ...a, inGroup: false })).toMatch(/Club owner: reply \*1\* to accept or \*2\* to decline, or open L$/);
      expect(tr[k]({ ...a, inGroup: true })).toMatch(/Kulüp sahibi: kabul etmek için bu mesajı yanıtlayıp \*@Match Time 1\*, reddetmek için \*@Match Time 2\* yazın ya da şunu açın: L$/);
      expect(tr[k]({ ...a, inGroup: false })).toMatch(/Kulüp sahibi: kabul etmek için \*1\*, reddetmek için \*2\* yazın ya da şunu açın: L$/);
    }
  });
});

describe("the money collector's PAID list: tagged in HQ, plain by DM", () => {
  const monthDate = new Date("2026-11-06T20:00:00Z");
  const claims = [{ slot: 3, name: "Sam", amountPence: 2000 }];
  it("the list itself carries no instruction (what a reply is matched against), the how line follows the channel", () => {
    const body = buildClaimsDigest({ claims, monthDate, lang: "en" });
    expect(body).toBe("💷 1 says they've paid for November:\n3. Sam £20");
    expect(claimsDigestHow({ lang: "en", audience: "dm" })).toBe("Reply *PAID ALL*, or *PAID* and the numbers that arrived (PAID 1 3), or *PAID NONE*.");
    expect(claimsDigestHow({ lang: "en", audience: "group" })).toBe(
      `Tag me with *@Match Time PAID ALL*, or *@Match Time PAID* and the numbers that arrived (*@Match Time PAID 1 3*), or *@Match Time PAID NONE*. ${TAG_EN}`,
    );
    expect(claimsDigestHow({ lang: "tr", audience: "dm" })).toBe("*ÖDENDİ HEPSİ* yazın, ya da *ÖDENDİ* ve gelenlerin numaralarını (ÖDENDİ 1 3), ya da *ÖDENDİ HİÇBİRİ*.");
    expect(claimsDigestHow({ lang: "tr", audience: "group" })).toBe(
      `Beni etiketleyip *@Match Time ÖDENDİ HEPSİ* yazın, ya da *@Match Time ÖDENDİ* ve gelenlerin numaralarını (*@Match Time ÖDENDİ 1 3*), ya da *@Match Time ÖDENDİ HİÇBİRİ*. ${TAG_TR}`,
    );
  });
  it("an unknown number and the other month's hint", () => {
    expect(buildCollectorReplyAnswer({ kind: "unknown-numbers", numbers: [9], monthDate, lang: "en", audience: "group" })).toMatch(/Tag me with \*@Match Time PAID\* and the numbers from my last message\.$/);
    expect(buildCollectorReplyAnswer({ kind: "unknown-numbers", numbers: [9], monthDate, lang: "en", audience: "dm" })).toMatch(/Reply \*PAID\* and the numbers from my last message\.$/);
    expect(buildCollectorReplyAnswer({ kind: "unknown-numbers", numbers: [9], monthDate, lang: "tr", audience: "group" })).toMatch(/Beni etiketleyip \*@Match Time ÖDENDİ\* ve son mesajımdaki numaraları yazın\.$/);
    const other = new Date("2026-12-04T20:00:00Z");
    expect(buildOtherMonthHint({ monthDate, otherDate: other, lang: "en", audience: "group" })).toContain("*@Match Time PAID DECEMBER ALL*");
    expect(buildOtherMonthHint({ monthDate, otherDate: other, lang: "en", audience: "dm" })).toContain("*PAID DECEMBER ALL*");
    expect(buildOtherMonthHint({ monthDate, otherDate: other, lang: "en", audience: "dm" })).not.toContain("@Match Time");
    expect(buildOtherMonthHint({ monthDate, otherDate: other, lang: "tr", audience: "group" })).toContain("*@Match Time ÖDENDİ ARALIK HEPSİ*");
  });
});
