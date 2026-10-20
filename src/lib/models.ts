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
 *
 * 2026-10-19: moved from `claude-haiku-4-5` to `claude-haiku-5-5`
 * ($0.10 / $0.50 per MTok against $1 / $5). Its newer tokenizer counts
 * the same text about 30% higher.
 */
export const HAIKU_MODEL = "claude-haiku-5-5";

/**
 * HOW EVERY HAIKU CALL THINKS: adaptively, at medium effort.
 *
 * Haiku 4.5 thought only when handed a token budget, and these sites never
 * gave it one. Haiku 5.5 takes no budget at all (`thinking.type.enabled`
 * is a 400: "Use thinking.type.adaptive and output_config.effort"), so the
 * one control is effort. Measured 2026-10-19 on the dev key, the same
 * regression cases 3 runs each, prompts byte-identical, five arms
 * (Haiku 4.5; Haiku 5.5 thinking off; low; medium; high):
 *
 *   thinking off   lost 4.5's payment claims ("done 👍", "hallettim
 *                  parayı": 0/3) and 7 of 9 router cases
 *   low            payment claims back, router still 4 of 9 short
 *   medium         payment claims 3/3, hq-questions 55/55 (4.5: 54/55),
 *                  hq-mom 15/15, score-extractor 47/47
 *   high           no better than medium, and the setup reading spent
 *                  all 4,096 tokens thinking (truncated, 3 of 10 calls)
 *
 * `medium` is also Haiku 5.5's default; it is stated, not omitted, so the
 * decision is visible. The raw SDK call sites spread this object; the
 * pipeline's `ModelRequest.thinking` takes `{ effort: HAIKU_EFFORT }`.
 */
export const HAIKU_EFFORT = "medium" as const;
export const HAIKU_THINKING = {
  thinking: { type: "adaptive" as const },
  output_config: { effort: HAIKU_EFFORT },
};

/**
 * max_tokens for a Haiku call whose ANSWER is a short JSON object (the DM
 * classifiers, onboarding extraction). Thinking shares the budget: the 200
 * these sites sent for Haiku 4.5 is less than one thinking pass (measured:
 * 194 thinking tokens on one DM classification, and the answer cut off).
 * At medium effort the largest such call seen used 568 tokens in all.
 */
export const HAIKU_SHORT_ANSWER_MAX_TOKENS = 1_024;
