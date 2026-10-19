/**
 * THE HAIKU MODEL ID, IN ONE PLACE.
 *
 * Every Haiku call site (the router, the DM-surface classifiers, the
 * setup reading and picture reading) names its model through this
 * constant, so moving the whole Haiku tier to a new model is a one-line
 * change here and the corpus is what clears it (pipeline/llm.ts, §11.3:
 * "model ids are pinned").
 *
 * No imports, on purpose: the classifiers, the pipeline and the
 * Playwright harnesses all load this file, and none of them may pull in
 * Prisma through it.
 *
 * The model-pin guard (`__tests__/no-sonnet-4-5-pins.test.ts`) reads this
 * file to resolve call sites that name `HAIKU_MODEL`, so keep it a plain
 * string literal.
 */
export const HAIKU_MODEL = "claude-haiku-4-5";
