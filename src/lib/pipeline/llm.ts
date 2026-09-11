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
 * ─────────────────────────────────────────────────────────────────────
 * THE MINIMUM CACHEABLE PREFIX IS A TOKEN COUNT, AND IT IS PER MODEL
 * ─────────────────────────────────────────────────────────────────────
 *
 * What stood here was `MIN_CACHEABLE_CHARS = 4_000`, with the note "the
 * router prompt is ~360 tokens and will never cache, so we do not
 * pretend". Both halves were wrong, and
 * `MDs/router-accuracy-2026-09-11.md` §3.3 is where they were caught:
 *
 *   - the router prompt was **669 tokens**, not ~360 (measured with
 *     `messages.count_tokens` against `claude-haiku-4-5`);
 *   - 4,000 CHARACTERS is about 1,000 tokens, which is a **Sonnet**
 *     threshold applied to a **Haiku** call. Haiku 4.5's minimum is
 *     **4,096 tokens** — roughly 15,500 characters of this pipeline's
 *     English, four times what the constant allowed for.
 *
 * That was harmless only while the router prompt was short. §3.1's
 * rewrite is 9,608 characters, which clears 4,000 and does not come
 * close to 4,096 tokens — so under the old rule every router call would
 * have reported `cacheAttempted: true` and cached **nothing**. Probed
 * live on 2026-09-11, that exact prompt with a marker attached:
 *
 *     claude-haiku-4-5, 9,608 chars / 2,554 tokens
 *       call 1: input=2560  cache_creation=0  cache_read=0
 *       call 2: input=2560  cache_creation=0  cache_read=0
 *
 * `cacheAttempted` exists so a sweep can say whether caching was asked
 * for. A field that says "asked for" on a request that can never get it
 * is worse than no field — it is §8.5's audit note ("several
 * `cache_control` markers sit on prompts below the minimum cacheable
 * prefix and are silent no-ops") rebuilt inside the fix for it.
 *
 * ⚠️ ONE PROMPT IN THIS PIPELINE REALLY DOES CACHE, AND THIS CHANGE
 * MUST NOT TAKE IT. `EXTRACTOR_PROMPTS.attendance` is 5,261 characters
 * — over the old character rule, and the brief for this change believed
 * it was therefore a silent no-op. It is not. The extractors run
 * `claude-sonnet-5`, whose minimum is 1,024 tokens, and that prompt is
 * 1,778 of them. Probed on 2026-09-11:
 *
 *     claude-sonnet-5, extractor attendance, 5,261 chars
 *       call 1: input=14  cache_creation=1773  cache_read=0
 *       call 2: input=14  cache_creation=0     cache_read=1773
 *
 * So the regression to guard against here is losing a cache that
 * works, not removing one that never did — which is why the estimator
 * below under-counts on Sonnet by a wide margin and this prompt still
 * clears the threshold. `__tests__/cache-threshold.test.ts` pins it.
 *
 * THE MINIMUMS ARE NOT MONOTONE ACROSS GENERATIONS, which is the whole
 * reason one constant cannot serve: the newest model has the lowest
 * minimum and Haiku 4.5 has the highest. Published figures
 * (anthropic.com, prompt caching), all confirmed against this
 * pipeline's own prompts.
 */
export const MIN_CACHEABLE_TOKENS: Record<string, number> = {
  "claude-opus-5": 512,
  "claude-sonnet-5": 1_024,
  "claude-sonnet-4-5": 1_024,
  "claude-haiku-4-5": 4_096,
};

/**
 * An id nobody has measured gets the most demanding minimum we know of.
 * A new model is cleared by the corpus (§11.3), and until it is, the
 * safe answer to "would this cache?" is "assume not" — claiming a cache
 * we did not get is the defect this whole block exists to remove.
 */
export const DEFAULT_MIN_CACHEABLE_TOKENS = 4_096;

