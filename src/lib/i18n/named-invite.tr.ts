/** Etiketlenen kişilere özelden davet, Türkçe. Bkz. `named-invite.ts`. */
import type { NamedInviteCopy } from "./named-invite";

export const NAMED_INVITE_TR: NamedInviteCopy = {
  sent: (p) => `✅ Tamam. *${p.matchName}* (${p.when}) davetini özelden gönderdim: ${p.names}.`,
  alreadyHad: (p) => `Daveti zaten almışlardı: ${p.names}.`,
  answered: (p) => `Bu maç için zaten cevap verdiler: ${p.names}.`,
  optedOut: (p) => `Mesajla davet almak istemiyorlar, onlara yazmadım: ${p.names}.`,
  overCap: (p) => `Bir seferde en fazla ${p.cap} kişiye yazıyorum, şunları dışarıda bıraktım: ${p.names}. Onlar için tekrar sor.`,
  unknown: (p) => `Henüz tanımadığım numaralara yazamıyorum, şunlara yazmadım: ${p.names}.`,
  more: (p) => (p.alone ? (p.count === 1 ? "bir kişi" : `${p.count} kişi`) : p.count === 1 ? "bir kişi daha" : `${p.count} kişi daha`),
  nobodyTagged: "O mesajda etiketlenen kimseyi göremedim, kimseye yazmadım.",
  noMatch: "Davet edebileceğim yaklaşan bir maç yok, kimseye yazmadım.",
  full: (p) => `*${p.matchName}* maçında boş yer yok, kimseye yazmadım.`,
  notHere: (p) => `Artık kulüpte değiller, onlara yazmadım: ${p.names}.`,
  unidentified: (p) => `Etiketlenenlerden ${p.count} kişinin kim olduğunu anlayamadım, onlara yazmadım.`,
  from: (p) =>
    p.senderName ? `📨 ${p.senderName} adlı kişinin mesajından:` : p.from === "quoted" ? "📨 Yanıtladığın mesajdan:" : "📨 Yukarıdaki mesajdan:",
  failed: "Bir şeyler ters gitti, kimseye yazmadım. Lütfen bir dakika sonra tekrar dene.",
};
