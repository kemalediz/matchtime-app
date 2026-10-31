/**
 * THE WHATSAPP HELP FOR WHAT SHIPPED ON 2026-10-31 (Kemal's rule: every
 * feature is explained in the help menu AND the web guide).
 *
 *   1. The friend link (#488): a player says a friend is coming, MatchTime
 *      reacts ✉️ and DMs him a personal link for the friend; the friend
 *      fills in the form and sends his WhatsApp code, which books him in
 *      (bench if full) and adds him to the player pool; the link works
 *      until kick-off. An organiser adding someone adds him directly.
 *      Explained under "help availability" and one line of the bare help.
 *      Since the same day it is also a topic of its own, "help friend"
 *      (help-friend-topic.test.ts).
 *   2. A REAL tag (#482, #487): type @ and pick Match Time; typing the name
 *      or replying to MatchTime does not count. Attendance never needs one.
 *   3. Quiet hours by tag (#483, #486): in HQ's help and the organiser's
 *      "help settings".
 *
 * No database, no model.
 */
import { describe, expect, it } from "vitest";
import { buildHelpReply, buildHowToUseMe, type HelpFeatures } from "@/lib/onboarding-conversation";
import { buildHqHelp } from "@/lib/admin-group-help";
import { buildGettingReady, type GettingReadyClub } from "@/lib/admin-onboarding-rules";
import { t } from "@/lib/i18n/t";

const BASE: HelpFeatures = {
  attendance: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  statsQa: true,
  reminders: true,
  bench: true,
  paymentTracking: false,
  paymentCollection: true,
};

const DASH = /[–—]/;

const FRIEND = {
  en: [/my friend Ali is coming/, /✉️/, /personal link/, /WhatsApp code/, /bench/, /player pool/, /until kick-off/],
  tr: [/arkadaşım Ali de geliyor/, /✉️/, /kişisel bir bağlantı/, /WhatsApp kodunu/, /yedeğe/, /oyuncu havuzuna/, /maç başlayana kadar/],
};

describe("help availability explains the friend link", () => {
  for (const lang of ["en", "tr"] as const) {
    it(`${lang}: every availability variant, in the group, a player's DM and an organiser's`, () => {
      const variants: HelpFeatures[] = [BASE, { ...BASE, organiserPicks: true }, { ...BASE, organisersAnnounce: true }];
      for (const f of variants) {
        for (const audience of ["group", "player", "admin"] as const) {
          const out = buildHelpReply("availability", f, lang, { audience });
          for (const re of FRIEND[lang]) expect(out, `${lang} ${audience}`).toMatch(re);
          expect(out).not.toMatch(DASH);
          expect(out).not.toMatch(/waiting list|bekleme listesi/i);
        }
      }
    });
  }

  it("an organiser also hears that adding someone himself adds him straight away, EN and TR", () => {
    expect(buildHelpReply("availability", BASE, "en", { audience: "admin" })).toContain("When an organiser adds someone, they go straight on the list.");
    expect(buildHelpReply("availability", BASE, "tr", { audience: "admin" })).toContain("Bir organizatör birini eklediğinde doğrudan listeye girer.");
    expect(buildHelpReply("availability", BASE, "en", { audience: "group" })).not.toContain("When an organiser adds someone");
  });

  it("the exact friend line, EN and TR", () => {
    expect(t("en").onbHelpFriendLink).toBe(
      `👥 Bringing a friend? Say so in the group (for example *my friend Ali is coming*), no need to tag me. I react ✉️ and DM you a personal link to forward to them. Your friend opens it, fills in their details and sends the WhatsApp code: that puts them in the game (on the bench if it's full) and in the MatchTime player pool. The link works until kick-off.`,
    );
    expect(t("tr").onbHelpFriendLink).toBe(
      `👥 Arkadaşınızı mı getiriyorsunuz? Grupta söyleyin (örneğin *arkadaşım Ali de geliyor*), beni etiketlemenize gerek yok. ✉️ ile tepki verir, ona iletmeniz için size özelden kişisel bir bağlantı gönderirim. Arkadaşınız bağlantıyı açar, bilgilerini doldurur ve WhatsApp kodunu gönderir: böylece maça girer (kadro doluysa yedeğe) ve MatchTime oyuncu havuzuna katılır. Bağlantı maç başlayana kadar geçerlidir.`,
    );
  });
});

