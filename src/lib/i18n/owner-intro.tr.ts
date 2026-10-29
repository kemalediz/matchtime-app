/** Kemal's introduction messages in Turkish. See `owner-intro.ts`. Approved copy, 2026-10-29: change only with Kemal. */
import type { OwnerIntroCopy } from "./owner-intro";

export const OWNER_INTRO_TR: OwnerIntroCopy = {
  footballGroups: (siteUrl) => `Selam arkadaşlar 👋

Son zamanlarda oyuncu bulmakta zorlandığımızı görüyorum, işimize yarayabilecek bir şey paylaşmak istedim.

Başka bir futbol grubunu ben yönetiyorum ve orada geliştirdiğim *MatchTime*'ı kullanıyoruz. Gruba eklenen ve organizasyonu bizim yerimize yapan bir WhatsApp asistanı:

✅ *Katılım:* oyuncular sadece IN ya da OUT yazar, listeyi ve sayıyı o tutar
🪑 *Yedek:* kadro dolunca fazla isimler yedeğe geçer, biri çıkınca yerine girer
🔎 *Oyuncu bulma:* eksik olduğumuzda organizatör MatchTime'ı etiketler, o da MatchTime oyuncu havuzundaki ve partner kulüplerdeki yakın oyunculara sorar
⚖️ *Dengeli takımlar:* oyuncu puanlarına göre adil takımlar kurar
💷 *Ödemeler:* kimin ödediğini takip eder
🏆 *Puanlar, maçın oyuncusu ve istatistik sayfası:* oyuncuların çok sevdiği kısım

Artık listeyi tekrar tekrar yapıştırmak ya da herkesi tek tek kovalamak yok.

Bir göz atın: ${siteUrl}

Organizatörler denemek isterse grup için kurulumu memnuniyetle yaparım.`,
  poolInvite: (playUrl) => `Herkese selam 👋

Top oynamayı seven herkes için kısa bir not ⚽

Yerel futbol takımlarına yardımcı olan *MatchTime*'ı geliştirdim. Artık bir *oyuncu havuzu* da var: yakındaki bir takımın oyuncusu eksik olduğunda maça çağrılmak isteyenlerin listesi.

*Nasıl çalışıyor*
1. Posta kodu bölgenizi (sadece ilk kısmı, örneğin SM1), ne kadar uzağa gidebileceğinizi ve boş olduğunuz gün ve saatleri yazın.
2. Tek bir WhatsApp mesajıyla onaylayın.
3. Yakınınızdaki bir takımın oyuncuya ihtiyacı olduğunda MatchTime size maçı WhatsApp'tan iletir. Her seferinde evet ya da hayır dersiniz.

🙌 Bağlayıcılık yok, sadece istediğinizde oynarsınız
🔒 Takım adınızı ve soyadınızın baş harfini ancak siz evet dedikten sonra görür
📵 Haftada sınırlı sayıda mesaj, istediğiniz zaman durdurabilirsiniz
🆓 Katılım ücretsiz

Buradan kaydolun: ${playUrl}`,
  newFeatures: () => `Herkese selam 👋 Bugünden itibaren kullanabileceğiniz yeni MatchTime özellikleri:

🔎 *Oyuncu mu eksik? MatchTime bulur.*
Organizatörler, MatchTime'ı etiketleyip nereden bulacağını yazmanız yeterli. Hemen sormaya başlar:
• *@Match Time perşembe için havuzdan 2 oyuncu bul*
• *@Match Time perşembe için partner kulüplerden oyuncu bul*
• *@Match Time perşembe için partner kulüplerden ve havuzdan oyuncu bul*

🤝 *Partner kulüpler:* yakındaki diğer MatchTime kulüpleriyle bağlantı kurun ve boştaki oyuncuları paylaşın. Açarsanız MatchTime maç günü partnerlerinize kendiliğinden sorabilir.

🙋 *Kimin geldiğini görürsünüz:* havuzdan ya da partner kulüpten bir oyuncu yer alınca veya yedeğe geçince MatchTime bunu burada paylaşır, herkes kimin katıldığını bilir.

⚽ *Daha çok maç mı istiyorsunuz?* MatchTime profilinizde *Başka yerlerde de oyna* seçeneğini açın. Yakınınızdaki bir takımın oyuncusu eksik olduğunda WhatsApp'tan mesaj alırsınız ve her seferinde siz karar verirsiniz. Arkadaşlarınızı davet etmek için kendi linkiniz de olur.

Sorunuz olursa *@Match Time yardım* yazmanız yeterli.`,
};