/**
 * A DELIBERATE UNDER-COUNT. Measured with `messages.count_tokens` on
 * 2026-09-11 across every prompt this pipeline sends:
 *
 *     claude-haiku-4-5   3.78 – 5.08 characters per token
 *     claude-sonnet-5    2.78 – 2.98 characters per token
 *
 * Dividing by four sits at or below the real Haiku count and a long way
 * below the Sonnet one, so the estimate errs towards NOT attaching a
 * marker. That is the direction that matters: a declined marker costs a
 * cache read we might have had, and a wrongly attached one costs the
 * truth of `cacheAttempted`.
 *
 * It is an estimate on purpose. `count_tokens` is a network round trip,
 * and spending one on every call to decide whether to save money on
 * that call is the wrong trade by an order of magnitude.
 */
export function estimateTokens(text: string): number {
  return Math.floor(text.length / 4);
}

/** Does this system prompt clear this model's minimum cacheable prefix? */
export function shouldCachePrompt(model: string, system: string): boolean {
  const min = MIN_CACHEABLE_TOKENS[model] ?? DEFAULT_MIN_CACHEABLE_TOKENS;
  return estimateTokens(system) >= min;
}

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
  /**
   * `"off"` sends `thinking: {type: "disabled"}`. Omitted sends nothing.
   *
   * ── WHY THIS FIELD EXISTS (measured 2026-09-06, §10 step 8) ────────
   *
   * `claude-sonnet-5` runs ADAPTIVE THINKING when `thinking` is omitted.
   * On a self-contradictory message it can spend the ENTIRE `max_tokens`
   * budget deliberating and return `stop_reason: max_tokens` with
   * `thinking` blocks and NO text block at all — probed directly at
   * 1,024, 2,048 and 4,096 tokens, zero text every time, 5 runs of 5.
   * The truncation guard below then throws, correctly, and the message
   * gets no answer.
   *
   * Raising the cap does not fix it; it just buys a bigger bill for the
   * same silence. Turning thinking off does, because the extractors were
   * never meant to reason: §6.2's whole contract is "FACTS about the
   * text only… No intent… No `reasoning` prose", and
   * `output_config.format` gives the answer nowhere to put a
   * deliberation anyway.
   *
   * OPT-IN rather than default-off, and per model rather than global:
   * `{type: "disabled"}` is accepted on `claude-sonnet-5` but the router
   * runs `claude-haiku-4-5`, an older model with a different thinking
   * contract, and nothing here needs to send it a parameter it may not
   * take. The extractors ask; the router does not.
   */
  thinking?: "off";
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

/**
 * The one method this file uses. Injecting it is what lets
 * `__tests__/cache-threshold.test.ts` assert the REQUEST BODY — that a
 * `cache_control` marker is or is not on it — rather than assert the
 * predicate and hope the call site agrees. Production never passes it.
 */
export interface MessagesCreateClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export function anthropicModel(opts?: {
  apiKey?: string;
  client?: MessagesCreateClient;
}): PipelineModel {
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
      //
      // ── THE SECOND DEFENCE CHANGED ON 2026-09-06 (§10 step 8) ──────
      //
      // This comment used to end: "It is the FIRST of two defences:
      // `attendance-engine-batch.ts` hands a message whose extraction
      // still failed back to the ANALYZER rather than letting it go
      // silent." There is no analyzer. A failed extraction now means
      // MatchTime says nothing and an admin gets a DM.
      //
      // So the second defence moved INTO the pipeline:
      // `extractors.ts:extractForRoute` retries once, on the four routes
      // that end in an attendance write and no others. It is a genuinely
      // different retry from this one and both are needed — this one
      // covers the transport class the SDK knows about, that one covers
      // a response the strict schema rejects, which the SDK considers a
      // successful call. Neither subsumes the other.
      const client: MessagesCreateClient =
        opts?.client ?? new Anthropic({ apiKey, maxRetries: 4 });
      const cacheAttempted = shouldCachePrompt(req.model, req.system);
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
        // See `ModelRequest.thinking`. Sent ONLY when the caller asked;
        // an omitted parameter and `{type: "adaptive"}` mean the same
        // thing on sonnet-5, and sending nothing keeps this layer honest
        // about which callers made a decision and which did not.
        ...(req.thinking === "off" ? { thinking: { type: "disabled" as const } } : {}),
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
