/**
 * A club's own player pool switch (2026-10-28): the card and the once-ever
 * message to the admin team, in English and Turkish. The message is the
 * product owner's exact copy, and the settings it quotes are the real
 * card headings, word for word. The players' group announcement explains
 * the pool to everyone (Kemal's text, 2026-11-06).
 */
import { describe, expect, it } from "vitest";
import { poolClubSwitchCopy, type PoolClubSwitchCopy } from "@/lib/i18n/pool-club-switch";
import { poolClubShareCopy } from "@/lib/i18n/pool-club-share";
import { poolCopy } from "@/lib/i18n/pool-offer";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { t } from "@/lib/i18n/t";
import { settingInfo } from "@/lib/settings-info";

const L = { autoAsk: "https://matchtime.ai/admin/settings#pool-auto-ask", share: "https://matchtime.ai/admin/settings#pool-club-share" };
const lines = (c: PoolClubSwitchCopy): string[] => [
  c.notice("FNF", "group", L),
  c.notice("FNF", "dm", L),
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
      expect(l.replace(/https:\/\/\S+/g, "")).not.toMatch(/\w\/\w/);
      expect(l).not.toMatch(/\bfree\b/i);
      expect(l).not.toMatch(/waiting list|bekleme listesi/i);
    }
  });

  it("every Turkish line differs from the English; an unknown language is English", () => {
    EN.forEach((en, i) => expect(TR[i]).not.toBe(en));
    expect(poolClubSwitchCopy("de")).toBe(poolClubSwitchCopy("en"));
  });
});

const EN_HQ = [
  "⚽ *The MatchTime player pool is now on for FNF*",
  "Short of players? Ask MatchTime for nearby players who have joined the pool.",
  "",
  "*How to ask*",
  "Tag @Match Time here, for example:",
  "• @Match Time ask the player pool for 2 players for Thursday",
  "• @Match Time find players from partner clubs and the player pool for Thursday",
  "Only the club's organisers can ask. MatchTime then offers the place to nearby pool players by WhatsApp and tells you here when one takes it.",
  "",
  "*Other ways*",
  "• Tick *MatchTime player pool* on a match: MatchTime asks nearby pool players for that match's open places.",
  "• *Ask the player pool automatically*: on match day, if a place is still open and your bench is empty, MatchTime asks the pool by itself. Turn it on here: https://matchtime.ai/admin/settings#pool-auto-ask",
  "",
  "Want your players to know? Use *Tell your players about the player pool*: https://matchtime.ai/admin/settings#pool-club-share",
];
const TR_HQ = [
  "⚽ *MatchTime oyuncu havuzu FNF için açıldı*",
  "Oyuncu mu eksik? MatchTime'dan havuza katılmış yakındaki oyuncuları isteyin.",
  "",
  "*Nasıl istenir*",
  "Burada @Match Time etiketleyip yazın, örneğin:",
  "• @Match Time perşembe için havuzdan 2 oyuncu bul",
  "• @Match Time perşembe için partner kulüplerden ve havuzdan oyuncu bul",
  "Yalnızca kulübün organizatörleri isteyebilir. MatchTime yeri WhatsApp'tan yakındaki havuz oyuncularına önerir ve biri yeri alınca size burada haber verir.",
  "",
  "*Başka yollar*",
  "• Bir maçta *MatchTime oyuncu havuzu* kutusunu işaretleyin: MatchTime o maçtaki boş yerler için yakındaki havuz oyuncularına sorar.",
  "• *Oyuncu havuzuna kendiliğinden sor*: maç günü hâlâ boş yer varsa ve yedekte kimse yoksa MatchTime havuza kendisi sorar. Buradan açın: https://matchtime.ai/admin/settings#pool-auto-ask",
  "",
  "Oyuncularınız da bilsin mi? *Oyuncularınıza oyuncu havuzunu anlatın* kartını kullanın: https://matchtime.ai/admin/settings#pool-club-share",
];

