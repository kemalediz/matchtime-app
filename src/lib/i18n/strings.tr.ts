/**
 * THE TURKISH STRING TABLE. The owner (a native speaker) reviews THIS
 * file, and only this file, when Turkish copy changes.
 *
 * ── PHASE 0: NOTHING IS TRANSLATED YET ──────────────────────────────
 *
 * Every key is present (the `: Strings` annotation makes a missing one a
 * `tsc` error) and every entry is the English one, wrapped in
 * `untranslated()` so a grep for `untranslated(` lists exactly what is
 * still owed. The owner writes the Turkish in Phase 2; nothing in this
 * file is a translation and nothing here is reviewed as one.
 *
 * ── CONVENTIONS FOR THE TURKISH (from the design, section 4.4) ──────
 *
 *   - WhatsApp formatting, not markdown: bold is `*single asterisks*`,
 *     no headings, no backticks except for literal commands the user
 *     should type (`swap X Y` stays a backtick because it is typed).
 *   - Keep the emoji the English copy uses in the same positions
 *     (📋, 🙏, ✅, 🥁, ⚽, 🪑); the group learns them once and they are
 *     language-free.
 *   - Register: warm-informal. "sen" in DMs (one person to one person),
 *     plural imperatives in the group ("yazın", "haber verin"). No
 *     "abi", no "beyler": that is the players' register with each
 *     other, and it assumes a gender the roster may not have.
 *   - Interpolated values (names, venues, dates, counts) sit where
 *     Turkish needs no suffix on them: "Yer: Sim Arena", "Maç: Salı 15
 *     Eylül", not "Sim Arena'da". Where a suffix is unavoidable the
 *     function computes it from the last vowel (a small, tested helper),
 *     never a fixed guess.
 *   - No time-of-day greeting and no send-time stamp: no "Günaydın",
 *     "İyi akşamlar", "17:00 güncellemesi".
 *   - No em dashes and no en dashes (house style; the hygiene test in
 *     `__tests__/strings.test.ts` enforces it for this file).
 *   - Dotted and dotless i: any lower-casing of Turkish text for
 *     matching must use `toLocaleLowerCase("tr")`.
 *
 * See MDs/multi-language-design-2026-09-16.md sections 4.2 and 4.4.
 */
import { en } from "./strings.en";
import type { Strings } from "./t";

/**
 * Marks an entry that still returns the English. It changes nothing at
 * runtime; it exists so the unfinished entries are greppable and so a
 * reviewer can see at a glance which lines carry real Turkish.
 */
function untranslated<T>(entry: T): T {
  return entry;
}

