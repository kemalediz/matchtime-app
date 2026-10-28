/** A club's share post in Turkish (growth slice G3). See `pool-club-share.ts`. */
import type { PoolClubShareCopy } from "./pool-club-share";
import { trLocative } from "./tr-locative";

export const POOL_CLUB_SHARE_TR: PoolClubShareCopy = {
  post: (url) =>
    [
      "⚽ *MatchTime oyuncu havuzu*",
      "Havuzdaki oyunculara, yakınlarındaki bir takımın bir oyuncusu eksik olduğunda WhatsApp'tan yazılır; her seferinde kendileri karar verir.",
      "",
      "Daha çok maç mı istiyorsun? MatchTime profilinde *Başka yerlerde de oyna* bölümünü aç. Sonra arkadaşlarınla paylaşacağın kendi bağlantın olur.",
      "",
      `Maç arayan birini tanıyor musun? Buradan kaydolabilir: ${url}`,
    ].join("\n"),
  title: "Oyuncularınıza oyuncu havuzunu anlatın",
  lead: "MatchTime bunu oyuncu grubunuza bir kez paylaşabilir; oyuncularınızı havuza katılmaya ve arkadaşlarını getirmeye davet eder. Kimsenin adı geçmez ve yalnızca bir kez gönderilebilir.",
  previewLabel: "Paylaşılacak mesaj",
  send: "Oyuncu grubuna gönder",
  sending: "Gönderiliyor...",
  queued: "Gönderildi. Bir iki dakika içinde oyuncu grubunuzda olacak.",
  held: (when) => `Gönderildi. Sessiz saatleriniz bitince, ${when} saatinde paylaşılacak.`,
  queuedSoon: "Sırada: bir iki dakika içinde gönderilecek.",
  queuedToday: (time) => `Sırada: ${trLocative(time)} gönderilecek.`,
  queuedOn: (date, time) => `Sırada: ${date}, ${trLocative(time)} gönderilecek.`,
  sentOn: (date) => `Oyuncu grubunuza ${trLocative(date)} gönderildi.`,
  noGroup: "Önce oyuncularınızın WhatsApp grubunu MatchTime'a bağlayın, sonra bunu gönderebilirsiniz.",
  failed: "Gönderilemedi. Lütfen tekrar deneyin.",
};
