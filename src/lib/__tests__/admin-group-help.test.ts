/**
 * "WHAT CAN YOU DO?" IN A CLUB'S ADMIN GROUP (2026-10-15; asked in any
 * words since 2026-10-16): the answer.
 *
 * Asking for it, and every request its examples show, is read by the
 * shared router (live check in the PR). The STRUCTURED lines (PAID, a pick
 * from the numbered list, a pasted list) are still read deterministically,
 * so those are fed here to the reader that takes them.
 */
import { describe, expect, it } from "vitest";
import { buildHqHelp, hqHelpGates } from "@/lib/admin-group-help";
import { readCollectorReply } from "@/lib/__tests__/fixtures/monthly-legacy";
import { HQ_SQUAD_READER_SYSTEM } from "@/lib/hq-squad-reader-prompt";
import { PICK_READER_SYSTEM } from "@/lib/organiser-pick-reader-prompt";

const ALL = { squad: true, graphics: true, picks: true, paid: true };

describe("buildHqHelp, English", () => {
  it("a live weekly club whose organisers pick (FNF): the whole list", () => {
    expect(buildHqHelp({ lang: "en", squad: true, graphics: true, picks: true, paid: false })).toBe(
      [
        `🛠️ *MatchTime in your admin group*`,
        `Just ask here in your own words. No need to tag me, except to make new teams, for the poster or team sheet picture, or to cancel a match or put it back on. For example:`,
        ``,
        `📋 *Paste the whole squad list*: I show you what would change, and *YES* within 30 minutes applies it.`,
        `✏️ *"put Bilal in"*, *"Sam can't make it"*, *"Tom to the bench"*: changes to the squad.`,
        `🟥🟦 *"show me the teams"*: the teams as they stand. *"@Match Time make the teams"*, *"@Match Time shuffle them again"*: new teams.`,
        `↩️ Reply to one of my earlier team sheets with *"use these"*, or paste the two teams: I bring those teams back for your *YES*.`,
        `🔁 *"swap Sam and Alex"*, *"move Sam to the other team"*: changes to the teams.`,
        `✅ *YES* (or reply YES to my message): make the proposed teams final.`,
        `📣 *"ask the group if anyone can play"*: when a place is open, I ask in the main chat.`,
        `❌ *"@Match Time cancel Friday"*, *"@Match Time it's back on"*: call the next match off or back on, and I tell the players' group.`,
        `🖼️ *"@Match Time send the poster"*, *"@Match Time team sheet please"*: the list or the teams as a graphic, ready to forward.`,
        `🙋 When I ask you to pick who plays, reply with the numbers or names from my list, or *ALL* or *NONE*.`,
        ``,
        `ℹ️ Ask me how any part works, and how to switch it on or off, in your own words: for example *how do partner clubs work?* or *where are the settings?*`,
        `Ask *what can you do?* here any time to see this again.`,
      ].join("\n"),
    );
  });

  it("a monthly club: no weekly squad commands, the collector's PAID line instead", () => {
    const out = buildHqHelp({ lang: "en", squad: false, graphics: true, picks: false, paid: true });
    expect(out).toContain(`💷 *PAID ALL*, *PAID 1 3* or *PAID NONE*: the money collector's answer to my list of payment claims.`);
    expect(out).not.toContain("Paste the whole squad list");
    expect(out).not.toContain("shuffle them again");
    expect(out).not.toContain("pick who plays");
    expect(out).toContain("send the poster");
    expect(out).toContain("Just ask here in your own words. No need to tag me. For example:");
  });

  it("first-come club: no pick line", () => {
    expect(buildHqHelp({ lang: "en", squad: true, graphics: true, picks: false, paid: false })).not.toContain("pick who plays");
  });
});

describe("buildHqHelp, Turkish", () => {
  it("the whole list", () => {
    expect(buildHqHelp({ lang: "tr", ...ALL })).toBe(
      [
        `🛠️ *Yönetici grubunda MatchTime*`,
        `Burada kendi cümlelerinizle sorun. Beni etiketlemenize gerek yok; yalnızca yeni takımlar kurmak, afiş ya da takım listesi görseli için ya da maçı iptal etmek veya yeniden açmak için etiketleyin. Örneğin:`,
        ``,
        `📋 *Kadro listesinin tamamını yapıştırın*: neyin değişeceğini gösteririm, 30 dakika içinde *EVET* yazarsanız uygularım.`,
        `✏️ *"Bilal'i ekle"*, *"Sam gelemiyor"*, *"Tom yedek"*: kadroda değişiklik.`,
        `🟥🟦 *"takımları göster"*: takımlar şu anki halleriyle. *"@Match Time takımları kur"*, *"@Match Time yeniden karıştır"*: yeni takımlar.`,
        `↩️ Önceki takım listelerimden birine *"bunları kullan"* diye yanıt verin ya da iki takımı yapıştırın: o takımları *EVET*'iniz için geri getiririm.`,
        `🔁 *"Sam ile Alex'i değiştir"*, *"Sam'i diğer takıma al"*: takımlarda değişiklik.`,
        `✅ *EVET* (ya da mesajıma EVET diye cevap verin): önerilen takımları kesinleştiririm.`,
        `📣 *"gruba sor, oynayabilecek var mı"*: boş yer varsa ana grupta sorarım.`,
        `❌ *"@Match Time cuma maçını iptal et"*, *"@Match Time maç yapılıyor"*: sıradaki maçı iptal ederim ya da yeniden açarım, oyuncu grubuna da haber veririm.`,
        `🖼️ *"@Match Time posteri gönder"*, *"@Match Time takım listesi görseli"*: listeyi ya da takımları görsel olarak, iletmeye hazır.`,
        `🙋 Kimin oynayacağını seçmenizi istediğimde listemdeki numaraları ya da isimleri, veya *HEPSİ* ya da *HİÇBİRİ* yazın.`,
        `💷 *ÖDENDİ HEPSİ*, *ÖDENDİ 1 3* ya da *ÖDENDİ YOK*: parayı toplayan kişinin ödeme bildirimleri listeme cevabı.`,
        ``,
        `ℹ️ Herhangi bir bölümün nasıl çalıştığını, nasıl açılıp kapatıldığını kendi cümlelerinizle sorun: örneğin *partner kulüpler nasıl çalışır?* ya da *ayarlar nerede?*`,
        `Bunu tekrar görmek için burada istediğiniz zaman *neler yapabilirsin?* diye sorun.`,
      ].join("\n"),
    );
  });
});