export const tr: Strings = {
  probe: untranslated(en.probe),

  // ── onboarding (self-setup) ──────────────────────────────────────────
  // Written 2026-09-17 for the first Turkish group. Register: the intro
  // and the how-to block speak to the whole group (plural imperatives);
  // the consent ack, the admins question and the DMs speak to the one
  // person who answered ("sen"). Interpolated names sit where no suffix
  // is needed. No dashes, no time-of-day greetings. The owner reviews
  // this block; nothing here has been reviewed yet.

  onbIntro: (): string =>
    `👋 Merhaba, ben *MatchTime*. Futbol grubunun haftalık işlerini üstlenirim: kim var kim yok, dengeli takımlar, hatırlatmalar.\n\n` +
    `*Bu grubu ben yöneteyim mi?* Organizatör kimse *EVET* yazsın, iki kısa soru soracağım. ` +
    `İstemiyorsanız beni görmezden gelin, sessiz kalırım. 🤐`,

  onbAdminQuestion: (): string =>
    `Bu grubu başka kim yönetiyor? İsim ve numara yaz (veya @etiketle), ` +
    `birkaç kişiyi virgülle ayırabilirsin. Tek sen isen *sadece ben* yaz.`,

  onbConsentAck: (p: { adminCaptured: boolean; adminQuestion: string }): string =>
    `${p.adminCaptured ? "Tamam, yönetici sensin 🎽" : "Tamam ✅"} ${p.adminQuestion}`,

  onbAdminsAck: (p: { added: number; detailsQuestion: string }): string =>
    (p.added > 0
      ? `Tamam, yayına geçince ${p.added === 1 ? "o yöneticiyi" : `o ${p.added} yöneticiyi`} ekleyeceğim. `
      : "") + p.detailsQuestion,

  onbDetailsQuestion: (p: { missing: Array<"day" | "time" | "venue"> }): string => {
    if (p.missing.length === 3) {
      return (
        "Bir şey daha lazım: *ne zaman ve nerede oynuyorsunuz?* Tek mesaj yeter, " +
        "örneğin: _\"Cuma 21:30, Sim Arena, 7'ye 7\"_."
      );
    }
    const parts: string[] = [];
    if (p.missing.includes("day")) parts.push("hangi *gün* oynadığınız");
    if (p.missing.includes("time")) parts.push("*başlangıç saati* (örn. 21:30)");
    if (p.missing.includes("venue")) parts.push("*saha* adı");
    return `Az kaldı, bir de ${parts.join(" ve ")} lazım.`;
  },

  onbCompletionPost: (p: {
    groupName: string | null;
    onLabels: string[];
    dayName: string;
    kickoffTime: string | null;
    venue: string | null;
    weekly: boolean;
    rosterCount: number;
    adminsAdded: number;
    adminDmQueued: boolean;
    adminName: string | null;
    howToUseMe: string;
  }): string => {
    const adminName = p.adminName?.trim();
    const forGroup = p.groupName ? `*${p.groupName}* için` : "bu grup için";
    const adminLine = p.adminDmQueued
      ? `${adminName || "Yönetici"}, yönetici sayfanın özel bağlantısını sana gönderdim: oyuncu adları, puanlar ve ödemeler orada. `
      : `Bu grubu kim yönetiyorsa yönetici sayfasını istediği zaman matchtime.ai üzerinden alabilir. `;
    return (
      `✅ *Hazırız!* ${forGroup} yayındayım: *${p.onLabels.join(", ")}*.\n\n` +
      `📅 İlk maç: *${p.dayName} ${p.kickoffTime}*, yer: *${p.venue}*` +
      `${p.weekly ? ", her hafta" : ""}.\n` +
      (p.rosterCount > 0
        ? `👥 Bu gruptaki *${p.rosterCount} kişiyi* kadroya ekledim, kimseyi elle yazmanıza gerek yok.\n`
        : ``) +
      (p.adminsAdded > 0
        ? `👮 *${p.adminsAdded} yardımcı yönetici* ekledim, yönetici bağlantılarını özelden gönderdim.\n`
        : ``) +
      `\n` +
      `${adminLine}Diğer herkes: normal sohbete devam edin, oynayacağınız zaman *"varım"* yazın, gerisini ben hallederim. ⚽` +
      `\n\n*Beni nasıl kullanırsınız* 👇\n${p.howToUseMe}`
    );
  },

  onbAdminDm: (p: { groupName: string | null; url: string; payments: boolean }): string =>
    `👋 MatchTime'da ${p.groupName ? `*${p.groupName}* grubunun` : "grubunun"} yöneticisi sensin.\n\n` +
    `Yönetici sayfanın özel bağlantısı burada, oyuncu adları, puanlar` +
    `${p.payments ? ", ödemeler" : ""} ve ayarlar orada:\n${p.url}` +
    (p.payments
      ? `\n\nParayı da ben *toplayayım* mı? Yönetici sayfandan bir banka hesabı bağla, 2 dakika sürer.`
      : ``),

  onbCoAdminDm: (p: { groupName: string | null; url: string }): string =>
    `👋 MatchTime'da ${p.groupName ? `*${p.groupName}* grubuna` : "gruba"} yönetici olarak eklendin.\n\n` +
    `Yönetici sayfanın özel bağlantısı:\n${p.url}`,

  onbEnrichmentDm: (p: { messagesAnalyzed: number; groupName: string | null; playerCount: number; url: string }): string =>
    `📋 ${p.groupName ? `*${p.groupName}* grubunun` : "Grubun"} ${p.messagesAnalyzed} eski mesajını okudum ve ` +
    `${p.playerCount} oyuncu için mevki ve başlangıç puanı taslağı hazırladım.\n\n` +
    `Henüz hiçbir şey uygulanmadı, buradan inceleyip kurulumu bitir:\n${p.url}`,

  onbCancelled: (): string =>
    `Tamam, kurulumu durdurdum, sessiz kalacağım. Baştan başlamak için beni gruba yeniden ekleyin veya *@Match Time kurulum* yazın.`,

  onbFeatureLabel: (p: { key: string; englishLabel: string }): string =>
    ({
      attendance: "Yoklama",
      bench: "Yedek listesi",
      teamBalancing: "Takım kurma",
      momVoting: "Maçın adamı",
      playerRating: "Oyuncu puanları",
      reminders: "Hatırlatmalar",
      statsQa: "İstatistik cevapları",
      paymentTracking: "Ödeme takibi",
      paymentCollection: "Maç ücreti toplama",
      payByBank: "Banka ile ödeme",
      payCard: "Kart ile ödeme",
      payDirect: "Organizatöre ödeme",
    })[p.key] ?? p.englishLabel,

  onbDayName: (p: { dow: number }): string =>
    ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"][p.dow] ?? "Salı",

  onbHowToUseMe: (f: {
    attendance: boolean;
    teamBalancing: boolean;
    momVoting: boolean;
    playerRating: boolean;
    statsQa: boolean;
    reminders: boolean;
    bench: boolean;
    paymentTracking: boolean;
  }): string => {
    const lines: string[] = [];
    if (f.attendance) {
      lines.push(`✅ Kendi durumunuz için *"varım"* veya *"yokum"* yazın, beni etiketlemenize gerek yok.`);
      lines.push(`🤔 Emin değil misiniz? *"belki"* yazın, maçtan yaklaşık 24 saat önce size özelden sorarım.`);
    } else {
      lines.push(`📋 Kadro listesini yapıştırın, kimin oynadığını okurum, beni etiketlemenize gerek yok.`);
    }
    const caps: string[] = [];
    if (f.attendance) caps.push(`kim var / kaç kişiyiz`);
    if (f.teamBalancing) caps.push(`takımları kur / takımları göster`);
    if (f.statsQa) caps.push(`geçen hafta kim kazandı? / eski istatistikler`);
    lines.push(`💬 Bir şey yapmamı veya söylememi istediğinizde *@Match Time* etiketleyin:`);
    for (const c of caps) lines.push(`   • ${c}`);
    lines.push(`🤐 Diğer zamanlarda sessizim, sohbet ve şaka serbest, araya girmem.`);
    if (f.momVoting) lines.push(`🏆 Maçtan sonra kısa bir *maçın adamı* oylaması yaparım.`);
    if (f.playerRating) lines.push(`⭐ Maçtan sonra tek dokunuşla *puanlama* bağlantısını özelden gönderirim.`);
    if (f.reminders) lines.push(`⏰ Maçtan önce kadroya hatırlatma gönderirim.`);
    if (f.paymentTracking) lines.push(`💳 Kimin *ödediğini* takip ederim.`);
    lines.push(`\nBunu tekrar görmek için istediğiniz zaman *"@Match Time yardım"* yazın.`);
    return lines.join("\n");
  },

  onbHelpHead: (): string => `ℹ️ *MatchTime yardım*, açıklayabileceklerim şunlar. Beni şunlardan biriyle etiketleyin:`,

  onbHelpTopicLine: (p: { word: string; label: string }): string =>
    `   • *@Match Time yardım ${p.word}*, ${p.label}`,

  onbHelpTopicWord: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" }): string =>
    ({
      availability: "kadro",
      teams: "takımlar",
      mom: "maçın adamı",
      ratings: "puanlama",
      reminders: "hatırlatma",
      payments: "ödeme",
    })[p.topic],

  onbHelpTopicLabel: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" }): string =>
    ({
      availability: "kadro ve katılım",
      teams: "dengeli takımlar",
      mom: "maçın adamı",
      ratings: "oyuncu puanları",
      reminders: "hatırlatmalar",
      payments: "ödeme takibi",
    })[p.topic],

  onbHelpNotOn: (): string =>
    `Bu özellik bu grupta açık değil. Açık olanları görmek için *@Match Time yardım* yazın.`,

  onbHelpExplainer: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" }): string =>
    ({
      ratings:
        `⭐ *Oyuncu puanları nasıl çalışır*\n` +
        `Her maçtan sonra oynayan herkese özelden bir bağlantı gönderirim. Diğer oyunculara 10 üzerinden puan verirsiniz (kendinize veremezsiniz, puanlarınız gizli kalır).\n` +
        `Herkesin puanlarını birleştirip her oyuncu için maçtan maça güncellenen bir form puanı çıkarırım, *dengeli takımları* bununla kurarım. Ne kadar çok kişi puan verirse takımlar o kadar adil olur.\n` +
        `Bağlantı maçın ertesi günü gelir. Kendi puanlarınız için istediğiniz zaman *@Match Time istatistiklerim* yazın.`,
      teams:
        `🟥🟦 *Dengeli takımlar nasıl çalışır*\n` +
        `Kadro netleşince herhangi bir yönetici *@Match Time takımları kur* yazar, ben de form puanlarına göre herkesi iki dengeli takıma bölerim.\n` +
        `Kadroları doğrudan gruba yazarım. Bir eşleşmeyi beğenmediniz mi? İki oyuncuyu *değiştirmemi* isteyin (örn. _"@Match Time Ali ile Can'ı değiştir"_) veya istediğiniz zaman *"@Match Time takımları göster"* yazın.\n` +
        `Hazır olunca *@Match Time takımları kur* yazmanız yeter.`,
      mom:
        `🏆 *Maçın adamı nasıl çalışır*\n` +
        `Maç bitince gruba kısa bir *maçın adamı* oylaması açarım. Herkes öne çıkan oyuncuya dokunur.\n` +
        `Oyları sayar, kazananı duyururum, sonuç herkesin sezon istatistiklerine işlenir.\n` +
        `Ayarlamanız gereken bir şey yok, oylamayı maç bitince kendim başlatırım. Kendi sayınız için *@Match Time istatistiklerim* yazın.`,
      availability:
        `⚽ *Kadro ve katılım nasıl çalışır*\n` +
        `Bir sonraki maç için grupta *varım* veya *yokum* yazmanız yeter, beni etiketlemenize gerek yok, otomatik okurum.\n` +
        `Numaralı ve güncel bir kadro listesi tutarım. Kadro dolunca sonra yazanlar sırayla *yedek* listesine girer. Emin değil misiniz? *"belki"* yazın, maçtan yaklaşık 24 saat önce özelden kesin cevabınızı sorarım.\n` +
        `Biri çıkarsa yedekleri dürterim, böylece hiç eksik kalmayız. İstediğiniz zaman *yokum* yazın, gerisini ben hallederim.`,
      reminders:
        `⏰ *Hatırlatmalar nasıl çalışır*\n` +
        `Henüz *varım* veya *yokum* demeyenleri nazikçe dürterim, sonra maçtan önce bütün kadroya hatırlatırım ki kimse unutmasın.\n` +
        `Hepsi otomatik olur, kimseyi tek tek aramanıza gerek kalmaz.`,
      payments:
        `💳 *Ödeme takibi nasıl çalışır*\n` +
        `Maç ücretini kimin ödediğini takip ederim. Organizatör ücreti belirler, ben kimin ödediğini ve kimin borcu kaldığını tek bakışta gösteririm.\n` +
        `Ödemeyenlere nazik hatırlatmalar gönderirim. Oyuncular kartla ödeyebilir, organizatör nakit ve havaleleri alındı olarak işaretleyebilir.\n` +
        `Bu yalnızca ödeme takibi açıkken çalışır. Son durum için *@Match Time kim ödemedi?* yazın.`,
    })[p.topic],
};
