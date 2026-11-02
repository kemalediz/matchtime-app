/**
 * THE PARTNER POOL INVITE, TURKISH (2026-11-02). Every key of
 * `pool-partner-invite.en.ts` (the type proves it); the house rules are
 * unit tested in `__tests__/pool-partner-invite-copy.test.ts`.
 */
import type { PoolPartnerInviteStrings } from "./pool-partner-invite.en";

export const poolPartnerInviteTr: PoolPartnerInviteStrings = {
  dm: (p) =>
    `*${p.club}* için oynadığın için teşekkürler. Kendi kulübünün maçı olmadığında yakınındaki maçlardan haberdar olmak ister misin? İstersen MatchTime oyuncu havuzuna buradan katılabilirsin: ${p.link}`,

  page_lead: "Partner kulüp misafiri olarak oynadığın için teşekkürler. Havuza katıl, yakınındaki bir kulübün senin oynayabildiğin bir saatte bir oyuncusu eksik olduğunda MatchTime sana haber versin. Her seferinde sen karar verirsin.",
  page_optional: "Karar senin: katılmasan da partner kulüplerde oynamaya devam edebilirsin.",
  page_you: (p) => `${p.name} olarak, sonu ${p.tail} ile biten WhatsApp numaranla katılıyorsun. Kod gerekmez: bu bağlantı o numaraya geldi.`,
  page_you_no_name: (p) => `Sonu ${p.tail} ile biten WhatsApp numaranla katılıyorsun. Kod gerekmez: bu bağlantı o numaraya geldi.`,
  done_heading: "Oyuncu havuzundasın",
  done_body: "Yakınındaki bir maçın oyuncuya ihtiyacı olduğunda MatchTime sana WhatsApp'tan yazar. MatchTime profilinden istediğin zaman duraklatabilir ya da durdurabilirsin.",
  member_heading: "Zaten oyuncu havuzundasın",
  member_body: "Burada yapman gereken başka bir şey yok. Bilgilerini MatchTime profilinden değiştirebilirsin.",
  stopped_heading: "Maç mesajları yeniden başlasın mı?",
  stopped_body: "Daha önce havuz mesajlarını durdurmuştun. Kayıtlı bilgilerinle yeniden başlatmak için kutuyu işaretle.",
  restarted_heading: "Maç mesajları yeniden açık",
  expired_heading: "Bu bağlantının süresi doldu",
  expired_body: "Oyuncu havuzuna kayıt sayfasından istediğin zaman katılabilirsin.",
  invalid_heading: "Bu bağlantı çalışmıyor",
  invalid_body: "Yanlış kopyalanmış olabilir. Oyuncu havuzuna kayıt sayfasından katılabilirsin.",
  signup_link: "Kayıt sayfasına git",
};
