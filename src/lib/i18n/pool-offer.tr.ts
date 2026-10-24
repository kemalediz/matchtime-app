/**
 * THE POOL'S OFFER COPY, TURKISH (slice L5a, 2026-10-24). The owner (a
 * native speaker) reviews this file when the Turkish changes. Same keys as
 * `pool-offer.en.ts` (the type proves it); the house rules are unit tested
 * in `__tests__/pool-offer-copy.test.ts`. "Yedek" for the bench, always.
 */
import type { PoolOfferStrings } from "./pool-offer.en";

export const poolOfferTr: PoolOfferStrings = {
  offer_head: (p) => `⚽ *${p.club}*, ${p.game} için ${p.places} oyuncu arıyor`,
  game_with_format: (p) => `${p.format} ${p.sport.toLocaleLowerCase("tr-TR")} maçı`,
  game_plain: (p) => `${p.sport.toLocaleLowerCase("tr-TR")} maçı`,
  offer_when: (p) => `📅 *${p.day}* (${p.mins} dk)`,
  distance: (p) => `sana ${p.miles} mil`,
  map: (p) => `Harita: ${p.url}`,
  style_casual: "Keyifli, dostane bir maç",
  style_competitive: "Rekabetçi bir maç",
  style_mixed: "Her seviyeden oyuncu, herkes gelebilir",
  club_weekly: (p) => `Her hafta oynayan ${p.members} kişilik düzenli bir grup`,
  club_games: (p) => `${p.members} kişilik bir grup, son 8 haftada ${p.games} maç`,
  club_size: (p) => `${p.members} kişilik bir grup`,
  fee: (p) => `💷 Maç ücreti ${p.amount}`,
  free: "💷 Ücretsiz, maç ücreti yok",
  offer_cta: (p) => `Yeri ister misin? Evet ya da hayır demek için dokun: ${p.link}`,
  footer: (p) => `Bu mesajları MatchTime oyuncu havuzuna katıldığın için alıyorsun. Durdur ya da değiştir: ${p.link}`,

  placed_in: (p) => `✅ Yerin hazır: *${p.club}*, ${p.day}, ${p.venue}.`,
  placed_bench: (p) =>
    `📝 *${p.club}* maçında yedektesin: ${p.day}, ${p.venue}. Organizatörler yedekten seçiyor, oynarsan haber vereceğim.`,
  placed_fee: (p) => `Maç ücreti ${p.amount}. Maçtan sonra ödeme bağlantısı gelecek.`,
  placed_pull_out: (p) => `Gelemeyecek misin? Yeri buradan geri bırak: ${p.link}`,

  reply_tap: (p) => `Teklife cevap vermek için bağlantıya dokun: ${p.link}`,
  reply_gone: (p) => `Teşekkürler. ${p.club} maçındaki o yer doldu. Yakınında yeni bir maç olunca yazarım.`,

  paused: (p) => `Son ${p.n} teklif cevapsız kaldığı için maç tekliflerini durdurdum. Yeniden istersen buraya dokun: ${p.link}`,

  notice_in: (p) => `🙋 MatchTime oyuncu havuzundan ${p.name}, ${p.day} maçında bir yer aldı. ${p.turnUp}`,
  notice_bench: (p) => `🙋 MatchTime oyuncu havuzundan ${p.name}, ${p.day} maçı için yedekte, seçmeniz için. ${p.turnUp}`,
  notice_out: (p) => `MatchTime oyuncu havuzundan ${p.name} artık ${p.day} maçına gelemiyor. Yer yeniden boş.`,
  turnup_new: "MatchTime'da yeni.",
  turnup_all: (p) => (p.n === 1 ? "MatchTime'da 1 maç oynadı ve geldi." : `MatchTime'da ${p.n} maç oynadı, hepsine geldi.`),
  turnup_some: (p) => `MatchTime'daki ${p.n} maçın ${p.played} tanesine geldi.`,
  notice_offer_line: (p) => `🔎 Ya da MatchTime havuzundan yakındaki oyunculara sorayım (${p.band}). Maç sayfasını açın: ${p.link}`,

  pool_label: "MatchTime oyuncu havuzu",
  band_none: "bu sahanın yakınında henüz havuz oyuncusu yok",
  band_few: "yakınınızda birkaç kişi",
  band_many: "yakınınızda 5+ kişi",
  panel_no_venue: "MatchTime havuzundan yakındaki oyunculara sormak için maç sayfasında sahanızı onaylayın.",
  panel_partners_first: "Havuz oyuncularına, yerler hâlâ boşsa, ortak kulüplerden bir saat sonra sorulur.",
  panel_asked: (p) => `Yakındaki ${p.asked} oyuncuya soruldu${p.declined > 0 ? `, ${p.declined} kişi hayır dedi` : ""}.`,
  panel_waiting: "Yakındaki oyunculara sormak için bekleniyor.",
  toast_asked: (p) => `MatchTime havuzundan yakındaki oyunculara ${p.places} kişi için soruluyor.`,
  refused_closed: "MatchTime oyuncu havuzu kulübünüz için açık değil.",
  refused_no_venue: "Önce sahanızı onaylayın: yakındaki oyuncular sahaya göre bulunur.",
  refused_too_late: "Maça çok az kaldı, şimdi yakındaki oyunculara sorulamaz.",
  refused_round_open: "Bu maç için yakındaki oyunculara zaten soruluyor.",
  refused_week_cap: "Kulübünüz bu hafta havuza zaten 3 kez sordu.",
  refused_no_places: "Doldurulacak boş yer yok.",
  refused_bad_number: (p) => `1 ile ${p.max} arasında bir sayı seçin.`,
  refused_none_near: "Bu maç için bu sahanın yakınında henüz havuz oyuncusu yok.",
  refused_generic: "Şu an yakındaki oyunculara sorulamadı. Bir dakika sonra yeniden deneyin.",

  page_title: "Sana bir maç",
  page_yes: "Evet, oynarım",
  page_no: "Hayır, teşekkürler",
  page_map: "Haritada aç",
  page_manage: "Bu mesajları durdur ya da değiştir",
  page_declined: "Haber verdiğin için teşekkürler. Yakınında yeni bir maç olunca yazarız.",
  page_gone: "Üzgünüz, bu yer doldu. Yakınında yeni bir maç olunca yazarız.",
  page_expired: "Bu teklifin süresi doldu. Yakınında yeni bir maç olunca yazarız.",
  page_invalid: "Bu bağlantı çalışmıyor. Eski olabilir ya da yanlış kopyalanmış olabilir.",
  page_off: "Bu maç iptal. Kusura bakma.",
  page_pull_out: "Artık gelemiyorum",
  page_pulled_out: "Tamam, yerin yeniden boş. Haber verdiğin için teşekkürler.",
  page_try_again: "Bir sorun oldu. Lütfen bir dakika sonra yeniden dene.",
  page_busy: "Bu kulüpte başka bir maç için zaten yerin var. O maç oynandıktan sonra yeni bir yer alabilirsin.",
  page_verify_label: "Cevap vermek için bu teklifin geldiği WhatsApp numarasının son 4 hanesini yaz",
  page_verify_wrong: "Bu haneler eşleşmiyor. Lütfen yeniden dene.",
  page_verify_locked: "Çok fazla deneme oldu. Giriş yapmak için WhatsApp mesajındaki 'Durdur ya da değiştir' bağlantısını aç, sonra bu teklifi yeniden aç.",
};
