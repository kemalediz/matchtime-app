/** A part of a several-instruction message not done, in English. See `multi-instruction.ts`. */
import type { MultiInstructionCopy } from "./multi-instruction";

const join = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

export const MULTI_INSTRUCTION_EN: MultiInstructionCopy = {
  part: {
    settings: "the setting change",
    squad: "the squad change",
    teams: "the teams",
    question: "the question",
    result: "the result",
    other: "the rest",
  },
  notDone: (p) =>
    p.count === 1
      ? `I couldn't do this part of your message: ${p.parts}. Please ask me for it on its own.`
      : `I couldn't do these parts of your message: ${p.parts}. Please ask me for them one at a time.`,
  join,
};
