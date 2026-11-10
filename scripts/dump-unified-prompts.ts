/**
 * Writes the UNIFIED_ANSWERS prompts to MDs/ (no model call, $0):
 * the question extractor's old prompt (flag off) and new one (flag on), and
 * the unified answer's system prompt. Prints each size.
 *
 *   ./node_modules/.bin/tsx scripts/dump-unified-prompts.ts
 */
import { writeFileSync } from "node:fs";
import { EXTRACTOR_PROMPTS } from "../src/lib/pipeline/extractors.ts";
import { UNIFIED_QUESTION_PROMPT } from "../src/lib/pipeline/unified-question.ts";
import { UNIFIED_ANSWER_SYSTEM } from "../src/lib/pipeline/unified-answer.ts";
import { OPEN_ANSWER_SYSTEM } from "../src/lib/pipeline/open-answer.ts";

const out: Array<[string, string]> = [
  ["MDs/prompt-question-unified-old-2026-11-10.txt", EXTRACTOR_PROMPTS.question],
  ["MDs/prompt-question-unified-new-2026-11-10.txt", UNIFIED_QUESTION_PROMPT],
  ["MDs/prompt-unified-answer-2026-11-10.txt", UNIFIED_ANSWER_SYSTEM],
];
for (const [path, text] of out) {
  writeFileSync(path, text + "\n");
  console.log(`${path}: ${text.length} characters, about ${Math.round(text.length / 2.6)} tokens at 2.6 a token`);
}
console.log(`(the open answer's prompt, for comparison: ${OPEN_ANSWER_SYSTEM.length} characters)`);
