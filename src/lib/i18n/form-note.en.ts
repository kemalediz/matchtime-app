/** A form note with its amount, in English. See `form-note.ts`. */
import type { FormNoteCopy } from "./form-note";

export const FORM_NOTE_EN: FormNoteCopy = {
  amountFor: (p) => (p.reason ? `${p.amount} for ${p.name} (${p.reason})` : `${p.amount} for ${p.name}`),
  noneFor: (p) => `no adjustment for ${p.name}`,
  saved: (p) => `Noted: ${p.parts} in ${p.day}'s game.`,
  changed: (p) => `Changed: ${p.parts} in ${p.day}'s game.`,
  capped: "1 is the most either way.",
  teamsMade: "The teams are already made, so it counts if they are made again.",
  others: "What was said about anyone else I'll take into account when the teams are made.",
  amendHint: (p) => `Want a different amount? Tag me, e.g. make it ${p.example}.`,
};
