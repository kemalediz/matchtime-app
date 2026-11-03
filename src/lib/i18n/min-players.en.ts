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

  set: (p) =>
    `✅ Done. *${p.activityName}* goes ahead with *${p.minimum}* or more, so I'll only warn you when fewer than ${p.minimum} are in. The game still has ${p.places} places.`,
  cleared: (p) =>
    `✅ Done. *${p.activityName}* needs two full sides again, so I'll warn you when fewer than ${p.full} are in.`,
  alreadySet: (p) => `*${p.activityName}* already goes ahead with ${p.minimum} or more.`,
  alreadyFull: (p) => `*${p.activityName}* already needs two full sides (${p.full}).`,
  tooHigh: (p) => `*${p.activityName}* has ${p.places} places, so the minimum can be ${p.places} at most.`,
  tooLow: "The minimum has to be at least 2 players.",
  noNumber: (p) =>
    `I couldn't read the number. Tag me like this: *@Match Time minimum 12 players*, or set it here: ${p.url}`,
  whichGame: (p) =>
    `Which game do you mean: ${p.names.join(", ")}? Tag me with the day, for example *@Match Time minimum 12 players on Monday*, or set it here: ${p.url}`,
  noGame: (p) => `There's no weekly game set up yet. Add one here: ${p.url}`,

  label: "Minimum players",
  hint: (p) =>
    `The fewest you'll play with. Below this I warn you the day before and offer to cancel. Leave it empty for two full sides (${p.full}). The places don't change.`,
  row: (p) => `plays with ${p.minimum} or more`,
  invalid: (p) => `Enter a whole number from 2 to ${p.places}, or leave it empty.`,
};
