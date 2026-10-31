/** Quiet hours by WhatsApp, in English. See `quiet-hours-words.ts`. */
import type { QuietHoursWordsCopy } from "./quiet-hours-words";

const released = (n: number): string =>
  n === 1 ? "The message I was holding goes out now." : `The ${n} messages I was holding go out now.`;

export const QUIET_HOURS_WORDS_EN: QuietHoursWordsCopy = {
  off: (p) => `✅ Quiet hours are off. ${p.released > 0 ? released(p.released) : "I'll post at any time of day."}`,
  on: (p) =>
    `✅ Quiet hours are on, from ${p.from} to ${p.to}. I'll hold my messages in that time.` +
    (p.released > 0 ? `\n${released(p.released)}` : ""),
  alreadyOff: "Quiet hours are already off.",
  alreadyOn: (p) => `Quiet hours are already on, from ${p.from} to ${p.to}.`,
  badTime: (p) =>
    `I couldn't read those times. Tag me with them like this: *@Match Time quiet hours from 22:00 to 08:00*, or set them here: ${p.url}`,
  sameTime: (p) => `Quiet hours need two different times, for example from 22:00 to 08:00. You can also set them here: ${p.url}`,
};
