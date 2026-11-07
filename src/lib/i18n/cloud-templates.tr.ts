/**
 * THE OFFICIAL NUMBER'S MESSAGE TEMPLATES, TURKISH (Cloud API plan 3.9,
 * PR C6). The owner (a native speaker) reads this file before the
 * templates are submitted to Meta. Same keys as `cloud-templates.en.ts`
 * (the type proves it); see that file for the rules. "Yedek" for the
 * bench, always. Where the English opens with a variable's sentence, the
 * Turkish opens with a word of its own, so no body starts with a variable.
 */
import type { CloudTemplateStrings } from "./cloud-templates.en";

export const cloudTemplatesTr: CloudTemplateStrings = {
  bodies: {
    mt_pool_offer:
      "⚽ *{{1}}*, {{3}} için {{2}} arıyor: *{{4}}*.\n📍 {{5}}\n⏱️ {{6}}\n\nBu mesajı MatchTime oyuncu havuzuna katıldığın için alıyorsun. Yeri ister misin? Cevap'a dokun ya da buraya yaz.",
    mt_pool_placed_in: "✅ Yerin hazır: *{{1}}*, {{2}}, {{3}}.\nGelemeyecek misin? Yeri geri bırakmak için aşağıya dokun.",
    mt_pool_placed_in_fee:
      "✅ Yerin hazır: *{{1}}*, {{2}}, {{3}}.\nMaç ücreti {{4}}. Maçtan sonra ödeme bağlantısı gelecek.\nGelemeyecek misin? Yeri geri bırakmak için aşağıya dokun.",
    mt_pool_placed_bench:
      "📝 *{{1}}* maçında yedektesin: {{2}}, {{3}}. Organizatörler yedekten seçiyor, oynarsan haber vereceğim.\nGelemeyecek misin? Yeri geri bırakmak için aşağıya dokun.",
    mt_pool_placed_bench_fee:
      "📝 *{{1}}* maçında yedektesin: {{2}}, {{3}}. Organizatörler yedekten seçiyor, oynarsan haber vereceğim.\nMaç ücreti {{4}}. Maçtan sonra ödeme bağlantısı gelecek.\nGelemeyecek misin? Yeri geri bırakmak için aşağıya dokun.",
    mt_pool_paused: "Son {{1}} teklif cevapsız kaldığı için maç tekliflerini durdurdum. Yeniden istersen aşağıya dokun.",
    mt_pool_paused_no_shows:
      "Son {{2}} maçının {{1}} tanesine gelmediğin için maç tekliflerini durdurdum. {{3}} gün sonra yeniden başlatabilirsin ya da şimdi bir kişinin bakmasını isteyebilirsin. Aşağıya dokun.",
    mt_pool_paused_review: "MatchTime ekibi profiline bakarken maç tekliflerini durdurdum. Sormak istediğin bir şey olursa buraya yazabilirsin.",
    mt_pool_resumed: "Maç teklifleri yeniden açık. Ayarlarını görmek için aşağıya dokun.",
    mt_game_plan_changed: "Plan değişti: *{{1}}* için {{2}} maçında artık oyuncuya ihtiyaçları yok. Senin bir şey yapmana gerek yok.",
    mt_taken_out:
      "Bilgin olsun: *{{1}}* organizatörleri seni {{2}} maçından çıkardı. MatchTime oyuncu havuzunda kalıyorsun ve yakınındaki yeni maçlardan haberin olmaya devam edecek.",
    mt_place_given_back: "Yerini geri verdin: *{{1}}*, {{2}} maçı. MatchTime oyuncu havuzunda kalıyorsun.",
    mt_pool_joined:
      "✅ MatchTime oyuncu havuzuna katıldın. Yakınındaki bir kulübün, oynayabileceğin bir saatte oyuncuya ihtiyacı olduğunda maçı sana buradan yazacağım, karar senin. Haftada en fazla {{1}} kez yazarım.",
    mt_pool_joined_early:
      "✅ MatchTime oyuncu havuzunun erken kayıt listesine katıldın. Havuz henüz senin bölgende açık değil, açılana kadar sana maç için yazmayacağım. Açıldığında haftada en fazla {{1}} kez yazarım.",
    mt_pool_details_ask:
      "Sana uygun maçları göndermem için kısa bir soru: {{1}} günleri hangi saatlerde oynayabilirsin, hangi formatlarda oynuyorsun ({{2}})? Buraya kendi cümlelerinle yaz. Her saat ve her format uygunsa cevap vermene gerek yok.",
    mt_club_invite_after_game:
      "Maç güzel geçti mi? {{2}} günü *{{1}}* ile oynadın. Sonraki maçlar için gruplarına katılmak istersen yanıtlamak için aşağıya dokun.",
    mt_club_invite_organiser: "MatchTime'tan: *{{1}}* sonraki maçlar için seni gruplarında görmek istiyor. Yanıtlamak için aşağıya dokun.",
    mt_club_invite_link: "🎉 *{{1}}* grubuna hoş geldin. WhatsApp grubuna katılmak için aşağıya dokun.",
    mt_club_invite_closed:
      "Evet dediğin için teşekkürler. *{{1}}* şu anda gruplarına yeni oyuncu almıyor. Yakınındaki maçları MatchTime üzerinden almaya devam edebilirsin.",
  },

  buttons: {
    answer: "Cevap",
    settings: "Ayarlar",
    stop_offers: "Teklifleri durdur",
    give_back: "Yeri geri bırak",
    invitations: "Yanıtla",
    join_group: "Gruba katıl",
    copy_code: "Kodu kopyala",
  },

  parts: {
    places: (n) => `${n} oyuncu`,
    length: (mins) => `${mins} dk`,
  },
};
