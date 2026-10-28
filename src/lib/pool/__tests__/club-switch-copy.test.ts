/**
 * A club's own player pool switch (2026-10-28): the card and the once-ever
 * message to the admin team, in English and Turkish. The message is the
 * product owner's exact copy, and the settings it quotes are the real
 * card headings, word for word.
 */
import { describe, expect, it } from "vitest";
import { poolClubSwitchCopy, type PoolClubSwitchCopy } from "@/lib/i18n/pool-club-switch";
import { poolClubShareCopy } from "@/lib/i18n/pool-club-share";
import { poolCopy } from "@/lib/i18n/pool-offer";
import { t } from "@/lib/i18n/t";
import { settingInfo } from "@/lib/settings-info";

const lines = (c: PoolClubSwitchCopy): string[] => [
  c.notice("FNF", "group"),
  c.notice("FNF", "dm"),
  c.groupAnnouncement("FNF"),
  c.title,
  c.lead,
  c.confirmOff,
  c.savedOn,
  c.savedOff(0),
  c.savedOff(1),
  c.savedOff(2),
];
const EN = lines(poolClubSwitchCopy("en"));
const TR = lines(poolClubSwitchCopy("tr"));

describe("house rules", () => {
  it("no em or en dash, no slash between words, never free, never a waiting list", () => {
    for (const l of [...EN, ...TR]) {
      expect(l).not.toMatch(/[—–]/);
      expect(l).not.toMatch(/\w\/\w/);
      expect(l).not.toMatch(/\bfree\b/i);
      expect(l).not.toMatch(/waiting list|bekleme listesi/i);
    }
  });

  it("every Turkish line differs from the English; an unknown language is English", () => {
    EN.forEach((en, i) => expect(TR[i]).not.toBe(en));
    expect(poolClubSwitchCopy("de")).toBe(poolClubSwitchCopy("en"));
  });
});

