/** Birkaç talimatlı bir mesajın yapılamayan kısmı, Türkçe. Bkz. `multi-instruction.ts`. */
import type { MultiInstructionCopy } from "./multi-instruction";

const join = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ve ${items[items.length - 1]}`;

export const MULTI_INSTRUCTION_TR: MultiInstructionCopy = {
  part: {
    settings: "ayar değişikliği",
    squad: "kadro değişikliği",
    teams: "takımlar",
    question: "soru",
    result: "skor",
    other: "geri kalanı",
  },
  notDone: (p) =>
    p.count === 1
      ? `Mesajındaki şu kısmı yapamadım: ${p.parts}. Lütfen bunu ayrı bir mesajla iste.`
      : `Mesajındaki şu kısımları yapamadım: ${p.parts}. Lütfen bunları ayrı ayrı iste.`,
  join,
};
