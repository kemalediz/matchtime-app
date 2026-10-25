/**
 * JOINING A CLUB'S GROUP, TURKISH (local player pool L8). Every key of
 * `pool-invite.en.ts` (the type proves it); the house rules are unit tested
 * in `__tests__/pool-invite-copy.test.ts`.
 */
import type { PoolInviteStrings } from "./pool-invite.en";

export const poolInviteTr: PoolInviteStrings = {
  // ── To the guest ──────────────────────────────────────────────────────
  ask_after_game: (p) =>
    `${p.day} günü *${p.club}* ile oynadığın maç güzel geçti mi? Sonraki maçlar için gruplarına katılmak ister misin? Buradan yanıtla: ${p.link}`,
  ask_organiser: (p) => `*${p.club}* sonraki maçlar için seni gruplarında görmek istiyor. Katılmak ister misin? Buradan yanıtla: ${p.link}`,
  link_dm: (p) => `🎉 *${p.club}* grubuna hoş geldin. WhatsApp grubuna buradan katıl: ${p.link}`,
  closed_dm: (p) =>
    `Evet dediğin için teşekkürler. *${p.club}* şu anda gruplarına yeni oyuncu almıyor. Yakınındaki maçları MatchTime üzerinden almaya devam edebilirsin.`,

  // ── To the organisers ─────────────────────────────────────────────────
  notice_wants_join: (p) =>
    `🙋 ${p.name}, ${p.day} günü sizinle misafir olarak oynadı ve grubunuza katılmak istiyor. Grubun davet bağlantısını göndermek için kartındaki Davet bağlantısını gönder düğmesine dokunun: ${p.link}`,
  notice_wants_join_hq: (p) =>
    `🙋 ${p.name}, ${p.day} günü sizinle misafir olarak oynadı ve grubunuza katılmak istiyor. Grubun davet bağlantısını göndermek için burada EVET yazın ya da kartındaki Davet bağlantısını gönder düğmesine dokunun: ${p.link}`,
  /** The guest when he has no name on MatchTime. */
  notice_someone: "Bir misafir",
  hq_link_sending: (p) => `✅ ${p.name} kişisine oyuncu grubunun davet bağlantısını gönderiyorum.`,
  hq_link_waiting: (p) =>
    `✅ Onaylandı. MatchTime grubunuzun bağlantısını alır almaz ${p.name} davet bağlantısını alacak: MatchTime'ı WhatsApp grubunuzda yönetici yapın ya da bağlantıyı Ayarlar'a yapıştırın: ${p.link}`,
  hq_join_already: (p) => `${p.name} kişisine davet bağlantısı zaten gönderildi.`,
  hq_join_closed: (p) => `${p.name} kişisinin katılma isteği artık açık değil.`,
  notice_no_link: (p) =>
    `Önce MatchTime grubunuzun bağlantısını gönderebilsin: MatchTime'ı WhatsApp grubunuzda yönetici yapın ya da bağlantıyı Ayarlar'a yapıştırın: ${p.link}`,
  notice_link_failed: (p) =>
    `${p.name} için grubunuzun davet bağlantısını alamadım. Bağlantıyı Ayarlar'a yapıştırın, ben ona göndereyim: ${p.link}`,

  // ── The guest card ────────────────────────────────────────────────────
  card_requested: "Grubunuza katılmak istiyor",
  card_send_link: "Davet bağlantısını gönder",
  card_not_now: "Şimdi değil",
  card_approved: "Onaylandı, grup bağlantısı bekleniyor.",
  card_link_sent: "Davet bağlantısı gönderildi. Henüz grupta değil.",
  card_declined: "Yakın zamanda katılmak istemediğini söyledi.",
  card_no_link: "Misafirleri davet etmek için MatchTime'ı WhatsApp grubunuzda yönetici yapın ya da grubunuzun davet bağlantısını Ayarlar'a yapıştırın.",
  card_no_link_cta: "Ayarları aç",
  card_invited_toast: "Davet edildi. MatchTime ona özelden soruyor.",
  card_link_sent_toast: "Tamam. MatchTime davet bağlantısını ona gönderiyor.",
  card_closed_toast: "Tamam. Şimdilik davet edilmeyecek.",

  // ── The settings card ─────────────────────────────────────────────────
  set_title: "Grup davet bağlantısı",
  set_blurb:
    "Bir misafir ve kulübünüz evet dediğinde MatchTime, WhatsApp grubunuzun davet bağlantısını misafire özelden gönderir. Oyuncular bunun dışında bağlantıyı hiç görmez.",
  set_option_bot: "A seçeneği (önerilen): MatchTime'ı WhatsApp grubunuzda yönetici yapın. Onayladığınız her misafir için bağlantıyı kendisi alır.",
  set_option_paste: "B seçeneği: grubunuzun davet bağlantısını aşağıya yapıştırın. WhatsApp'ta grup bilgisini açın, Bağlantı ile davet et, sonra Bağlantıyı kopyala.",
  set_status_bot: "MatchTime grubunuzda yönetici, bağlantıyı kendisi alıyor.",
  set_status_pasted: "Yapıştırdığınız bağlantı kullanılıyor.",
  set_status_none: "Henüz ayarlanmadı: misafirler grubunuza davet edilemez.",
  set_label: "Grubunuzun davet bağlantısı",
  set_save: "Bağlantıyı kaydet",
  set_remove: "Kaldır",
  set_saved: "Kaydedildi. MatchTime bunu yalnızca iki tarafın da onayladığı misafirlere gönderir.",
  set_removed: "Kaldırıldı.",
  set_invalid: "Bu bir WhatsApp grup davet bağlantısı değil. https://chat.whatsapp.com/ ile başlar",
  set_not_hq: "Yönetici grubunuzun değil, oyuncu grubunuzun bağlantısını yapıştırın.",
  set_sent_waiting: (p) => `Bekleyen ${p.n} onaylı misafire gönderildi.`,

  // ── My invitations ────────────────────────────────────────────────────
  inv_title: "Davetlerim",
  inv_intro: "Seni gruplarında görmek isteyen kulüpler ve sana önerilen maçlar.",
  inv_clubs: "Kulüp davetleri",
  inv_offers: "Maç teklifleri",
  inv_none_clubs: "Şu anda kulüp davetin yok.",
  inv_none_offers: "Şu anda açık maç teklifin yok.",
  inv_games_here: (p) => `Onlarla ${p.n} maç oynadın.`,
  inv_join: "Katıl",
  inv_no: "Hayır, teşekkürler",
  inv_waiting_club: "Teşekkürler. Kulübün onayı bekleniyor.",
  inv_link_sent: "Tamam. Davet bağlantısı WhatsApp'tan sana geliyor.",
  inv_declined: "Bize bildirdiğin için teşekkürler.",
  inv_member: "Zaten bu kulüptesin.",
  inv_open_offer: "Teklifi aç",
  inv_offer_until: (p) => `En geç ${p.time} yanıtla`,
  inv_try_again: "Bir şeyler ters gitti. Lütfen bir dakika sonra tekrar dene.",
  inv_settings: "Oyuncu havuzu ayarların",
};
