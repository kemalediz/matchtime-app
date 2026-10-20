/**
 * THE METERED MODEL FOR THE DM CLASSIFIER DRY RUNS (quoted-reply context
 * S3, 2026-10-20). The fee-confirm, roster-survey, dm-intent and dm-qa dry
 * runs each send the production request's exact shape (model, max_tokens,
 * thinking posture, the cached system block) and need the same three
 * things: the calls counted, the cost priced from the real usage on the
 * production rate table, and a hard stop at a cap. Never use it outside a
 * script started on the dev key (`spendDevApiKeyOrExit`).
 */
import Anthropic from "@anthropic-ai/sdk";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { costOf, systemBlock } from "../src/lib/pipeline/llm.ts";
import { HAIKU_MODEL, HAIKU_SHORT_ANSWER_MAX_TOKENS, HAIKU_THINKING, SONNET_MODEL } from "../src/lib/models.ts";

/** One arm: a model and how it thinks, as the site ships it. */
export interface DryRunArm {
  name: string;
  model: string;
  maxTokens: number;
  /** `HAIKU_THINKING` for Haiku 5.5, thinking disabled for Sonnet 5. */
  thinking: "haiku" | "off";
}

/** The DM classifiers' production call (Haiku 5.5, adaptive medium). */
export const HAIKU_CLASSIFIER_ARM: DryRunArm = {
  name: "haiku",
  model: HAIKU_MODEL,
  maxTokens: HAIKU_SHORT_ANSWER_MAX_TOKENS,
  thinking: "haiku",
};

/** dm-qa's call until 2026-10-20 (Sonnet 5, thinking off, 600 tokens): the
 *  "old" and "sonnet" arms of scripts/dryrun-dm-qa.ts. Its production arm
 *  now is built there from `DM_QA_CALL` and `DM_QA_MAX_TOKENS`. */
export const SONNET_DM_QA_ARM: DryRunArm = { name: "sonnet", model: SONNET_MODEL, maxTokens: 600, thinking: "off" };


export interface Meter {
  /** The model, as the classifiers' `call` seam takes it. */
  call: (system: string, user: string) => Promise<string>;
  /** The same, with the stop reason (dm-qa's truncation guard reads it). */
  callFull: (system: string, user: string) => Promise<{ text: string | null; truncated: boolean }>;
  calls: () => number;
  usd: () => number;
  /** The raw text of the last answer, for a seam that returns only the label. */
  lastRaw: () => string;
  summary: () => string;
}

export function meter(harness: string, arm: DryRunArm, maxUsd: number): Meter {
  // The DEVELOPER's key, never production's (refuses without it).
  const anthropic = new Anthropic({ apiKey: spendDevApiKeyOrExit(harness) });
  let calls = 0;
  let usd = 0;
  let last = "";
  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const callFull = async (system: string, user: string) => {
    if (usd >= maxUsd) throw new Error(`cost cap $${maxUsd} reached after ${calls} calls`);
    const r = await anthropic.messages.create({
      model: arm.model,
      max_tokens: arm.maxTokens,
      ...(arm.thinking === "haiku" ? HAIKU_THINKING : { thinking: { type: "disabled" as const } }),
      system: systemBlock(system),
      messages: [{ role: "user", content: user }],
    });
    calls++;
    const u = r.usage;
    tokens.input += u.input_tokens;
    tokens.output += u.output_tokens;
    tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
    tokens.cacheRead += u.cache_read_input_tokens ?? 0;
    // Every write here is a 1-hour one (the system block asks for it).
    usd =
      costOf(arm.model, {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadTokens: tokens.cacheRead,
        cacheWriteTokens: tokens.cacheWrite,
        cacheWrite1hTokens: tokens.cacheWrite,
      }) ?? Infinity;
    const block = r.content.find((b) => b.type === "text");
    last = block && block.type === "text" ? block.text : "";
    return { text: block && block.type === "text" ? block.text : null, truncated: r.stop_reason === "max_tokens" };
  };
  return {
    call: async (system, user) => (await callFull(system, user)).text ?? "",
    callFull,
    calls: () => calls,
    usd: () => usd,
    lastRaw: () => last,
    summary: () =>
      `${calls} live calls on ${arm.model}. tokens: in ${tokens.input}, out ${tokens.output}, ` +
      `cache write ${tokens.cacheWrite}, cache read ${tokens.cacheRead}. cost ≈ $${usd.toFixed(4)}`,
  };
}
