/** A club's own player pool switch in Turkish (2026-10-28). See `pool-club-switch.ts`. */
import type { PoolClubSwitchCopy } from "./pool-club-switch";

export const POOL_CLUB_SWITCH_TR: PoolClubSwitchCopy = {
  notice: (club, audience) =>
    [
      `⚽ *MatchTime oyuncu havuzu ${club} için açıldı*`,
      "Oyuncu eksik olduğunda MatchTime, havuza katılmış yakındaki oyunculara sorabilir. Önce her zaman partner kulüplerinize sorulur.",
      "Hiçbir şey kendiliğinden gönderilmez. Şunları yapabilirsiniz:",
      "• bir maçta *MatchTime oyuncu havuzu* kutusunu işaretleyip oyuncu isteyin",
      audience === "group"
        ? '• buradan bana yazın, örneğin "@Match Time perşembe için 2 oyuncu lazım"'
        : '• kulübünüzün WhatsApp grubunda bana yazın, örneğin "@Match Time perşembe için 2 oyuncu lazım"',
      "• Yönetim, sonra Ayarlar'da *Oyuncu havuzuna kendiliğinden sor* seçeneğini açın",
      "Oyuncularınız da bilsin mi? Ayarlar'daki *Oyuncularınıza oyuncu havuzunu anlatın* kartını kullanın.",
    ].join("\n"),
  title: "Oyuncu havuzu",
  lead: "Oyuncu eksik olduğunda MatchTime, MatchTime oyuncu havuzuna katılmış yakındaki oyunculara sorabilir. Önce her zaman partner kulüplerinize sorulur. Bir yönetici istemedikçe ya da aşağıda otomatik sormayı açmadıkça hiçbir şey gönderilmez.",
  confirmOff: "Kulübünüz için oyuncu havuzu kapatılsın mı? Maçlarınız için havuza yapılmış ve hâlâ açık olan istekler şimdi kapatılır.",
  savedOn: "Oyuncu havuzu açık.",
  savedOff: (n) => (n === 0 ? "Oyuncu havuzu kapalı." : `Oyuncu havuzu kapalı. Havuza yapılmış ${n} açık istek kapatıldı.`),
};
