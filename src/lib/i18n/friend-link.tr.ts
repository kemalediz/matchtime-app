/**
 * THE FRIEND LINK'S WORDS, TURKISH (2026-10-31). Same keys as
 * `friend-link.en.ts`; see that file for the rules. Values sit where
 * Turkish needs no suffix ("Ali için", "Shane getirdi").
 */
import type { FriendLinkStrings } from "./friend-link.en";

export const friendLinkTr: FriendLinkStrings = {
  member_one: (p) =>
    `${p.friend ? `${p.friend} için` : "Arkadaşın için"} *${p.club}* ile ${p.day}${p.venue ? `, ${p.venue}` : ""} maçının bağlantısı aşağıda. Lütfen ${p.friend ? "ona" : "arkadaşına"} ilet.`,
  member_many: (p) =>
    `Arkadaşların için *${p.club}* ile ${p.day}${p.venue ? `, ${p.venue}` : ""} maçının bağlantıları aşağıda. Her birini ilgili arkadaşına ilet. Her arkadaşın kendi bağlantısını kullanmalı.`,
  member_how: "Arkadaşın bu maça yalnızca bağlantıyı açıp bilgilerini doldurarak ve verdiği WhatsApp kodunu göndererek katılabilir. Her bağlantı tek kişilik ve maç başlayana kadar geçerli.",
  member_cap: (p) => `*${p.club}* ile ${p.day} maçı için henüz kimsenin kullanmadığı bağlantıların var, işte yeniden:`,
  member_link_line: (p) => `${p.n}. ${p.friend ?? "Arkadaş"}: ${p.link}`,
  member_no_phone: (p) => `${p.member}, arkadaşının bağlantısını sana özelden gönderemedim. Bana bir kez özelden yaz, sonra burada beni yeniden etiketle.`,

  page_invited: (p) => `${p.member} seni maça davet etti`,
  page_fee: (p) => `Ücret: ${p.amount}`,
  page_fee_payg: (p) => `Ücret: maç başı ${p.amount}`,
  page_free: "Ücretsiz",
  page_explain: "Bilgilerini doldur, sonra yerini almak için WhatsApp kodunu gönder. Bu bağlantı maç başlayana kadar geçerli.",
  page_used: "Bu bağlantı zaten kullanıldı.",
  page_started: "Bu maç başladı, bağlantı artık geçerli değil.",
  page_called_off: "Bu maç iptal edildi.",
  page_invalid: "Bu bağlantıyı tanımıyoruz.",
  page_pool_hint: "Yine de yakınındaki maçlardan haberdar olmak için MatchTime oyuncu havuzuna katılabilirsin.",
  page_pool_cta: "Oyuncu havuzuna katıl",

  booked_in: (p) => `*${p.club}* ile ${p.day}${p.venue ? `, ${p.venue}` : ""} maçındasın. Seni ${p.member} getirdi.`,
  booked_bench: (p) =>
    `*${p.club}* ile ${p.day}${p.venue ? `, ${p.venue}` : ""} maçında yedektesin. Seni ${p.member} getirdi. Kadro dolu; bir yer açılırsa sana haber veririm.`,
  booked_bench_pick: (p) =>
    `*${p.club}* ile ${p.day}${p.venue ? `, ${p.venue}` : ""} maçında yedektesin. Seni ${p.member} getirdi. Yedeklerden kimin oynayacağını organizatörler seçer.`,
  booked_fee: (p) => `Ücret: ${p.amount}, maçtan sonra senden istenecek.`,
  booked_fee_payg: (p) => `Ücret: maç başı ödeyen oyuncu olarak ${p.amount}, maçtan sonra senden istenecek.`,
  booked_pool: "Artık MatchTime oyuncu havuzundasın, yakınındaki diğer maçlardan da haberin olacak.",
  not_booked_pool: "Artık MatchTime oyuncu havuzundasın, yakınındaki maçlardan haberin olacak.",
  not_used: "O bağlantıdaki yer zaten alındı, bu yüzden o maça kaydın yapılmadı.",
  not_started: "O maç zaten başladı, bu yüzden kaydın yapılmadı.",
  not_called_off: "O maç iptal edildi.",
  not_already: "O maçın listesinde zaten varsın.",
  not_issuer: "O bağlantı bir arkadaşın için. Kendin oynamak için kulübün grubunda IN yaz.",
  not_other: "O maça kaydın yapılmadı.",
  footer: (p) => `Ayarların: ${p.link}`,

  group_in: (p) => `🙋 ${p.name} (${p.member} getirdi) ${p.day} maçında.`,
  group_bench: (p) => `🙋 ${p.name} (${p.member} getirdi) ${p.day} maçı için yedekte.`,
  group_bench_pick: (p) =>
    `🙋 ${p.name} (${p.member} getirdi) ${p.day} maçı için yedekte. Yedeklerden kimin oynayacağını organizatörler seçer. Organizatörler, ${p.name} kadroya girsin isterseniz beni etiketleyip yazın, örneğin *@Match Time ${p.name} kadroya girsin*`,

  removed: (p) =>
    `*${p.club}* organizatörleri seni ${p.day} maçından çıkardı. MatchTime oyuncu havuzunda kalıyorsun ve yakınındaki yeni maçlardan haberin olmaya devam edecek.`,
};
