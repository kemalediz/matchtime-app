/** The fewest players a game is played with, in English. See `min-players.ts`. */
import type { MinPlayersCopy } from "./min-players";

export const MIN_PLAYERS_EN: MinPlayersCopy = {
  // The two nudges keep the words they had before the setting existed,
  // but for "13 of 14" (it was "13/14": no slash as a separator).
  lowNumbers: (p) =>
    `⚠️ *Low numbers*: ${p.confirmed} of ${p.maxPlayers} confirmed for *${p.activityName}* tomorrow.\n\n` +
    `Switch to *${p.switchTo}* (${p.switchPlayers} players) before the deadline?\n\n` +
    (p.audience === "dm"
      ? `Tap to open the admin panel (auto signs you in):\n${p.signInUrl}\n\nOr open: ${p.pageUrl}`
      : `Open the switch page:\n${p.signInUrl}`),
  matchInTrouble: (p) =>
    `🚨 *Match in trouble*: only *${p.confirmed}* confirmed for *${p.activityName}* tomorrow, below the minimum to play (${p.minimum}).\n\n` +
    `Cancel and refund the booking?\n\n` +
    (p.audience === "dm"
      ? `Tap to open the cancel page:\n${p.signInUrl}\n\nOr open: ${p.pageUrl}`
      : `Open the cancel page:\n${p.signInUrl}`),
};
