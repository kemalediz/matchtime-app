/**
 * "@Match Time help friend" (Kemal, 2026-10-31): the friend link (#488) gets
 * a help topic of its own, so "how do I bring a friend?" and "arkadaşımı
 * nasıl getiririm?" answer with how the friend link works, in the players'
 * group, HQ and by DM. The topic is the question extractor's `feature`
 * (`HELP_FEATURES`); this pins what `buildHelpReply` does with it.
 *
 * The friend link only works while attendance is on (friend-link/rules.ts
 * `decideThirdPartyIn`), so with attendance off the topic says so and how to
 * switch it on, like every flag topic. No database, no model.
 */
import { describe, expect, it } from "vitest";
import { buildHelpReply, helpPagesNeeded, type HelpFeatures } from "@/lib/onboarding-conversation";
import { helpTopicSettingsPath } from "@/lib/help-links";
import { HELP_FEATURES } from "@/lib/pipeline/types";
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
  paymentCollection: false,
};
const FEES: HelpFeatures = { ...BASE, paymentCollection: true };
const OFF: HelpFeatures = { ...BASE, attendance: false };
const SIGNED = "https://mt.example/r/signed";
const PUBLIC = "https://matchtime.ai";
const DASH = /[–—]/;

const EN_BODY =
  `👥 *Bringing a friend: how it works*\n` +
  `Say in the group that a friend is coming (for example *my friend Ali is coming*), no need to tag me. I react ✉️ and DM you a personal link to forward to them.\n` +
  `Your friend opens it, fills in their details and sends the WhatsApp code: that puts them in the game (on the bench if it's full) and in the MatchTime player pool. The link works until kick-off.\n` +
  `If your friend can't make it, they can message me on WhatsApp or tap the button on their page to give the place back.`;
const EN_FEE = `💷 Your friend pays the match fee like any guest, after the game (in a monthly club, as a pay as you go player).`;
const EN_ADMIN = `When an organiser adds someone, they go straight on the list.`;

const TR_BODY =
  `👥 *Arkadaş getirmek nasıl çalışır*\n` +
  `Bir arkadaşınızın geleceğini grupta söyleyin (örneğin *arkadaşım Ali de geliyor*), beni etiketlemenize gerek yok. ✉️ ile tepki verir, ona iletmeniz için size özelden kişisel bir bağlantı gönderirim.\n` +
  `Arkadaşınız bağlantıyı açar, bilgilerini doldurur ve WhatsApp kodunu gönderir: böylece maça girer (kadro doluysa yedeğe) ve MatchTime oyuncu havuzuna katılır. Bağlantı maç başlayana kadar geçerlidir.\n` +
  `Arkadaşınız gelemezse bana WhatsApp'tan yazarak ya da sayfasındaki düğmeye basarak yerini geri verebilir.`;
const TR_FEE = `💷 Arkadaşınız maç ücretini her misafir gibi maçtan sonra öder (aylık kulüplerde maç başı ödeyen oyuncu olarak).`;
const TR_ADMIN = `Bir organizatör birini eklediğinde doğrudan listeye girer.`;

describe("the friend topic is one of the help topics", () => {
  it("the question extractor can name it", () => {
    expect(HELP_FEATURES).toContain("friend");
  });

  it("its settings link is the attendance card (the friend link needs attendance on)", () => {
    expect(helpTopicSettingsPath("friend")).toBe("/admin/settings#attendance");
    expect(helpPagesNeeded("friend", "admin")).toEqual(["topic"]);
    expect(helpPagesNeeded("friend", "player")).toEqual([]);
  });
});

