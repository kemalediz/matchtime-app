/**
 * The pipeline's own `max_tokens` cap, tied to the project ceiling.
 *
 * PR #30's guard (`src/lib/__tests__/max-tokens-ceiling.test.ts`) scans
 * every `max_tokens:` in `src/` and fails the build on anything it
 * cannot statically bound below 16,384. That covers this file's call
 * site through `Math.min(PIPELINE_MAX_TOKENS_CEILING, …)`.
 *
 * What it does NOT cover is the RELATIONSHIP: `llm.ts` cannot import
 * `MAX_TOKENS_CEILING`, because `message-analyzer.ts` imports the Prisma
 * client and the whole pipeline has to stay loadable in the Playwright
 * worker (`e2e/sim/group.ts`: "no Prisma in the Playwright process") so
 * the corpus can judge it at all.
 *
 * A mirrored constant with a comment is exactly the thing that has
 * drifted three times in this codebase, so it is asserted here instead —
 * this test CAN import both, because vitest runs in plain node.
 */
import { describe, it, expect } from "vitest";
import { MAX_TOKENS_CEILING } from "../../message-analyzer";
import { PIPELINE_MAX_TOKENS_CEILING } from "../llm";

/** The SDK's own hard limit: 60*60*N/128000 > 600 throws, LOCALLY,
 *  before any network call. */
const SDK_NONSTREAMING_LIMIT = Math.floor((600 * 128_000) / 3_600);

describe("PIPELINE_MAX_TOKENS_CEILING", () => {
  it("never exceeds the shared project ceiling", () => {
    expect(
      PIPELINE_MAX_TOKENS_CEILING,
      `src/lib/pipeline/llm.ts mirrors MAX_TOKENS_CEILING rather than ` +
        `importing it (message-analyzer.ts pulls in Prisma). Raising the ` +
        `mirror above the real ceiling reintroduces the class of bug that ` +
        `killed the analyzer on 2026-05-26 and silently disabled the chase ` +
        `composer and the dropped-verdict retry from May to August 2026.`,
    ).toBeLessThanOrEqual(MAX_TOKENS_CEILING);
  });

  it("stays well below the SDK's non-streaming limit", () => {
    expect(PIPELINE_MAX_TOKENS_CEILING).toBeLessThanOrEqual(SDK_NONSTREAMING_LIMIT);
  });

  it("is big enough for the outputs these stages actually produce", () => {
    // Router ~140 output tokens for a batch of eight; an extractor ~180
    // for one message (§8.3, measured). A cap under ~512 would start
    // truncating real responses, which the truncation check turns into a
    // thrown TruncatedResponseError rather than a silent half-answer.
    expect(PIPELINE_MAX_TOKENS_CEILING).toBeGreaterThanOrEqual(1_024);
  });
});
