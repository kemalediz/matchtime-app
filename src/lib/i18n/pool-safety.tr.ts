/**
 * THE POOL'S NO-SHOW, BLOCK AND REPORT COPY, TURKISH (slice L7). Same keys
 * as `pool-safety.en.ts` (a missing key is a tsc error); see that file for
 * the rules.
 */
import type { PoolSafetyStrings } from "./pool-safety.en";

export const poolSafetyTr: PoolSafetyStrings = {
  dm_paused_no_shows: (p) =>
    `Son ${p.games} maçının ${p.n} tanesine gelmediğin için maç tekliflerini durdurdum. ${p.days} gün sonra yeniden başlatabilirsin ya da şimdi bir kişinin bakmasını isteyebilirsin: ${p.link}`,
  dm_paused_reports: (p) => `MatchTime ekibi profiline bakarken maç tekliflerini durdurdum. Buradan sorabilirsin: ${p.link}`,
  dm_removed: (p) =>
    `*${p.club}* için ${p.day} maçında plan değişti: o maç için artık oyuncuya ihtiyaçları yok. Senin bir şey yapmana gerek yok.`,
  dm_resumed: (p) => `Maç teklifleri yeniden açık. Ayarların: ${p.link}`,

  mark_title: "Misafirlerin geldi mi?",
  mark_hint: (p) => `Gelmeyen bir misafiri ${p.until} saatine kadar işaretle. İşaretlemediğin misafir oynamış sayılır.`,
  mark_final: "Bu sonuçlar kesinleşti.",
  mark_turned_up: "Geldi",
  mark_no_show: "Gelmedi",
  mark_failed: "Kaydedilemedi. Sayfayı yenileyip tekrar dene.",
  result_due: "Sonuç bekleniyor",

  card_block: "Bu oyuncuya maçlarımızı bir daha önerme",
  card_blocked: "Artık maçlarınız önerilmiyor",
  card_unblock: "Maçlarımızı yeniden öner",
  card_block_hint: "Oyuncuya söylenmez.",

  report_open: "Bir sorunu bildir",
  report_label_club: "Ne oldu? Bunu yalnızca MatchTime ekibi okur. Oyuncuya söylenmez.",
  report_label_player: "Ne oldu? Bunu yalnızca MatchTime ekibi okur. Kulübe söylenmez.",
  report_send: "MatchTime'a gönder",
  report_cancel: "Vazgeç",
  report_sent: "Teşekkürler. MatchTime ekibi buna bakacak.",
  report_too_short: "Lütfen ne olduğunu biraz daha anlat.",
  report_failed: "Gönderilemedi. Sayfayı yenileyip tekrar dene.",

  record_heading: "Maçlara gelme durumun",
  record_line: (p) => `Evet dediğin ${p.games} maçın ${p.played} tanesine geldin.`,
  record_new: "Henüz maç yok.",
  paused_no_shows: (p) => `Evet dediğin bazı maçlara gelmediğin için durduruldu. Maç tekliflerini ${p.from} tarihinden itibaren yeniden başlatabilirsin.`,
  paused_no_shows_ready: "Evet dediğin bazı maçlara gelmediğin için durduruldu. Maç tekliflerini artık yeniden başlatabilirsin.",
  paused_reports: "MatchTime ekibi profiline bakarken durduruldu.",
  paused_admin: "MatchTime ekibi tarafından durduruldu.",
  review_ask: "Bir kişinin bakmasını iste",
  review_asked: "İstendi. MatchTime ekibinden biri buna bakacak.",
  clubs_heading: "Sana maç öneren kulüpler",
  clubs_hint: "Bir kulüpten maç istemiyor musun? Tekliflerini buradan durdur. Kulübe söylenmez.",
  club_block: "Bu kulübün tekliflerini durdur",
  club_blocked: "Bu kulübün teklifleri sana gelmiyor",
  club_unblock: "Tekliflerini yeniden al",
  failed: "Olmadı. Sayfayı yenileyip tekrar dene.",

  offer_block: (p) => `${p.club} maçlarını bana önerme`,
  offer_blocked: (p) => `Tamam. ${p.club} tekliflerini bir daha almayacaksın.`,
};
