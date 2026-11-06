/** A club's own player pool switch in Turkish (2026-10-28). See `pool-club-switch.ts`. */
import type { PoolClubSwitchCopy } from "./pool-club-switch";

export const POOL_CLUB_SWITCH_TR: PoolClubSwitchCopy = {
  notice: (club, audience, links) =>
    [
      `⚽ *MatchTime oyuncu havuzu ${club} için açıldı*`,
      "Oyuncu mu eksik? MatchTime'dan havuza katılmış yakındaki oyuncuları isteyin.",
      "",
      "*Nasıl istenir*",
      audience === "group" ? "Burada @Match Time etiketleyip yazın, örneğin:" : "Kulübünüzün WhatsApp grubunda @Match Time etiketleyip yazın, örneğin:",
      "• @Match Time perşembe için havuzdan 2 oyuncu bul",
      "• @Match Time perşembe için partner kulüplerden ve havuzdan oyuncu bul",
      `Yalnızca kulübün organizatörleri isteyebilir. MatchTime yeri WhatsApp'tan yakındaki havuz oyuncularına önerir ve biri yeri alınca size${audience === "group" ? " burada" : ""} haber verir.`,
      "",
      "*Başka yollar*",
      "• Bir maçta *MatchTime oyuncu havuzu* kutusunu işaretleyin: MatchTime o maçtaki boş yerler için yakındaki havuz oyuncularına sorar.",
      `• *Oyuncu havuzuna kendiliğinden sor*: maç günü hâlâ boş yer varsa ve yedekte kimse yoksa MatchTime havuza kendisi sorar. Buradan açın: ${links.autoAsk}`,
      "",
      `Oyuncularınız da bilsin mi? *Oyuncularınıza oyuncu havuzunu anlatın* kartını kullanın: ${links.share}`,
    ].join("\n"),
  groupAnnouncement: (club) =>
    [
      `⚽ *${club} artık MatchTime oyuncu havuzunda*`,
      "Oyuncu havuzu, yakınlarındaki bir maçta bir oyuncu eksik olduğunda kendilerine sorulmasını isteyen bölgedeki oyuncuların listesidir.",
      "",
      "*Oyuncular için*",
      "Daha çok maç mı istiyorsunuz? MatchTime profilinizde *Başka yerlerde de oyna* seçeneğini açın. Yakınınızdaki bir maça oyuncu gerektiğinde MatchTime size WhatsApp'tan yazar ve her seferinde siz karar verirsiniz. Kendi maçlarımızda hiçbir şey değişmez.",
      "",
      "*Organizatörler için*",
      "Oyuncu mu eksik? Burada @Match Time etiketleyip yazın, örneğin:",
      "• @Match Time bir sonraki maç için havuzdan 2 oyuncu bul",
      "MatchTime yeri WhatsApp'tan yakındaki havuz oyuncularına önerir ve biri yeri alınca organizatörlere haber verir.",
    ].join("\n"),
  title: "Oyuncu havuzu",
  lead: "Oyuncu eksik olduğunda MatchTime, MatchTime oyuncu havuzuna katılmış yakındaki oyunculara sorabilir. MatchTime kendiliğinden sorduğunda önce partner kulüplerinize sorulur. Bir yönetici istemedikçe ya da aşağıda otomatik sormayı açmadıkça hiçbir şey gönderilmez.",
  confirmOff: "Kulübünüz için oyuncu havuzu kapatılsın mı? Maçlarınız için havuza yapılmış ve hâlâ açık olan istekler şimdi kapatılır.",
  savedOn: "Oyuncu havuzu açık.",
  savedOff: (n) => (n === 0 ? "Oyuncu havuzu kapalı." : `Oyuncu havuzu kapalı. Havuza yapılmış ${n} açık istek kapatıldı.`),
};
