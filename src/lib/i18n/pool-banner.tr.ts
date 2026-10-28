/** The player pool banner in Turkish. See `pool-banner.ts`. */
import type { PoolBannerCopy } from "./pool-banner";

export const POOL_BANNER_TR: PoolBannerCopy = {
  region: "MatchTime oyuncu havuzu",
  join: {
    text: "Daha çok maç mı istiyorsun? MatchTime oyuncu havuzuna katıl.",
    button: "Havuza katıl",
    info: {
      title: "MatchTime oyuncu havuzu",
      lines: [
        "Yakınındaki bir takımın bir oyuncusu eksik olduğunda MatchTime sana WhatsApp'tan maçı yazar.",
        "Her seferinde sen karar verirsin ve yalnızca istediğin maçlara evet dersin.",
        "İstediğin zaman profilinden bırakabilirsin.",
      ],
    },
  },
  share: {
    text: "Maç arayan birini tanıyor musun? Bağlantını paylaş.",
    button: "Paylaş",
    info: {
      title: "Senin bağlantın",
      lines: [
        "Maç arayan bir arkadaşına kendi bağlantını gönder.",
        "Bu bağlantıyla kayıt olursa, yakınındaki bir takımın bir oyuncusu eksik olduğunda MatchTime ona WhatsApp'tan yazar.",
        "Numaran asla bağlantıda ya da mesajda yer almaz.",
      ],
    },
  },
  notInterested: "İlgilenmiyorum",
  adminLine: "Oyuncularınıza anlatın",
};
