/** The pool's sharing in Turkish (growth slice G1). See `pool-share.ts`. */
import type { PoolShareCopy } from "./pool-share";

export const POOL_SHARE_TR: PoolShareCopy = {
  heading: "Bir arkadaşını getir",
  intro: "Maç arayan birini tanıyor musun? Ona kendi bağlantını gönder. Bu bağlantıyla kaydolursa onu senin getirdiğini biliriz; ilk maçını oynadığında sayılır.",
  linkLabel: "Bağlantın",
  messageLabel: "WhatsApp'ta açılacak mesaj",
  copyLink: "Bağlantıyı kopyala",
  copied: "Kopyalandı",
  copyFailed: "Kopyalanamadı. Kopyalamak için bağlantıya basılı tut.",
  shareWhatsApp: "WhatsApp'ta paylaş",
  recognitionOn: (name) => `Bağlantını açanlar onları ${name} adlı kişinin davet ettiğini görür. Havuz sayfandaki gizlilik düğmesiyle bunu kapatabilirsin. Numaran bağlantıda da mesajda da hiç yer almaz.`,
  recognitionOff: "Bağlantını açanlar adını görmez. Numaran bağlantıda da mesajda da hiç yer almaz.",
  message: (url) => `Yakındaki maçlar için MatchTime kullanıyorum. Sen de kaydol, yakınında bir takıma oyuncu lazım olunca sana WhatsApp'tan yazsınlar: ${url}`,
  invitedBy: (name) => `${name} seni davet etti.`,
};
