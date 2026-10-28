/** Setting the pitch by WhatsApp, in English. See `admin-venue.ts`. */
import type { AdminVenueCopy } from "./admin-venue";

export const ADMIN_VENUE_EN: AdminVenueCopy = {
  set: (p) =>
    `📍 Done, your pitch is *${p.name}*${p.address ? `, ${p.address}` : ""}.\n` +
    `Not the right place? Change it here: ${p.url}`,
  which: (p) =>
    `I found more than one place for *${p.words}*. Which one is it?\n` +
    p.options.map((o, i) => `${i + 1}. ${o}`).join("\n") +
    `\n\nTag me with the number, for example: *@Match Time 1*`,
  none: (p) => `I couldn't find *${p.words}* on the map. You can set your pitch here: ${p.url}`,
  unavailable: (p) => `I can't look places up right now. You can set your pitch here: ${p.url}`,
  noName: "Which pitch? Tag me with its name, for example: *@Match Time our pitch is Goals Sutton*",
  nothingToRetry: "👍 Thanks. There's nothing of mine waiting to try again.",
};
