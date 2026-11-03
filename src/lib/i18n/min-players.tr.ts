/** The fewest players a game is played with, in Turkish. See `min-players.ts`. */
import type { MinPlayersCopy } from "./min-players";

export const MIN_PLAYERS_TR: MinPlayersCopy = {
  lowNumbers: (p) =>
    `⚠️ *Oyuncu az*: yarınki *${p.activityName}* için ${p.maxPlayers} kişiden ${p.confirmed} kişi onayladı.\n\n` +
    `Son tarihten önce *${p.switchTo}* formatına (${p.switchPlayers} oyuncu) geçilsin mi?\n\n` +
    (p.audience === "dm"
      ? `Yönetim paneline girmek için dokunun (otomatik giriş yapar):\n${p.signInUrl}\n\nYa da açın: ${p.pageUrl}`
      : `Format değiştirme sayfasını açın:\n${p.signInUrl}`),
  matchInTrouble: (p) =>
    `🚨 *Maç tehlikede*: yarınki *${p.activityName}* için yalnızca *${p.confirmed}* kişi onayladı, oynamak için en az ${p.minimum} kişi gerekiyor.\n\n` +
    `Maç iptal edilip saha rezervasyonu iade edilsin mi?\n\n` +
    (p.audience === "dm"
      ? `İptal sayfasını açmak için dokunun:\n${p.signInUrl}\n\nYa da açın: ${p.pageUrl}`
      : `İptal sayfasını açın:\n${p.signInUrl}`),

  set: (p) =>
    `✅ Tamam. *${p.activityName}* en az *${p.minimum}* kişiyle oynanır, ${p.minimum} kişinin altına düşerse size haber veririm. Maçta yine ${p.places} yer var.`,
  cleared: (p) =>
    `✅ Tamam. *${p.activityName}* için yine iki tam takım gerekiyor, ${p.full} kişinin altına düşerse size haber veririm.`,
  alreadySet: (p) => `*${p.activityName}* zaten en az ${p.minimum} kişiyle oynanıyor.`,
  alreadyFull: (p) => `*${p.activityName}* için zaten iki tam takım (${p.full} kişi) gerekiyor.`,
  tooHigh: (p) => `*${p.activityName}* maçında ${p.places} yer var, en az oyuncu sayısı en fazla ${p.places} olabilir.`,
  tooLow: "En az oyuncu sayısı 2 veya daha fazla olmalı.",
  noNumber: (p) =>
    `Sayıyı anlayamadım. Beni şöyle etiketleyin: *@Match Time en az 12 kişi*, ya da buradan ayarlayın: ${p.url}`,
  whichGame: (p) =>
    `Hangi maçı kastediyorsunuz: ${p.names.join(", ")}? Günü de yazarak etiketleyin, örneğin *@Match Time pazartesi en az 12 kişi*, ya da buradan ayarlayın: ${p.url}`,
  noGame: (p) => `Henüz haftalık maç ayarlanmamış. Buradan ekleyin: ${p.url}`,

  label: "En az oyuncu",
  hint: (p) =>
    `Oynamaya razı olduğunuz en az kişi sayısı. Bunun altına düşerse bir gün önce size haber verir, iptal etmeyi öneririm. İki tam takım (${p.full}) için boş bırakın. Yer sayısı değişmez.`,
  row: (p) => `en az ${p.minimum} kişiyle oynanır`,
  invalid: (p) => `2 ile ${p.places} arasında tam sayı girin ya da boş bırakın.`,
};
