/** A form note with its amount, in Turkish. See `form-note.ts`. */
import type { FormNoteCopy } from "./form-note";

export const FORM_NOTE_TR: FormNoteCopy = {
  amountFor: (p) => (p.reason ? `${p.name} için ${p.amount} (${p.reason})` : `${p.name} için ${p.amount}`),
  noneFor: (p) => `${p.name} için puan ayarı yok`,
  saved: (p) => `Not aldım: ${p.day} maçında ${p.parts}.`,
  changed: (p) => `Değiştirdim: ${p.day} maçında ${p.parts}.`,
  capped: "En fazla artı ya da eksi 1 olabilir.",
  teamsMade: "Takımlar zaten kuruldu; yeniden kurulursa geçerli olur.",
  others: "Başkaları hakkında söylenenleri takımlar kurulurken dikkate alacağım.",
  amendHint: (p) => `Farklı bir miktar mı istersiniz? Beni etiketleyip yazın, örneğin "${p.example} yap".`,
};