describe("the message to the admin team", () => {
  it("leads with how to ask, exactly, in HQ (EN)", () => {
    expect(poolClubSwitchCopy("en").notice("FNF", "group", L)).toBe(EN_HQ.join("\n"));
  });

  it("leads with how to ask, exactly, in HQ (TR)", () => {
    expect(poolClubSwitchCopy("tr").notice("FNF", "group", L)).toBe(TR_HQ.join("\n"));
  });

  it("by DM it points at the club's WhatsApp group instead of 'here', and the reply is not 'here' either", () => {
    expect(poolClubSwitchCopy("en").notice("FNF", "dm", L).split("\n")).toEqual(
      EN_HQ.map((l) =>
        l === "Tag @Match Time here, for example:" ? "Tag @Match Time in your club's WhatsApp group, for example:" : l.replace("tells you here when", "tells you when"),
      ),
    );
    expect(poolClubSwitchCopy("tr").notice("FNF", "dm", L).split("\n")).toEqual(
      TR_HQ.map((l) =>
        l === "Burada @Match Time etiketleyip yazın, örneğin:" ? "Kulübünüzün WhatsApp grubunda @Match Time etiketleyip yazın, örneğin:" : l.replace("size burada haber", "size haber"),
      ),
    );
  });

  it("never claims partners are ALWAYS asked first (false when an organiser asks the pool alone)", () => {
    for (const lang of ["en", "tr"] as const) {
      const c = poolClubSwitchCopy(lang);
      for (const l of [c.notice("FNF", "group", L), c.notice("FNF", "dm", L), c.groupAnnouncement("FNF"), c.lead]) expect(l).not.toMatch(/always asked first|Önce her zaman/);
      expect(c.lead).toContain(lang === "en" ? "When MatchTime asks by itself, your partner clubs are asked first." : "MatchTime kendiliğinden sorduğunda önce partner kulüplerinize sorulur.");
      expect(settingInfo(lang, "playerPool").what.join(" ")).not.toMatch(/always asked first|Önce her zaman/);
    }
  });

  it("the how-to comes first, right after the opening line, in both versions", () => {
    for (const lang of ["en", "tr"] as const) {
      const c = poolClubSwitchCopy(lang);
      for (const msg of [c.notice("FNF", "group", L), c.notice("FNF", "dm", L)]) {
        const ls = msg.split("\n");
        expect(ls[3]).toMatch(lang === "en" ? /^\*How to ask\*/ : /^\*Nasıl istenir\*/);
        expect(ls[4]).toContain("@Match Time");
        expect(ls.filter((l) => l.startsWith("• @Match Time "))).toHaveLength(2);
      }
    }
  });

  it("quotes the real headings: the match page tick, the automatic ask card and the share card", () => {
    for (const lang of ["en", "tr"] as const) {
      const msg = poolClubSwitchCopy(lang).notice("FNF", "group", L);
      expect(msg).toContain(`*${poolCopy(lang).pool_label}*`);
      expect(msg).toContain(`*${t(lang).pauto_title}*`);
      expect(msg).toContain(`*${poolClubShareCopy(lang).title}*`);
    }
  });
});

const EN_GROUP = [
  "⚽ *FNF is now on the MatchTime player pool*",
  "The player pool is a list of local players who are happy to be asked when a game near them is a player short.",
  "",
  "*For players*",
  "Want more games? Turn on *Play elsewhere too* on your MatchTime profile. When a game near you needs a player, MatchTime sends you a WhatsApp message and you decide each time. Nothing changes for our own games.",
  "",
  "*For organisers*",
  "Short of players? Tag @Match Time here, for example:",
  "• @Match Time ask the player pool for 2 players for the next game",
  "MatchTime offers the place to nearby pool players by WhatsApp and tells the organisers when one takes it.",
];
const TR_GROUP = [
  "⚽ *FNF artık MatchTime oyuncu havuzunda*",
  "Oyuncu havuzu, yakınlarındaki bir maçta bir oyuncu eksik olduğunda kendilerine sorulmasını isteyen bölgedeki oyuncuların listesidir.",
  "",
  "*Oyuncular için*",
  "Daha çok maç mı istiyorsunuz? MatchTime profilinizde *Başka yerlerde de oyna* seçeneğini açın. Yakınınızdaki bir maça oyuncu gerektiğinde MatchTime size WhatsApp'tan yazar ve her seferinde siz karar verirsiniz. Kendi maçlarımızda hiçbir şey değişmez.",
  "",
  "*Organizatörler için*",
  "Oyuncu mu eksik? Burada @Match Time etiketleyip yazın, örneğin:",
  "• @Match Time bir sonraki maç için havuzdan 2 oyuncu bul",
  "MatchTime yeri WhatsApp'tan yakındaki havuz oyuncularına önerir ve biri yeri alınca organizatörlere haber verir.",
];

