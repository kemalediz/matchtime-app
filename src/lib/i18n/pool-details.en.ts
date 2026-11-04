/** The pool's question about his times and formats, in English. See `pool-details.ts`. */
import type { PoolDetailsCopy } from "./pool-details";

export const POOL_DETAILS_EN: PoolDetailsCopy = {
  question: (p) =>
    `So I only send games that suit you: what times can you play on ${p.days}? And which formats do you play: ${p.formats}? Just reply here in your own words, for example "after 7pm, 5 or 7-a-side". Your level too, if you like. Until then, any time on those days and any format counts as fine.`,
  ask: (p) =>
    `${p.name ? `${p.name}, one` : "One"} quick question so I only send you games that suit you: what times can you play on ${p.days}, and which formats do you play (${p.formats})? Reply here in your own words. Rather not say? No need to reply: any time and any format stay fine, and I won't ask again.\n\nChange your details any time: ${p.manageLink}`,
  saved: (p) =>
    `✅ Got it, saved: ${p.days}. Formats: ${p.formats}.\n\nTo change them, just message me here in your own words, or use your page: ${p.manageLink}`,
  reask: (p) =>
    `Sorry, I didn't quite get that. Which times can you play, and which formats? For example "Tuesdays after 7, 5 or 7-a-side". You can also set them on your page: ${p.manageLink}`,
  dayAnyTime: (day) => `${day} any time`,
  dayRanges: (day, ranges) => `${day} ${ranges}`,
  range: (from, to, untilLate) => (untilLate ? `from ${from}` : `${from} to ${to}`),
  formatsSaved: (list) => `${list}-a-side`,
  anyFormat: "any format",
  formatsChoice: (list) => `${list}-a-side`,
};
