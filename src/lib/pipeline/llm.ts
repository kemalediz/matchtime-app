/**
 * THE ONLY PLACE IN THIS DIRECTORY THAT TALKS TO A MODEL.
 *
 * Stages 1 and 2 take a `PipelineModel` rather than constructing an
 * Anthropic client, so every test in `__tests__` runs against a fake and
 * the live sweep runs against the real thing with no branch in between.
 *
 * §8.5 — "the estate has 11 `messages.create` sites; do not add one
 * without a `max_tokens` derived from `MAX_TOKENS_CEILING`". This file
 * adds the twelfth, and it is why the cap below is a named constant tied
 * to the project ceiling by a test rather than a number typed out:
 *
 *   2026-05-26  analyzeBatch at the model max → the whole analyzer dead
 *               for 30 minutes.
 *   2026-08-31  composeChaseText and the dropped-verdict re-prompt, both
 *               at 64000 → both had NEVER once succeeded, silently,
 *               since May, because the SDK refuses the request locally.
 *
 * The companion guard requires every `messages.create` file to check
 * `stop_reason` or be a documented fail-closed site. This one CHECKS:
 * a truncated router response would silently lose messages, which is
 * precisely the failure §11.1 says must never be silent.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Degradation } from "./types";

/**
 * The project ceiling, MIRRORED rather than imported.
 *
 * `MAX_TOKENS_CEILING` lives in `message-analyzer.ts`, which imports the
 * Prisma client; importing it here would make the whole pipeline
 * unloadable in the Playwright worker, and the corpus could not judge
 * this pipeline at all. So the relationship is asserted by a test
 * instead — `__tests__/max-tokens-derivation.test.ts` imports BOTH and
 * fails if this value ever exceeds the shared ceiling. The source-
 * scanning guard in `max-tokens-ceiling.test.ts` still statically bounds
 * the call site below, because `Math.min(<const>, …)` resolves through
 * the same constant table.
 *
 * 4,096 rather than 16,384 on purpose: the router emits ~140 tokens for
 * a batch of eight and an extractor ~180 for one message. Nothing here
 * has any business generating more than a page of JSON, and a tight cap
 * turns a runaway into a caught `TruncatedResponseError` rather than a
 * bill.
 */
export const PIPELINE_MAX_TOKENS_CEILING = 4_096;

/**
 * §8.3 proposes Haiku 4.5 for the router and Sonnet 5 for the
 * extractors. Both are PINNED (§11.3: "model ids are pinned"), because
 * a model upgrade can change how a schema field is populated without
 * changing its shape, and the corpus is what clears a new id.
 */
export const ROUTER_MODEL = "claude-haiku-4-5";
export const EXTRACTOR_MODEL = "claude-sonnet-5";

/** USD per million tokens. anthropic.com/pricing, 2026-09-01. */
const RATES: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  "claude-opus-5": { input: 5.0, output: 25.0 },
};

/**
 * A cached prefix has a MINIMUM length (1,024 tokens on Sonnet, higher
 * on Haiku). §8.5's audit note: "several `cache_control` markers sit on
 * prompts below the minimum cacheable prefix and are silent no-ops."
 * The router prompt is ~360 tokens and will never cache, so we do not
 * pretend: the marker is only attached above this threshold, and the
 * decision is reported in `cacheAttempted` so a sweep can show whether
 * caching was even asked for.
 */
const MIN_CACHEABLE_CHARS = 4_000;