describe("help friend, attendance on", () => {
  it("English, the players' group and a player's DM: the friend link, exactly", () => {
    for (const audience of ["group", "player"] as const) {
      expect(buildHelpReply("friend", BASE, "en", { audience })).toBe(EN_BODY);
    }
  });

  it("Turkish, the players' group and a player's DM: exactly", () => {
    for (const audience of ["group", "player"] as const) {
      expect(buildHelpReply("friend", BASE, "tr", { audience })).toBe(TR_BODY);
    }
  });

  it("a club that takes match fees: the friend pays like any guest, pay as you go in a monthly club", () => {
    expect(buildHelpReply("friend", FEES, "en", { audience: "group" })).toBe(`${EN_BODY}\n${EN_FEE}`);
    expect(buildHelpReply("friend", FEES, "tr", { audience: "group" })).toBe(`${TR_BODY}\n${TR_FEE}`);
  });

  it("an organiser (HQ or his DM) also hears that his own add is direct, and gets no link", () => {
    expect(buildHelpReply("friend", FEES, "en", { audience: "admin", links: { topic: SIGNED } })).toBe(`${EN_BODY}\n${EN_FEE}\n\n${EN_ADMIN}`);
    expect(buildHelpReply("friend", BASE, "tr", { audience: "admin" })).toBe(`${TR_BODY}\n\n${TR_ADMIN}`);
  });

  it("organisers mode and organiser picks change nothing: the friend link works the same", () => {
    for (const f of [{ ...BASE, organisersAnnounce: true }, { ...BASE, organiserPicks: true }]) {
      expect(buildHelpReply("friend", f, "en", { audience: "group" })).toBe(EN_BODY);
    }
  });
});

describe("help friend, attendance off", () => {
  it("the players' group: off, how it works, and how an admin switches attendance on (public link)", () => {
    const r = buildHelpReply("friend", OFF, "en", { audience: "group" });
    expect(r.startsWith(`${t("en").onbHelpOffLead()}\n\n${EN_BODY}\n\n`)).toBe(true);
    expect(r).toContain(`an admin turns on *Attendance tracking* on the settings page:\n${PUBLIC}/admin/settings#attendance`);
    expect(r).toContain("DM me *help friend*");
    expect(r).not.toContain("/r/");
  });

  it("an organiser's DM: the signed-in link to the attendance card", () => {
    const r = buildHelpReply("friend", OFF, "en", { audience: "admin", links: { topic: SIGNED } });
    expect(r).toContain(`🔧 To switch it on, turn on *Attendance tracking* here:\n${SIGNED}`);
    expect(r).toContain(EN_ADMIN);
  });

  it("a player's DM: ask the organiser, no link; Turkish too", () => {
    const r = buildHelpReply("friend", OFF, "en", { audience: "player" });
    expect(r).toContain("Your organiser can switch this on");
    expect(r).not.toMatch(/https?:\/\//);
    const tr = buildHelpReply("friend", OFF, "tr", { audience: "group" });
    expect(tr.startsWith(`${t("tr").onbHelpOffLead()}\n\n${TR_BODY}\n\n`)).toBe(true);
    expect(tr).toContain("yardım arkadaş");
  });
});

describe("the bare help menu lists the friend topic", () => {
  it("English and Turkish, one short line, while attendance is on", () => {
    expect(buildHelpReply(null, BASE, "en")).toContain(`   • *@Match Time help friend*: bringing a friend`);
    expect(buildHelpReply(null, BASE, "tr")).toContain(`   • *@Match Time yardım arkadaş*, arkadaş getirmek`);
  });

  it("right after squad and availability", () => {
    const menu = buildHelpReply(null, BASE, "en");
    expect(menu.indexOf("help availability")).toBeLessThan(menu.indexOf("help friend"));
    expect(menu.indexOf("help friend")).toBeLessThan(menu.indexOf("help teams"));
  });

  it("not while attendance is off; an organiser hears it is off", () => {
    expect(buildHelpReply(null, OFF, "en")).not.toContain("help friend");
    expect(buildHelpReply(null, OFF, "en", { audience: "admin" })).toMatch(/bringing a friend/);
  });
});

describe("house rules", () => {
  it("no em or en dashes, no slashes as separators, bench and yedek, never a waiting list", () => {
    for (const lang of ["en", "tr"] as const) {
      for (const f of [BASE, FEES, OFF]) {
        for (const audience of ["group", "player", "admin"] as const) {
          const r = buildHelpReply("friend", f, lang, { audience });
          expect(r).not.toMatch(DASH);
          expect(r.replace(/https?:\/\/\S+/g, "")).not.toMatch(/ \/ |\w\/\w/);
          expect(r).not.toMatch(/waiting list|bekleme listesi/i);
          expect(r).toMatch(lang === "en" ? /bench/ : /yedeğe/);
        }
      }
    }
  });
});
