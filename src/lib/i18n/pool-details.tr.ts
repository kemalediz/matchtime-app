/** The pool's question about his times and formats, in Turkish. See `pool-details.ts`. */
import type { PoolDetailsCopy } from "./pool-details";

export const POOL_DETAILS_TR: PoolDetailsCopy = {
  question: (p) =>
    `Sana uygun maçları göndermem için: ${p.days} günleri hangi saatlerde oynayabilirsin? Hangi formatlarda oynuyorsun: ${p.formats}? Buraya kendi cümlelerinle yazman yeterli, örneğin "akşam 7'den sonra, 5 ya da 7 kişilik". İstersen seviyeni de yaz. O zamana kadar bu günlerde her saat ve her format uygun sayılır.`,
  ask: (p) =>
    `${p.name ? `${p.name}, sana` : "Sana"} uygun maçları göndermem için kısa bir soru: ${p.days} günleri hangi saatlerde oynayabilirsin, hangi formatlarda oynuyorsun (${p.formats})? Buraya kendi cümlelerinle yaz. Söylemek istemezsen cevap vermene gerek yok: her saat ve her format uygun sayılmaya devam eder, bir daha sormam.\n\nBilgilerini istediğin zaman değiştirebilirsin: ${p.manageLink}`,
  saved: (p) =>
    `✅ Tamam, kaydettim: ${p.days}. Formatlar: ${p.formats}.\n\nDeğiştirmek için bana buradan kendi cümlelerinle yazman yeterli, ya da sayfanı kullan: ${p.manageLink}`,
  reask: (p) =>
    `Kusura bakma, tam anlayamadım. Hangi saatlerde ve hangi formatlarda oynayabilirsin? Örneğin "salı akşam 7'den sonra, 5 ya da 7 kişilik". İstersen sayfandan da ayarlayabilirsin: ${p.manageLink}`,
  dayAnyTime: (day) => `${day} her saat`,
  dayRanges: (day, ranges) => `${day} ${ranges}`,
  range: (from, to, untilLate) => (untilLate ? `${from} ve sonrası` : `${from} ile ${to} arası`),
  formatsSaved: (list) => `${list} kişilik`,
  anyFormat: "her format",
  formatsChoice: (list) => `${list} kişilik`,
};
