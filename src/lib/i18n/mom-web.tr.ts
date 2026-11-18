/** Man of the Match on the web pages, in Turkish. See `mom-web.ts`. */
import type { MomWebCopy } from "./mom-web";

export const MOM_WEB_TR: MomWebCopy = {
  open: "Oylama sürüyor",
  closedToBePosted: "Oylama kapandı, sonuç grupta paylaşılacak",
  closedPlain: "Oylama kapandı",
  posted: "Sonuç grupta paylaşıldı",
  pickedToBePosted: "Organizatörler seçti, grupta paylaşılacak",
  shared: (p) => `${p.names} paylaştı`,
  votesOf: (p) => `(${p.top}/${p.total} oy)`,
  votesEach: (p) => `(her biri ${p.top} oy)`,
  picked: "(organizatörler seçti)",
  alsoReceived: "Oy alan diğerleri:",
  and: " ve ",
  wins: (n) => `${n} kez maçın adamı`,
  winsNote: "Maçın adamı sayısı yalnızca kesinleşmiş sonuçları sayar: süren ya da henüz paylaşılmamış bir oylama, kesinleşince sayılır.",
};