describe("the player pool line (2026-10-28, decision log H.1)", () => {
  it("listed only when the pool is open for a weekly club; EN and TR, no dash", () => {
    const en = buildHqHelp({ lang: "en", squad: true, graphics: true, picks: false, paid: false, pool: true });
    expect(en).toContain(`🌍 *"ask the player pool for 2 players"*: when a place is open, I ask nearby players from the MatchTime player pool.`);
    const tr = buildHqHelp({ lang: "tr", squad: true, graphics: true, picks: false, paid: false, pool: true });
    expect(tr).toContain(`🌍 *"havuzdan 2 oyuncu iste"*: boş yer varsa MatchTime oyuncu havuzundaki yakın oyunculara sorarım.`);
    for (const out of [en, tr]) expect(out).not.toMatch(/[—–]/);
    expect(buildHqHelp({ lang: "en", squad: true, graphics: true, picks: false, paid: false })).not.toContain("player pool");
    // A monthly club has no weekly ask, so no line even when asked for.
    expect(buildHqHelp({ lang: "en", squad: false, graphics: true, picks: false, paid: true, pool: true })).not.toContain("player pool");
  });
});

describe("free places (2026-10-16)", () => {
  it("a club that takes match fees gets the free-place line, EN and TR; one that does not, nothing", () => {
    const gates = (o: Parameters<typeof hqHelpGates>[0]) => hqHelpGates(o);
    expect(gates({ squadMode: "weekly", paymentCollectionEnabled: true }).free).toBe(true);
    expect(gates({ squadMode: "weekly", paymentTrackingEnabled: true }).free).toBe(true);
    expect(gates({ squadMode: "weekly" }).free).toBe(false);
    expect(buildHqHelp({ lang: "en", ...ALL, free: true })).toContain(
      `🎁 *"Bilal is free this week"*: a free place, so no pay link and no reminders to pay.`,
    );
    expect(buildHqHelp({ lang: "tr", ...ALL, free: true })).toContain(
      `🎁 *"Bilal bu hafta ücretsiz"*: ücretsiz yer, ödeme linki ve ödeme hatırlatması gitmez.`,
    );
    expect(buildHqHelp({ lang: "en", ...ALL })).not.toContain("free place");
  });
});

describe("house rules", () => {
  it("no em or en dashes, no greeting, no phone number", () => {
    for (const lang of ["en", "tr"]) {
      const out = buildHqHelp({ lang, ...ALL, free: true });
      expect(out).not.toMatch(/[—–]/);
      expect(out).not.toMatch(/good (morning|afternoon|evening)|günaydın|iyi akşamlar/i);
      expect(out).not.toMatch(/\+?\d{10,}/);
    }
  });
});

describe("every STRUCTURED reply the help quotes is one the admin group really takes", () => {
  it("PAID (month-payment-rules.ts readCollectorReply)", () => {
    expect(readCollectorReply("PAID ALL")).toMatchObject({ kind: "all" });
    expect(readCollectorReply("PAID 1 3")).not.toBeNull();
    expect(readCollectorReply("PAID NONE")).not.toBeNull();
    expect(readCollectorReply("ÖDENDİ HEPSİ")).toMatchObject({ kind: "all" });
    expect(readCollectorReply("ÖDENDİ 1 3")).not.toBeNull();
    expect(readCollectorReply("ÖDENDİ YOK")).not.toBeNull();
  });

  it("ALL / NONE to a pick are read by the pick reader, a model (organiser-pick-reader-prompt.ts, 2026-10-30)", () => {
    expect(PICK_READER_SYSTEM).toContain(`"all" | "hepsi": all.`);
    expect(PICK_READER_SYSTEM).toContain(`"none", "nobody", "leave it" | "hiçbiri", "kimse": none.`);
  });

  it("a pasted list is read as the squad by the HQ squad reader, a model (hq-squad-reader-prompt.ts, 2026-10-29)", () => {
    expect(HQ_SQUAD_READER_SYSTEM).toContain(`"squad": the whole list of who plays the next game`);
  });

  it("asking what MatchTime can do is none of those structured replies", () => {
    for (const text of ["help", "what can you do?", "neler yapabilirsin?"]) {
      expect(readCollectorReply(text)).toBeNull();
    }
  });
});
