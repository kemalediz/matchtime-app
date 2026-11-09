/** A game's sizes, in Turkish. See `flex-format.ts`. */
import type { FlexFormatCopy } from "./flex-format";

/**
 * The dative ending of a number as it is read aloud ("8'e 8", "6'ya 6",
 * "7'ye 7", "10'a 10"): the last word of the number decides it.
 */
function dative(n: number): string {
  const ones: Record<number, string> = { 1: "e", 2: "ye", 3: "e", 4: "e", 5: "e", 6: "ya", 7: "ye", 8: "e", 9: "a" };
  const tens: Record<number, string> = { 1: "a", 2: "ye", 3: "a", 4: "a", 5: "ye", 6: "a", 7: "e", 8: "e", 9: "a" };
  const one = n % 10;
  if (one !== 0) return ones[one];
  return tens[Math.floor(n / 10) % 10] ?? "a";
}
const side = (n: number): string => `${n}'${dative(n)} ${n}`;
const list = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} ya da ${xs[xs.length - 1]}`);
const names = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} ve ${xs[xs.length - 1]}`);
const sides = (ns: number[]): string => list(ns.map(side));
const range = (min: number, max: number): string => (min === max ? `${min}` : `${min} ile ${max} arası`);

export const FLEX_FORMAT_TR: FlexFormatCopy = {
  side,
  sides,

  // Yedek ve "<n> kişi" yan yana değil: oyuncu grubundaki yanıt koruması
  // (`contradictsSquadState`) bunu kadro sayısı sanar ve yanıtı değiştirir.
  rangeSet: (p) =>
    `✅ Tamam. *${p.activityName}* artık ${sides(p.sides)} oynanıyor (${range(p.min, p.max)}). ` +
    `Yalnızca ${p.min} kişinin altına düşerse haber veririm` +
    (p.up ? `, iki kişi beklerse de bir büyük formata geçmeyi öneririm.` : `.`) +
    ` Her yönetici beni etiketleyerek bir maçın formatını değiştirebilir, örneğin *@Match Time ${side(p.up ? p.sides[p.sides.length - 1] : p.sides[0])} oynayalım*.`,
  rangeCleared: (p) =>
    `✅ Tamam. *${p.activityName}* yine yalnızca ${side(p.perSide)}: ${p.places} kişilik iki tam takım, ${p.places} kişinin altına düşerse haber veririm.`,
  rangeUnchanged: (p) => `*${p.activityName}* zaten ${sides(p.sides)} oynanıyor (${range(p.min, p.max)}).`,
  rangeRefused: (p) => {
    switch (p.error) {
      case "odd":
        return `Oyuncu sayısı çift olmalı ki iki takım eşit olsun: örneğin 12 ya da 14.`;
      case "too-low":
        return `En az oyuncu sayısı 2 veya daha fazla olmalı.`;
      case "too-high":
        return `En fazla oyuncu sayısı en çok ${p.ceiling} olabilir.`;
      case "min-above-places":
        return `*${p.activityName}* maçında ${p.places} yer var, en az oyuncu sayısı en fazla ${p.places} olabilir.`;
      case "max-below-places":
        return `*${p.activityName}* maçında ${p.places} yer var, en fazla oyuncu sayısı en az ${p.places} olmalı.`;
      default:
        return `Sayıları anlayamadım. Beni şöyle etiketleyin: *@Match Time 12 ile 16 kişi arası oynuyoruz*, ya da buradan ayarlayın: ${p.url}`;
    }
  },
  noNumbers: (p) => `Sayıları anlayamadım. Beni şöyle etiketleyin: *@Match Time 12 ile 16 kişi arası oynuyoruz*, ya da buradan ayarlayın: ${p.url}`,
  whichGame: (p) =>
    `Hangi maçı kastediyorsunuz: ${p.names.join(", ")}? Günü de yazarak etiketleyin, örneğin *@Match Time pazartesi 12 ile 16 kişi arası oynuyoruz*, ya da buradan ayarlayın: ${p.url}`,
  noGame: (p) => `Henüz haftalık maç ayarlanmamış. Buradan ekleyin: ${p.url}`,

  minLabel: "En az oyuncu",
  maxLabel: "En fazla oyuncu",
  minHint: (p) =>
    `Oynamaya razı olduğunuz en az kişi, çift sayı. Bunun altına düşerse bir gün önce haber verir, iptal etmeyi öneririm. İki tam takım (${p.full}) için boş bırakın.`,
  maxHint: (p) =>
    `Oynayabileceğiniz en fazla kişi, çift sayı. Yöneticiler bir maçı büyütebilir, yedekte iki kişi olunca ben de öneririm. Yalnızca ${p.full} için boş bırakın.`,
  allows: (p) =>
    p.sides.length <= 1 ? `${p.min} oyuncuyla ${sides(p.sides)} oynarsınız.` : `${p.min} ile ${p.max} oyuncu arasında ${sides(p.sides)} oynayabilirsiniz.`,
  row: (p) => sides(p.sides),

  switched: (p) =>
    `✅ Tamam: ${p.day} artık ${side(p.perSide)}, ${p.places} yer.` +
    (p.promoted.length ? ` Yedekten kadroya girenler: ${names(p.promoted)}.` : ``) +
    (p.demoted.length ? ` Artık yedekte: ${names(p.demoted)}.` : ``) +
    (p.teamsCleared ? ` Takımlar silindi, yeniden kurmak için beni etiketleyin.` : ``) +
    (p.pickOpen ? ` ${p.pickOpen} yer açıldı, yedekten kimin gireceğini size soracağım.` : ``),
  activitySwitched: (p) => `✅ Tamam: ${p.day} artık ${side(p.perSide)}, ${p.places} yer. Yeni listeyi gruba attım.`,
  suggestionStale: (p) => `Sorduğumdan beri sayılar değişti, ${p.day} olduğu gibi kalıyor. Hâlâ ${side(p.perSide)} isterseniz beni etiketleyin.`,
  rangeBlocked: (p) =>
    `${p.day} maçı artık ${side(p.perSide)}, bu sayılar onu dışarıda bırakır. Önce geri alın, örneğin *@Match Time ${side(p.backTo)} yapalım*, sonra değiştirin.`,
  alreadyThat: (p) => `${p.day} zaten ${side(p.perSide)}.`,
  notAllowed: (p) =>
    `*${p.activityName}* ${sides(p.sides)} oynanıyor, ${side(p.perSide)} yapamam. En az ve en fazla oyuncu sayısını buradan değiştirebilirsiniz: ${p.url}`,
  noRange: (p) =>
    `*${p.activityName}* yalnızca ${side(p.perSide)}. Başka formatlarda oynamak için en az ve en fazla oyuncu sayısını ayarlayın, örneğin *@Match Time 12 ile 16 kişi arası oynuyoruz*, ya da buradan: ${p.url}`,
  noSize: `Kaçar kişi? Örneğin *@Match Time 8'e 8 oynayalım*.`,
  noMatch: `Değiştirilecek yaklaşan bir maç yok.`,
  tooLate: `O maç başladı, formatı olduğu gibi kalıyor.`,

  suggestUp: (p) =>
    `${p.day} için ${p.total} kişiyiz, ${p.bench} kişi yedekte. ${side(p.perSide)} oynayalım mı? ` +
    `${p.admins}, bu mesaja *evet* diye yanıt verin, ben değiştireyim.`,

  oneMoreUp: (p) => `Yedeğe bir kişi daha gelirse organizatörler maçı ${side(p.perSide)} yapabilir.`,

  dmIn: (p) =>
    `${p.day} ${side(p.perSide)} oynuyoruz, kadrodasın. Gelemeyeceksen OUT yaz.` +
    (p.price ? ` Bu maçın ücretini maç başı ödersin, ${p.price}.` : ``),
  dmBench: (p) => `${p.day} ${side(p.perSide)} oynuyoruz, kadro ${p.places} kişiye indi ve şimdilik yedektesin.`,

  rosterHeader: (p) => `🔁 *${p.day} artık ${side(p.perSide)}* (${p.places} yer).`,
  rosterPlaying: (p) => `*Oynayanlar, ${p.places} kişiden ${p.confirmed}:*`,
  rosterBench: `*Yedekler:*`,
  rosterNobody: `Henüz kimse yok.`,

  pageSizesLabel: "Takım başına oyuncu",
  pageSizeButton: (p) => `${side(p.perSide)} (${p.places})`,
  pageCurrent: (p) => `Şu an ${side(p.perSide)}, ${p.places} kişiden ${p.confirmed} kişi var.`,
  pageWillPromote: (p) => `${p.count} oyuncu yedekten kadroya girer ve mesaj alır.`,
  pageWillBench: (p) => `${p.count} oyuncu yedeğe geçer ve mesaj alır.`,
  pageConfirm: "Formatı değiştir",
  pageDone: "Değişti. MatchTime yeni listeyi gruba atar.",
  pageInvalid: "Çift bir tam sayı girin ya da boş bırakın.",
};