describe("the bare help (and the setup post's how-to block)", () => {
  it("one short friend line while attendance is on, EN and TR", () => {
    expect(buildHowToUseMe(BASE, "en")).toContain(`👥 Bringing a friend? Just say so (for example *my friend Ali is coming*) and I'll DM you a link to send them.`);
    expect(buildHowToUseMe(BASE, "tr")).toContain(`👥 Arkadaşınızı mı getiriyorsunuz? Söylemeniz yeter (örneğin *arkadaşım Ali de geliyor*), ona göndermeniz için size özelden bir bağlantı yollarım.`);
    expect(buildHowToUseMe({ ...BASE, attendance: false }, "en")).not.toContain("Bringing a friend");
    expect(buildHowToUseMe({ ...BASE, attendance: false }, "tr")).not.toContain("Arkadaşınızı");
  });

  it("says how to make a real tag, and that the name or a reply is not enough, EN and TR", () => {
    for (const f of [BASE, { ...BASE, organisersAnnounce: true }]) {
      const en = buildHelpReply(null, f, "en", { audience: "group" });
      expect(en).toContain(`👉 To tag me, type *@* and pick *Match Time* from the list. Typing my name or replying to my message is not enough.`);
      const tr = buildHelpReply(null, f, "tr", { audience: "group" });
      expect(tr).toContain(`👉 Etiketlemek için *@* yazıp listeden *Match Time*'ı seçin. Adımı yazmak ya da mesajıma yanıt vermek yetmez.`);
      expect(en).not.toMatch(DASH);
      expect(tr).not.toMatch(DASH);
    }
  });
});

describe("quiet hours by tag", () => {
  it("HQ's help lists it for every club, EN and TR", () => {
    for (const squad of [true, false]) {
      expect(buildHqHelp({ lang: "en", squad, graphics: true, picks: false, paid: false })).toContain(
        `🌙 *"@Match Time turn on quiet hours from 23:00 to 09:00"*, *"@Match Time turn off quiet hours"*: I hold my own messages overnight, or send at any time. A new club starts with quiet hours off.`,
      );
      expect(buildHqHelp({ lang: "tr", squad, graphics: true, picks: false, paid: false })).toContain(
        `🌙 *"@Match Time sessiz saatleri 23:00 ile 09:00 arası aç"*, *"@Match Time sessiz saatleri kapat"*: kendi mesajlarımı gece bekletirim ya da her saatte gönderirim. Yeni bir kulüpte sessiz saatler kapalı başlar.`,
      );
    }
  });

  it("an organiser's help settings names it, EN and TR; a player's does not", () => {
    const url = "https://mt.example/s";
    expect(t("en").onbHelpSettings({ audience: "admin", url })).toContain(
      `Some you can change by tagging me too, for example *@Match Time turn on quiet hours from 23:00 to 09:00*.`,
    );
    expect(t("tr").onbHelpSettings({ audience: "admin", url })).toContain(
      `Bazılarını beni etiketleyerek de değiştirebilirsin, örneğin *@Match Time sessiz saatleri 23:00 ile 09:00 arası aç*.`,
    );
    expect(t("en").onbHelpSettings({ audience: "player", url })).not.toContain("quiet hours");
  });
});

describe("HQ's Getting ready post says a tag is needed (#482), EN and TR", () => {
  const club: GettingReadyClub = {
    name: "FNF",
    language: "en",
    featureAttendance: true,
    squadMode: "weekly",
    listAnnouncer: "organisers",
    benchPickMode: "organiser",
    paymentCollectionEnabled: false,
    paymentHolderId: null,
  };
  for (const lang of ["en", "tr"] as const) {
    it(lang, () => {
      const text = buildGettingReady({
        club: { ...club, language: lang },
        audience: "group",
        nextMatchDate: new Date("2026-11-06T19:00:00Z"),
        activityDays: [5],
        link: "https://mt.example/s",
      })!;
      expect(text).not.toMatch(/No need to tag me here|etiketlemenize gerek yok\. Bu gruptaki|I read every message/);
      if (lang === "en") {
        expect(text).toContain("Tag me in every message here: type *@* and pick *Match Time* from the list");
        expect(text).toContain("*@Match Time YES*");
        expect(text).toContain("*@Match Time what can you do?*");
      } else {
        expect(text).toContain("Burada her mesajda beni etiketleyin: *@* yazıp listeden *Match Time*'ı seçin");
        expect(text).toContain("*@Match Time EVET*");
        expect(text).toContain("*@Match Time neler yapabilirsin?*");
      }
    });
  }
});
