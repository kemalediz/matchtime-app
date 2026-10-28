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

const lines = (c: PoolClubSwitchCopy): string[] => [
  c.notice("FNF", "group"),
  c.notice("FNF", "dm"),
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
        "When you're short of players, MatchTime can ask nearby players who have joined the pool. Your partner clubs are always asked first.",
        "Nothing is sent by itself. You can:",
        "• tick *MatchTime player pool* on a match to ask for players",
        '• ask me here, for example "@Match Time we need 2 players for Thursday"',
        "• turn on *Ask the player pool automatically* in Admin, then Settings",
        "Want your players to know? Use *Tell your players about the player pool* in Settings.",
      ].join("\n"),
    );
  });

  it("is the product owner's copy, exactly, in HQ (TR)", () => {
    expect(poolClubSwitchCopy("tr").notice("FNF", "group")).toBe(
      [
        "⚽ *MatchTime oyuncu havuzu FNF için açıldı*",
        "Oyuncu eksik olduğunda MatchTime, havuza katılmış yakındaki oyunculara sorabilir. Önce her zaman partner kulüplerinize sorulur.",
        "Hiçbir şey kendiliğinden gönderilmez. Şunları yapabilirsiniz:",
        "• bir maçta *MatchTime oyuncu havuzu* kutusunu işaretleyip oyuncu isteyin",
        '• buradan bana yazın, örneğin "@Match Time perşembe için 2 oyuncu lazım"',
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

  it("quotes the real headings: the match page tick, the automatic ask card and the share card", () => {
    for (const lang of ["en", "tr"] as const) {
      const msg = poolClubSwitchCopy(lang).notice("FNF", "group");
      expect(msg).toContain(`*${poolCopy(lang).pool_label}*`);
      expect(msg).toContain(`*${t(lang).pauto_title}*`);
      expect(msg).toContain(`*${poolClubShareCopy(lang).title}*`);
    }
  });
});
