/**
 * What MatchTime says about a part of a message it could not carry out,
 * when one message gave it several instructions (2026-11-16, Vets:
 * "switch to 7aside, take Luca to bench, Zak is IN and then make the
 * teams", where two parts were dropped without a word).
 *
 * One object per language, typed by `MultiInstructionCopy`, so a line
 * missing in either language is a `tsc` error. House rules (unit tested in
 * `src/lib/i18n/__tests__/multi-instruction-copy.test.ts`): no em or en
 * dashes, no slash, Turkish never equal to English, one part read apart
 * from several.
 */
import { normaliseLang, type Lang } from "./lang";
import { MULTI_INSTRUCTION_EN } from "./multi-instruction.en";
import { MULTI_INSTRUCTION_TR } from "./multi-instruction.tr";

/** The parts of a message, named the way the group would name them. */
export type InstructionPart = "settings" | "squad" | "teams" | "question" | "result" | "other";

export interface MultiInstructionCopy {
  part: Record<InstructionPart, string>;
  /** The parts, already joined ("the teams", "the setting change and the
   *  teams"), and how many there are: one part reads apart from several. */
  notDone: (p: { parts: string; count: number }) => string;
  /** "A and B", "A, B and C". */
  join: (items: string[]) => string;
}

const BY_LANG: Record<Lang, MultiInstructionCopy> = { en: MULTI_INSTRUCTION_EN, tr: MULTI_INSTRUCTION_TR };

export function multiInstructionCopy(lang: Lang | string | null | undefined): MultiInstructionCopy {
  return BY_LANG[normaliseLang(lang)];
}
