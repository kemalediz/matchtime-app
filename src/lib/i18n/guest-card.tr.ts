/**
 * BRINGING A GUEST BY CONTACT CARD, TURKISH (2026-11-17). Same keys as
 * `guest-card.en.ts`; see that file for the rules. Values sit where
 * Turkish needs no suffix on them ("X maçına", "X getirdi"); a name that
 * does take one is written with an apostrophe ("Abu Ayoub'u").
 */
import type { GuestCardStrings } from "./guest-card.en";

export const guestCardTr: GuestCardStrings = {
  welcome_head: (p) =>
    p.organiser ? `Merhaba${p.first ? ` ${p.first}` : ""} 👋 ${p.organiser} seni *${p.club}* maçına ekledi.` : `Merhaba${p.first ? ` ${p.first}` : ""} 👋 *${p.club}* maçına eklendin.`,
  welcome_when: (p) => `📅 ${p.when}`,
  welcome_format: (p) => `⚽ ${p.format}`,
  welcome_venue: (p) => `📍 ${p.venue}`,
  welcome_map: (p) => `🗺️ ${p.url}`,
  welcome_fee: (p) => `💷 Kişi başı ${p.amount}`,
  welcome_fee_payg: (p) => `💷 Maç başı ${p.amount}`,
  welcome_in: "Kadrodasın.",
  welcome_bench: "Kadro dolu, şimdilik yedektesin. Bir yer açılırsa sana haber veririm.",
  welcome_bench_pick: "Şimdilik yedektesin. Yedeklerden kimin oynayacağını organizatörler seçer.",
  welcome_out: "Gelemeyeceksen OUT yaz.",
  welcome_ask: "Maçla ilgili sormak istediğin bir şey olursa bana buradan yazman yeterli.",

  reply_in: (p) => `✅ ${p.name} ${p.tonight ? "bu akşamki maça" : `${p.day} maçına`} eklendi`,
  reply_bench: (p) => `✅ ${p.name} ${p.tonight ? "bu akşamki maç" : `${p.day} maçı`} için yedekte, kadro dolu`,
  reply_already_in: (p) => `${p.name} zaten ${p.tonight ? "bu akşamki maçta" : `${p.day} maçında`}`,
  reply_already_bench: (p) => `${p.name} zaten ${p.tonight ? "bu akşamki maç" : `${p.day} maçı`} için yedekte`,
  reply_dm_sent_after_add: ", detayları ona gönderdim.",
  reply_dm_sent: "Detayları ona gönderdim.",
  reply_dm_had: "Detaylar zaten onda.",
  reply_not_ours: "Bu numara zaten MatchTime'da kayıtlı, bu yüzden buraya eklenemez.",
  reply_no_number: "Bu kişide bir telefon numarası bulamadım, bu yüzden kimseyi eklemedim.",
  reply_no_name: "Adı ne? Yazarsan eklerim, örneğin *Sam Jones'u bu akşama ekle*.",
  reply_no_game: "Ekleyebileceğim yaklaşan bir maç yok.",
  reply_elsewhere: (p) => `${p.name} zaten başka bir maça misafir olarak yazılı, bu yüzden bu maça eklemedim.`,
  reply_failed: (p) => `${p.name} şu an eklenemedi. Lütfen maç sayfasından ekle.`,
  reply_ask_game: (p) =>
    `Hangi maça ekleyeyim? Sıradaki maçlar: ${p.games.length > 1 ? `${p.games.slice(0, -1).join(", ")} ve ${p.games[p.games.length - 1]}` : p.games[0]}. Günü yazman yeterli, örneğin *${p.example} maçına ekle*.`,
  reply_ask_club: (p) => `Hangi kulüpte oynayacak: ${p.clubs.map((c) => `${c} mi`).join(", ")}? Kulübün adını yazman yeterli.`,
  reply_no_country_code: "O numarayı okuyamadım. Lütfen ülke koduyla, + ile başlayarak gönder.",

  out_dm: (p) => `Tamam, seni *${p.club}* ile ${p.day} maçından çıkardım.`,
  removed_dm: (p) => `*${p.club}* organizatörleri seni ${p.day} maçından çıkardı.`,
  out_notice: (p) => `${p.name}${p.organiser ? ` (${p.organiser} getirdi)` : ""} artık ${p.day} maçına gelemiyor. Yer yeniden boş.`,
};
