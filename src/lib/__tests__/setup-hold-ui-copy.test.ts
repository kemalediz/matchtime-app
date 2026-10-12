/**
 * The setup-hold pages' words that the end-to-end probe found untrue or
 * inconsistent (2026-10): each one pinned in English and Turkish.
 */
import { describe, expect, it } from "vitest";
import { en } from "../i18n/strings.en";
import { tr } from "../i18n/strings.tr";
import { infoCopy } from "../info-copy";

describe("1. removed from the group before going live", () => {
  it("the admin home card says so, and what to do", () => {
    expect(en.sj_card_removed_title).toBe("MatchTime was removed from your group");
    expect(tr.sj_card_removed_title).toBe("MatchTime grubunuzdan çıkarıldı");
    expect(en.sj_card_setting_up_removed({ group: "Harbour Tuesday 6s" })).toBe(
      'MatchTime was removed from "Harbour Tuesday 6s" before going live. Add it back to the group, then go live.',
    );
    expect(tr.sj_card_setting_up_removed({ group: "Kıyı Salı Maçı" })).toBe(
      'MatchTime yayına geçmeden "Kıyı Salı Maçı" grubundan çıkarıldı. Gruba tekrar ekleyin, sonra yayına alın.',
    );
    expect(en.sj_card_setting_up_removed({ group: null })).toContain("removed from your WhatsApp group before going live");
    expect(tr.sj_card_setting_up_removed({ group: null })).toContain("WhatsApp grubunuzdan çıkarıldı");
  });

  it("the WhatsApp bot section's badge and body say so", () => {
    expect(en.sj_live_wa_badge_removed).toBe("Not in your group");
    expect(tr.sj_live_wa_badge_removed).toBe("Grubunuzda değil");
    expect(en.sj_live_wa_body_removed).toBe(
      "MatchTime was removed from your group before going live, so nothing has started there. Add it back to the group, then press Go live at the top of this page.",
    );
    expect(tr.sj_live_wa_body_removed).toBe(
      "MatchTime yayına geçmeden grubunuzdan çıkarıldı, bu yüzden orada hiçbir şey başlamadı. Gruba tekrar ekleyin, sonra bu sayfanın en üstündeki Yayına al düğmesine basın.",
    );
  });

  it("the popup never says 'Nothing is wrong' while removed", () => {
    for (const lang of ["en", "tr"]) {
      const text = infoCopy(lang, "st_whatsapp_removed").paragraphs.join(" ");
      expect(text).not.toMatch(/Nothing is wrong|Bir sorun yok/);
      expect(text).toMatch(lang === "en" ? /removed from your WhatsApp group/ : /WhatsApp grubunuzdan çıkarıldı/);
    }
    // The setting-up popup, for a club that IS in its group, is unchanged.
    expect(infoCopy("en", "st_whatsapp_setup").paragraphs.join(" ")).toContain("Nothing is wrong");
  });
});

describe("2. words that were not true", () => {
  it("still reading: it can take a while, and who gets the setup message", () => {
    expect(en.sj_live_still_reading).toBe(
      "MatchTime is still reading your group's messages, which can take a while. It will send the setup message to the organiser who connected the club when it has finished. Try again after that.",
    );
    expect(tr.sj_live_still_reading).toBe(
      "MatchTime grubunuzdaki mesajları hâlâ okuyor, bu biraz zaman alabilir. Bitirdiğinde kurulum mesajını kulübü bağlayan organizatöre gönderecek. Ondan sonra tekrar deneyin.",
    );
    expect(en.sj_live_still_reading).not.toContain("a few minutes");
  });

  it("went live: the hello is on its way, not already there", () => {
    expect(en.sj_live_done({ group: "Harbour Tuesday 6s" })).toBe(
      'MatchTime is introducing itself in "Harbour Tuesday 6s" now. It can take a few minutes to appear.',
    );
    expect(tr.sj_live_done({ group: "Kıyı Salı Maçı" })).toBe(
      'MatchTime şimdi "Kıyı Salı Maçı" grubunda kendini tanıtıyor. Mesajın görünmesi birkaç dakika sürebilir.',
    );
    expect(en.sj_live_done_posted).toBe("The message it is posting");
    expect(tr.sj_live_done_posted).toBe("Gruba yazmakta olduğu mesaj");
  });
});

describe("3. Turkish: one word for live", () => {
  it("'You're live' is Yayındasınız on the card as on the banner", () => {
    expect(tr.sj_card_approved({ group: "G" })).toMatch(/^Yayındasınız\. /);
    expect(tr.sj_live_done_title).toBe("Yayındasınız.");
    expect(tr.sj_card_approved({ group: "G" })).not.toContain("Aktifsiniz");
  });
});

describe("4. true with the approval hold on or off", () => {
  it("added by someone else: checked before MatchTime does anything there", () => {
    expect(en.sj_card_pending_other({ group: "G" })).toBe(
      'MatchTime was added to "G" by someone else. We\'ll check it before MatchTime does anything there.',
    );
    expect(tr.sj_card_pending_other({ group: "G" })).toBe(
      'MatchTime "G" grubuna başka biri tarafından eklendi. MatchTime orada bir şey yapmadan önce kontrol edeceğiz.',
    );
    expect(en.sj_card_pending_other({ group: "G" })).not.toContain("switching on");
  });

  it("the connect popup: says nothing in the group while the club is checked, and does not promise speech at approval", () => {
    const enText = infoCopy("en", "dash_connect").paragraphs.join(" ");
    const trText = infoCopy("tr", "dash_connect").paragraphs.join(" ");
    expect(enText).toContain("MatchTime says nothing in the group while we check.");
    expect(trText).toContain("Biz kontrol ederken MatchTime grupta hiçbir şey yazmaz.");
    expect(enText).not.toContain("until your club is approved");
    expect(trText).not.toContain("onaylanana kadar");
  });
});

describe("5. the Go live button names the club", () => {
  it("in its accessible name and beside it", () => {
    expect(en.sj_live_button_label({ club: "Harbour FC" })).toBe("Go live: Harbour FC");
    expect(tr.sj_live_button_label({ club: "Kıyı SK" })).toBe("Yayına al: Kıyı SK");
    expect(en.sj_live_for_club({ club: "Harbour FC" })).toBe("This takes Harbour FC live.");
    expect(tr.sj_live_for_club({ club: "Kıyı SK" })).toBe("Bu düğme Kıyı SK kulübünü yayına alır.");
  });
});

describe("7. an expired link", () => {
  it("says so on the sign-in page", () => {
    expect(en.login_link_expired).toBe("That link has expired. Sign in with your WhatsApp number to carry on.");
    expect(tr.login_link_expired).toBe("Bu bağlantının süresi doldu. Devam etmek için WhatsApp numaranızla giriş yapın.");
  });
});

describe("a link that is not valid (security review of PR #248, fix 5)", () => {
  it("does not claim it was 'already used': nothing is single-use", () => {
    expect(en.link_invalid).toBe("This link isn't valid.");
    expect(tr.link_invalid).toBe("Bu bağlantı geçerli değil.");
    expect(en.link_go_sign_in).toBe("Go to sign in");
    expect(tr.link_go_sign_in).toBe("Giriş sayfasına git");
  });
});
