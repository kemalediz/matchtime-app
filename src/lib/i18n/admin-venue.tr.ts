/** Setting the pitch by WhatsApp, in Turkish. See `admin-venue.ts`. */
import type { AdminVenueCopy } from "./admin-venue";

export const ADMIN_VENUE_TR: AdminVenueCopy = {
  set: (p) =>
    `📍 Tamam, sahanız *${p.name}*${p.address ? `, ${p.address}` : ""}.\n` +
    `Doğru yer değil mi? Buradan değiştirebilirsiniz: ${p.url}`,
  which: (p) =>
    `*${p.words}* için birden fazla yer buldum. Hangisi?\n` +
    p.options.map((o, i) => `${i + 1}. ${o}`).join("\n") +
    `\n\nNumarasıyla beni etiketleyin, örneğin: *@Match Time 1*`,
  none: (p) => `*${p.words}* yerini haritada bulamadım. Sahanızı buradan ayarlayabilirsiniz: ${p.url}`,
  unavailable: (p) => `Şu an yer arayamıyorum. Sahanızı buradan ayarlayabilirsiniz: ${p.url}`,
  noName: "Hangi saha? Adıyla beni etiketleyin, örneğin: *@Match Time sahamız Goals Sutton*",
  nothingToRetry: "👍 Teşekkürler. Yeniden denemem gereken bir şey yok.",
};