export interface ModelRequest {
  model: string;
  /** The stable prefix. Cached when long enough to be cacheable. */
  system: string;
  /** The per-call content. Never cached. */
  user: string;
  /** Clamped against PIPELINE_MAX_TOKENS_CEILING at the call site. */
  maxTokens: number;
  /** Structured output. `output_config.format`, not a tool. */
  schema?: Record<string, unknown>;
  /** Appears in logs and in the cost breakdown. */
  label: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelResponse {
  text: string;
  stopReason: string | null;
  usage: ModelUsage;
  costUsd: number | null;
  ms: number;
  cacheAttempted?: boolean;
}

export interface PipelineModel {
  readonly name: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export function costOf(model: string, usage: ModelUsage): number | null {
  const rate = RATES[model];
  if (!rate) return null;
  // Cache reads bill at 0.1x input, 1-hour writes at 2x. We use the
  // default 5-minute TTL, which writes at 1.25x.
  const input =
    usage.inputTokens + usage.cacheReadTokens * 0.1 + usage.cacheWriteTokens * 1.25;
  return (input / 1_000_000) * rate.input + (usage.outputTokens / 1_000_000) * rate.output;
}

/** Thrown when the model ran out of room. Callers degrade; they never
 *  parse half a JSON document and pretend it is an answer. */
export class TruncatedResponseError extends Error {
  constructor(label: string, maxTokens: number) {
    super(
      `${label}: the model hit max_tokens (${maxTokens}) and the response is cut off. ` +
        `Refusing to parse a truncated body.`,
    );
    this.name = "TruncatedResponseError";
  }
}

export function anthropicModel(opts?: { apiKey?: string }): PipelineModel {
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY;
  return {
    name: "anthropic",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
      // RETRIES, RAISED FROM THE SDK DEFAULT OF 2, and this is not a
      // tuning preference.
      //
      // §10 step 6 puts these calls on the WRITE path, and the failure
      // mode of a call that gives up is a player who said IN not being
      // in the squad. The first live corpus sweep of that step measured
      // 27 `529 Overloaded` and 3 `500`s across 10 messages in one run
      // — the analyzer, making one call per BATCH, rode the same window
      // out while the engine, making one per MESSAGE and fanning them
      // out in parallel, did not.
      //
      // The SDK retries 408/409/429/5xx with exponential backoff, which
      // is exactly this class. Four attempts rather than two costs a
      // few seconds on a bad minute and nothing at all on a good one.
      // It is the FIRST of two defences: `attendance-engine-batch.ts`
      // hands a message whose extraction still failed back to the
      // analyzer rather than letting it go silent.
      const client = new Anthropic({ apiKey, maxRetries: 4 });
      const cacheAttempted = req.system.length >= MIN_CACHEABLE_CHARS;
      const t0 = Date.now();
      const resp = await client.messages.create({
        model: req.model,
        // Clamped here rather than trusted from the caller, so a new
        // stage cannot reintroduce the 64000 bug by passing its own
        // number. See PIPELINE_MAX_TOKENS_CEILING above.
        max_tokens: Math.min(PIPELINE_MAX_TOKENS_CEILING, req.maxTokens),
        system: [
          {
            type: "text" as const,
            text: req.system,
            ...(cacheAttempted ? { cache_control: { type: "ephemeral" as const } } : {}),
          },
        ],
        messages: [{ role: "user" as const, content: req.user }],
        ...(req.schema
          ? { output_config: { format: { type: "json_schema" as const, schema: req.schema } } }
          : {}),
      });
      const ms = Date.now() - t0;

      // TRUNCATION — the companion guard's requirement, and a real risk
      // here: a router response cut off mid-array silently loses the
      // messages after the cut, which is the exact §11.1 failure.
      if (resp.stop_reason === "max_tokens") {
        throw new TruncatedResponseError(req.label, req.maxTokens);
      }

      const text = resp.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("");

      const usage: ModelUsage = {
        inputTokens: resp.usage.input_tokens ?? 0,
        outputTokens: resp.usage.output_tokens ?? 0,
        cacheReadTokens: resp.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: resp.usage.cache_creation_input_tokens ?? 0,
      };

      return {
        text,
        stopReason: resp.stop_reason ?? null,
        usage,
        costUsd: costOf(req.model, usage),
        ms,
        cacheAttempted,
      };
    },
  };
}

/**
 * Pull the first balanced JSON object out of a model response.
 *
 * With `output_config.format` this should be the whole body, so most of
 * `safeParseJson`'s fence-stripping (§9: "dies — structured output")
 * is unnecessary. It is kept as a narrow fallback because a model that
 * ignores the format still has to fail LOUDLY rather than throw a raw
 * SyntaxError two stack frames away from anything readable.
 */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON object in the response");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("unterminated JSON object in the response");
}

export function degradation(
  stage: Degradation["stage"],
  messageId: string | null,
  detail: string,
): Degradation {
  return { stage, messageId, detail };
}
