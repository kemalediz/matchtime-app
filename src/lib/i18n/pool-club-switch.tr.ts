/** A club's own player pool switch in Turkish (2026-10-28). See `pool-club-switch.ts`. */
import type { PoolClubSwitchCopy } from "./pool-club-switch";

export const POOL_CLUB_SWITCH_TR: PoolClubSwitchCopy = {
  notice: (club, audience) =>
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
      "Ayrıca:",
      "• bir maçta *MatchTime oyuncu havuzu* kutusunu işaretleyin",
      "• Yönetim, sonra Ayarlar'da *Oyuncu havuzuna kendiliğinden sor* seçeneğini açın (önce partner kulüplere sorulur)",
      "Oyuncularınız da bilsin mi? Ayarlar'daki *Oyuncularınıza oyuncu havuzunu anlatın* kartını kullanın.",
    ].join("\n"),
  groupAnnouncement: (club) =>
    [
      `⚽ *MatchTime oyuncu havuzu ${club} için açıldı*`,
      "Oyuncu mu eksik? Kulübün organizatörleri artık MatchTime'dan havuza katılmış yakındaki oyuncuları isteyebilir.",
      "",
      "*Nasıl istenir* (yalnızca organizatörler)",
      "Burada @Match Time etiketleyip yazın, örneğin:",
      "• @Match Time perşembe için havuzdan 2 oyuncu bul",
      "• @Match Time perşembe için partner kulüplerden ve havuzdan oyuncu bul",
      "MatchTime yeri WhatsApp'tan yakındaki havuz oyuncularına önerir ve biri yeri alınca organizatörlere haber verir.",
      "",
      "Organizatörler ayrıca bir maçta *MatchTime oyuncu havuzu* kutusunu işaretleyebilir ya da Yönetim, sonra Ayarlar'da *Oyuncu havuzuna kendiliğinden sor* seçeneğini açabilir.",
    ].join("\n"),
  title: "Oyuncu havuzu",
  lead: "Oyuncu eksik olduğunda MatchTime, MatchTime oyuncu havuzuna katılmış yakındaki oyunculara sorabilir. MatchTime kendiliğinden sorduğunda önce partner kulüplerinize sorulur. Bir yönetici istemedikçe ya da aşağıda otomatik sormayı açmadıkça hiçbir şey gönderilmez.",
  confirmOff: "Kulübünüz için oyuncu havuzu kapatılsın mı? Maçlarınız için havuza yapılmış ve hâlâ açık olan istekler şimdi kapatılır.",
  savedOn: "Oyuncu havuzu açık.",
  savedOff: (n) => (n === 0 ? "Oyuncu havuzu kapalı." : `Oyuncu havuzu kapalı. Havuza yapılmış ${n} açık istek kapatıldı.`),
};
