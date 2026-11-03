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
};