describe("the announcement in the players' group (a club with no admin group)", () => {
  it("explains the pool to everyone, players first, in Kemal's exact words (EN)", () => {
    expect(poolClubSwitchCopy("en").groupAnnouncement("FNF")).toBe(EN_GROUP.join("\n"));
  });

  it("the same in Turkish, line for line (TR)", () => {
    expect(poolClubSwitchCopy("tr").groupAnnouncement("FNF")).toBe(TR_GROUP.join("\n"));
    expect(TR_GROUP).toHaveLength(EN_GROUP.length);
    TR_GROUP.forEach((tr, i) => (EN_GROUP[i] === "" ? expect(tr).toBe("") : expect(tr).not.toBe(EN_GROUP[i])));
  });

  it("names the profile's own heading, word for word, and one tagged example for organisers", () => {
    for (const lang of ["en", "tr"] as const) {
      const msg = poolClubSwitchCopy(lang).groupAnnouncement("FNF");
      expect(msg).toContain(`*${poolPageCopy(lang).member.heading}*`);
      expect(msg.split("\n").filter((l) => l.startsWith("• @Match Time "))).toHaveLength(1);
    }
  });

  it("carries no link at all: no settings card, no share card, no sign-in page", () => {
    for (const lang of ["en", "tr"] as const) {
      const msg = poolClubSwitchCopy(lang).groupAnnouncement("FNF");
      expect(msg).not.toMatch(/https?:\/\//);
      expect(msg).not.toContain(poolClubShareCopy(lang).title);
      expect(msg).not.toContain(t(lang).pauto_title);
    }
  });

  it("never says bot or bulk", () => {
    for (const lang of ["en", "tr"] as const) expect(poolClubSwitchCopy(lang).groupAnnouncement("FNF")).not.toMatch(/\bbot\b|\bbulk\b/i);
  });
});

describe("the links", () => {
  it("point at the fixed settings anchors, and both admin versions link the automatic ask card", async () => {
    const { poolOnLinks } = await import("../club-switch");
    const links = poolOnLinks();
    expect(links.autoAsk).toMatch(/^https?:\/\/\S+\/admin\/settings#pool-auto-ask$/);
    expect(links.share).toMatch(/^https?:\/\/\S+\/admin\/settings#pool-club-share$/);
    for (const lang of ["en", "tr"] as const) {
      const c = poolClubSwitchCopy(lang);
      for (const m of [c.notice("FNF", "group", L), c.notice("FNF", "dm", L)]) {
        expect(m).toContain(L.autoAsk);
        expect(m).not.toMatch(/Admin, then Settings|Yönetim, sonra Ayarlar/);
      }
      expect(c.notice("FNF", "group", L)).toContain(L.share);
    }
  });
});

describe("the other ways (2026-10-28 readability fix)", () => {
  it("are a heading then one bullet per option, with no 'at most once per match'", () => {
    for (const lang of ["en", "tr"] as const) {
      const c = poolClubSwitchCopy(lang);
      for (const msg of [c.notice("FNF", "group", L), c.notice("FNF", "dm", L)]) {
        expect(msg).not.toMatch(/at most once per match|en fazla bir kez/);
        const ls = msg.split("\n");
        const tick = ls.findIndex((l) => l.startsWith("• ") && l.includes(`*${poolCopy(lang).pool_label}*`));
        expect(tick).toBeGreaterThan(0);
        expect(ls[tick - 1]).toMatch(/^\*.+\*$/);
        expect(ls[tick + 1]).toMatch(new RegExp(`^• \\*${t(lang).pauto_title}\\*.*${L.autoAsk.replace(/[.#]/g, "\\$&")}$`));
      }
    }
  });
});