describe("the message to the admin team", () => {
  it("is the product owner's copy, exactly, in HQ (EN)", () => {
    expect(poolClubSwitchCopy("en").notice("FNF", "group")).toBe(
      [
        "⚽ *The MatchTime player pool is now on for FNF*",
        "When you're short of players, MatchTime can ask nearby players who have joined the pool. When MatchTime asks by itself, your partner clubs are asked first.",
        "Nothing is sent by itself. You can:",
        "• tick *MatchTime player pool* on a match to ask for players",
        '• ask me here, for example "@Match Time ask the player pool for 2 players for Thursday"',
        "• turn on *Ask the player pool automatically* in Admin, then Settings",
        "Want your players to know? Use *Tell your players about the player pool* in Settings.",
      ].join("\n"),
    );
  });

  it("is the product owner's copy, exactly, in HQ (TR)", () => {
    expect(poolClubSwitchCopy("tr").notice("FNF", "group")).toBe(
      [
        "⚽ *MatchTime oyuncu havuzu FNF için açıldı*",
        "Oyuncu eksik olduğunda MatchTime, havuza katılmış yakındaki oyunculara sorabilir. MatchTime kendiliğinden sorduğunda önce partner kulüplerinize sorulur.",
        "Hiçbir şey kendiliğinden gönderilmez. Şunları yapabilirsiniz:",
        "• bir maçta *MatchTime oyuncu havuzu* kutusunu işaretleyip oyuncu isteyin",
        '• buradan bana yazın, örneğin "@Match Time perşembe için havuzdan 2 oyuncu bul"',
        "• Yönetim, sonra Ayarlar'da *Oyuncu havuzuna kendiliğinden sor* seçeneğini açın",
        "Oyuncularınız da bilsin mi? Ayarlar'daki *Oyuncularınıza oyuncu havuzunu anlatın* kartını kullanın.",
      ].join("\n"),
    );
  });

  it("by DM it points at the club's WhatsApp group instead of 'here' (a pool ask by DM is not understood)", () => {
    for (const lang of ["en", "tr"] as const) {
      const group = poolClubSwitchCopy(lang).notice("FNF", "group").split("\n");
      const dm = poolClubSwitchCopy(lang).notice("FNF", "dm").split("\n");
      expect(dm.length).toBe(group.length);
      const diff = dm.filter((l, i) => l !== group[i]);
      expect(diff).toHaveLength(1);
      expect(diff[0]).toMatch(lang === "en" ? /your club's WhatsApp group/ : /kulübünüzün WhatsApp grubunda/);
    }
  });

  it("the DM version gives the same example, in the club's WhatsApp group", () => {
    expect(poolClubSwitchCopy("en").notice("FNF", "dm")).toContain('• ask me in your club\'s WhatsApp group, for example "@Match Time ask the player pool for 2 players for Thursday"');
    expect(poolClubSwitchCopy("tr").notice("FNF", "dm")).toContain('• kulübünüzün WhatsApp grubunda bana yazın, örneğin "@Match Time perşembe için havuzdan 2 oyuncu bul"');
  });

  it("never claims partners are ALWAYS asked first (false when an organiser asks by hand): the card and the info say when", () => {
    for (const lang of ["en", "tr"] as const) {
      const c = poolClubSwitchCopy(lang);
      for (const l of [c.notice("FNF", "group"), c.notice("FNF", "dm"), c.lead]) {
        expect(l).not.toMatch(/always asked first|Önce her zaman/);
        expect(l).toContain(lang === "en" ? "When MatchTime asks by itself, your partner clubs are asked first." : "MatchTime kendiliğinden sorduğunda önce partner kulüplerinize sorulur.");
      }
      expect(settingInfo(lang, "playerPool").what.join(" ")).not.toMatch(/always asked first|Önce her zaman/);
    }
  });

  it("quotes the real headings: the match page tick, the automatic ask card and the share card", () => {
    for (const lang of ["en", "tr"] as const) {
      const msg = poolClubSwitchCopy(lang).notice("FNF", "group");
      expect(msg).toContain(`*${poolCopy(lang).pool_label}*`);
      expect(msg).toContain(`*${t(lang).pauto_title}*`);
      expect(msg).toContain(`*${poolClubShareCopy(lang).title}*`);
    }
  });
});

describe("the announcement in the players' group (a club with no admin group)", () => {
  it("is worded for the whole group, exactly (EN)", () => {
    expect(poolClubSwitchCopy("en").groupAnnouncement("FNF")).toBe(
      [
        "⚽ *The MatchTime player pool is now on for FNF*",
        "When the club is short of players, MatchTime can ask nearby players who have joined the pool. When MatchTime asks by itself, partner clubs are asked first.",
        "Only the club's organisers can ask the pool, and nothing is sent until they do. Organisers can:",
        '• ask me here, for example "@Match Time ask the player pool for 2 players for Thursday"',
        "• tick *MatchTime player pool* on a match",
        "• turn on *Ask the player pool automatically* in Admin, then Settings",
      ].join("\n"),
    );
  });

  it("is worded for the whole group, exactly (TR)", () => {
    expect(poolClubSwitchCopy("tr").groupAnnouncement("FNF")).toBe(
      [
        "⚽ *MatchTime oyuncu havuzu FNF için açıldı*",
        "Kulüpte oyuncu eksik olduğunda MatchTime, havuza katılmış yakındaki oyunculara sorabilir. MatchTime kendiliğinden sorduğunda önce partner kulüplere sorulur.",
        "Havuza yalnızca kulübün organizatörleri sorabilir ve onlar istemedikçe hiçbir şey gönderilmez. Organizatörler:",
        '• buradan bana yazabilir, örneğin "@Match Time perşembe için havuzdan 2 oyuncu bul"',
        "• bir maçta *MatchTime oyuncu havuzu* kutusunu işaretleyebilir",
        "• Yönetim, sonra Ayarlar'da *Oyuncu havuzuna kendiliğinden sor* seçeneğini açabilir",
      ].join("\n"),
    );
  });

  it("quotes the real headings, and never points players at the share card", () => {
    for (const lang of ["en", "tr"] as const) {
      const msg = poolClubSwitchCopy(lang).groupAnnouncement("FNF");
      expect(msg).toContain(`*${poolCopy(lang).pool_label}*`);
      expect(msg).toContain(`*${t(lang).pauto_title}*`);
      expect(msg).not.toContain(poolClubShareCopy(lang).title);
      expect(msg).not.toMatch(/always asked first|Önce her zaman/);
    }
  });
});
