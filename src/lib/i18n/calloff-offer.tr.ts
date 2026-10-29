/** `calloff-offer.en.ts`, in Turkish. */
import type { CalloffOfferStrings } from "./calloff-offer.en";

export const calloffOfferTr: CalloffOfferStrings = {
  offer: (p) =>
    `${p.day} maçı yapılmayacak gibi görünüyor. *iptal* yazarsan maçı iptal edip gruba haber veririm. Maç hâlâ yapılıyorsa bu mesajı boş ver.`,
  left_on: (p) => `Tamam, ${p.day} maçı yapılıyor, dokunmuyorum.`,
  already_off: (p) => `${p.game} zaten iptal edilmiş.`,
  cannot_cancel: (p) => `${p.game} maçını iptal edemedim. Maç sayfasından yapabilirsin.`,
};
