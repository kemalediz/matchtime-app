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
import { guardedModelCall } from "../ai-budget-context";
import { HAIKU_EFFORT, HAIKU_MODEL, SONNET_MODEL } from "../models";

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
export const ROUTER_MODEL = HAIKU_MODEL;
// The Sonnet extractors' model. Each extractor's own call (model and
// thinking) is `EXTRACTOR_CALLS` in extractors.ts: teams, score and admin
// run on Haiku 5.5 since 2026-10-20.
export const EXTRACTOR_MODEL = SONNET_MODEL;

/**
 * HOW EACH MODEL FAMILY IS CALLED THROUGH THIS PIPELINE (2026-10-20): the
 * model id and the thinking posture that goes with it, as one value, so a
 * site that moves family moves both and a live check runs exactly what the
 * site ships. Sonnet 5 with thinking off (see `ModelRequest.thinking`);
 * Haiku 5.5 adaptive at `HAIKU_EFFORT` (src/lib/models.ts). A site spreads
 * one into its request and sizes `maxTokens` for the Haiku one, whose
 * thinking shares the budget.
 */
export const SONNET_CALL = { model: SONNET_MODEL, thinking: "off" } as const satisfies Pick<ModelRequest, "model" | "thinking">;
export const HAIKU_CALL = {
  model: HAIKU_MODEL,
  thinking: { effort: HAIKU_EFFORT },
} as const satisfies Pick<ModelRequest, "model" | "thinking">;
export type ModelCall = typeof SONNET_CALL | typeof HAIKU_CALL;

/** USD per million tokens. anthropic.com/pricing, 2026-09-01; Haiku 5.5
 *  from platform.claude.com/docs/en/about-claude/pricing, 2026-10-19,
 *  the rate for prompts up to 100,000 tokens (over that it is $0.50 /
 *  $2.50; nothing this app sends comes near). */
const RATES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  "claude-opus-5": { input: 5.0, output: 25.0 },
};

/**
 * ─────────────────────────────────────────────────────────────────────
 * THE MINIMUM CACHEABLE PREFIX, PER MODEL. A REFERENCE, NOT A GATE.
 * ─────────────────────────────────────────────────────────────────────
 *
 * A `cache_control` marker on a prefix shorter than the model's minimum
 * is ignored by the API: no error, no write, no charge (platform.claude.
 * com, prompt caching). So every call carries the marker (`systemBlock`)
 * and the API decides; whether a call really cached is what it reports in
 * `usage`, which `guardedAnthropicCall` logs per label. This table is for
 * reading those logs and for tests that check a prompt is long enough for
 * its marker to do something.
 *
 * WHY THERE IS NO GATE ANY MORE (2026-10-19). What stood here was
 * `shouldCachePrompt`: attach the marker only when `system.length / 4`
 * cleared this table. It looked at the system prompt alone, but the
 * cached prefix is the system prompt PLUS the structured-output schema,
 * and these prompts do not run at four characters per token. MEASURED
 * with `count_tokens` on the exact captured request bodies: the router was
 * about 4,246 tokens on Haiku 4.5 (minimum 4,096) and the teams, score and
 * admin extractors 1,175, 2,000 and 1,880 on Sonnet 5 (minimum 1,024).
 * All four cleared the minimum and were sent with no marker, uncached on
 * every call, which is a large part of what the September dev bill paid
 * for (`MDs/llm-spend-september-2026.md`).
 *
 * The minimums are not monotone across generations: the newest models
 * have the lowest and Haiku 4.5 the highest. Haiku 5.5 (2026-10-19) is
 * 512, probed on the dev key: a 505-token prefix with a marker wrote and
 * read nothing, a 541-token one wrote 541 and then read 541.
 */
export const MIN_CACHEABLE_TOKENS: Record<string, number> = {
  "claude-opus-5": 512,
  "claude-haiku-5-5": 512,
  "claude-sonnet-5": 1_024,
  "claude-sonnet-4-5": 1_024,
  "claude-haiku-4-5": 4_096,
};

/**
 * A rough token count, `characters / 4`. For sizing and cost ESTIMATES
 * only (a harness's "about N tokens" line, a prompt header's size note):
 * measured 2026-09-11 to 2026-10-19 these prompts run 3.5 to 5 characters
 * per token on Haiku 4.5, 2.6 on Haiku 5.5 and about 2.8 on Sonnet 5, so
 * it under-counts. It decides nothing about caching.
 */
export function estimateTokens(text: string): number {
  return Math.floor(text.length / 4);
}

/**
 * THE PIPELINE'S CACHE MARKER: ONE HOUR, NOT FIVE MINUTES (2026-09-29).
 *
 * The Pi flushes each group every ten minutes, so a five-minute entry has
 * always expired by the next batch. Sutton FC on 2026-09-29: seven
 * batches 10 to 22 minutes apart, 13 extractions, 13 cache writes, zero
 * reads. A one-hour write costs 2x input rather than 1.25x, and every
 * read inside the hour costs 0.1x and refreshes the entry at no charge,
 * so one busy morning pays for ONE write per prompt instead of one per
 * call. It loses only when a prompt is used once and then not again for
 * an hour: 0.75x the prompt, about $0.005 on the attendance extractor.
 *
 * `ttl` is GA in @anthropic-ai/sdk 0.90 (`CacheControlEphemeral.ttl`), no
 * beta header. Every call carries it, the router included: on Haiku 4.5
 * its real prefix (system plus schema, about 4,246 tokens) was over the
 * 4,096 minimum all along, and only the size gate kept the marker off
 * (`__tests__/cache-threshold.test.ts`).
 */
export const PIPELINE_CACHE_CONTROL = { type: "ephemeral", ttl: "1h" } as const;

/**
 * THE ONE WAY ANY CALL IN THIS APP BUILDS ITS SYSTEM PROMPT: one text
 * block carrying the shared marker. The static prefix (this block, and
 * the schema the API puts with it) is cached; the user turn never is.
 *
 * `{ cache: false }` only for a call with a measured reason not to cache:
 * one used once and not again within the hour (once per club), where a
 * 1-hour write is 2x input for nothing. Enforced by
 * `src/lib/__tests__/one-cache-marker.test.ts`.
 */
export function systemBlock(
  text: string,
  opts?: { cache?: false },
): Array<{ type: "text"; text: string; cache_control?: typeof PIPELINE_CACHE_CONTROL }> {
  return opts?.cache === false
    ? [{ type: "text", text }]
    : [{ type: "text", text, cache_control: PIPELINE_CACHE_CONTROL }];
}

export interface ModelRequest {
  model: string;
  /** The stable prefix. Always carries the cache marker (`systemBlock`). */
  system: string;
  /** The per-call content. Never cached. */
  user: string;
  /** Clamped against PIPELINE_MAX_TOKENS_CEILING at the call site. */
  maxTokens: number;
  /** Structured output. `output_config.format`, not a tool. */
  schema?: Record<string, unknown>;
  /**
   * `false`: attach no cache marker. For a prompt used once and not again
   * within the hour (the setup reading, once per club), where a 1-hour
   * write is 2x input for nothing. Omitted: the marker, as on every call.
   */
  cache?: false;
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
   * on `claude-haiku-4-5` the router never thought unprompted, so it sent
   * nothing. `claude-haiku-5-5` (2026-10-19) thinks adaptively, and is
   * more accurate on these prompts WITH thinking (measured, see
   * `HAIKU_EFFORT` in src/lib/models.ts), so the Haiku callers pass
   * `{ effort }`: adaptive thinking at that effort, sent as
   * `output_config.effort` beside any schema. The extractors keep "off".
   */
  thinking?: "off" | { effort: "low" | "medium" | "high" };
  /**
   * Pictures sent before `user` in the one user turn (picture reading,
   * 2026-10-14). Base64, in memory only. Omitted: the request is exactly
   * what it was before this field existed (content is the plain string).
   */
  images?: Array<{ mediaType: "image/jpeg" | "image/png" | "image/webp"; data: string }>;
  /** Appears in logs and in the cost breakdown. */
  label: string;
  /** The router only: each short id the model is shown (m1, m2, ...) and
   *  the real message id it stands for. Never sent to the model; read by
   *  the router's test stub, which is configured by real ids. */
  shortIds?: Readonly<Record<string, string>>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The part of `cacheWriteTokens` written with the 1-hour TTL, which
   *  bills at 2x rather than 1.25x. Absent means none. */
  cacheWrite1hTokens?: number;
}

export interface ModelResponse {
  text: string;
  stopReason: string | null;
  usage: ModelUsage;
  costUsd: number | null;
  ms: number;
}

export interface PipelineModel {
  readonly name: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export function costOf(model: string, usage: ModelUsage): number | null {
  // The API reports the DATED snapshot in `resp.model` even when the
  // request named the alias: ask for `claude-haiku-4-5`, get back
  // `claude-haiku-4-5-20251001`. The table is keyed by alias, so strip a
  // trailing `-YYYYMMDD` before giving up. Without this every raw Haiku
  // call site was booked at UNPRICED_CALL_USD, about 80x its real cost.
  const rate = RATES[model] ?? RATES[model.replace(/-\d{8}$/, "")];
  if (!rate) return null;
  // Cache reads bill at 0.1x input, 1-hour writes at 2x, 5-minute writes
  // at 1.25x. The pipeline asks for 1 hour (`PIPELINE_CACHE_CONTROL`), as
  // do most raw call sites; both `anthropicModel` and
  // `anthropicMessageCost` read the split from the usage the API reports.
  const write1h = Math.min(usage.cacheWrite1hTokens ?? 0, usage.cacheWriteTokens);
  const input =
    usage.inputTokens +
    usage.cacheReadTokens * 0.1 +
    (usage.cacheWriteTokens - write1h) * 1.25 +
    write1h * 2;
  return (input / 1_000_000) * rate.input + (usage.outputTokens / 1_000_000) * rate.output;
}

/**
 * What an unpriced call is booked at by the daily cap: an Opus-class call
 * at this pipeline's token ceiling. Deliberately pessimistic. A model id
 * nobody has priced can only make the cap STRICTER, never looser.
 */
export const UNPRICED_CALL_USD = 0.12;

/**
 * THE DOLLAR COST OF ONE RAW SDK RESPONSE, from the usage it reports.
 * For the call sites outside this pipeline that use `messages.create`
 * directly; the pipeline itself goes through `anthropicModel`. Null for a
 * model with no entry in the rate table.
 */
export function anthropicMessageCost(resp: {
  model?: string;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_creation?: { ephemeral_1h_input_tokens?: number | null; ephemeral_5m_input_tokens?: number | null } | null;
  } | null;
}): number | null {
  if (!resp?.model || !resp.usage) return null;
  const u = resp.usage;
  return costOf(resp.model, {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheWrite1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  });
}

/**
 * THE DAILY CAP'S GUARD FOR A RAW `messages.create` CALL SITE.
 *
 *     const response = await guardedAnthropicCall("dm-intent", () =>
 *       anthropic.messages.create({...}),
 *     );
 *
 * Inside a club's budget scope (`ai-budget.ts`) it reserves before the
 * call and books the real cost after, and throws `AiBudgetExceededError`
 * WITHOUT calling the model when the club's cap for today is reached.
 * Outside a scope it is a pass-through. Every call site that uses it
 * already fails closed on a thrown call.
 */
export async function guardedAnthropicCall<T extends Parameters<typeof anthropicMessageCost>[0]>(
  label: string,
  call: () => Promise<T>,
): Promise<T> {
  const resp = await guardedModelCall(label, call, (r) => anthropicMessageCost(r), UNPRICED_CALL_USD);
  const line = formatUsageLog(label, resp);
  if (line) console.log(line);
  return resp;
}

/**
 * ONE LOG LINE PER MODEL CALL (2026-10-19), so cache hit rates are
 * measured rather than assumed: the call's label and model, uncached
 * input, output, cache write and cache read tokens, and its priced cost.
 * Every real Anthropic response passes through `guardedAnthropicCall`
 * (the pipeline's `anthropicModel` and every raw site), so this is the
 * whole picture. Numbers only: never any message text. Null when the
 * response carries no usage.
 */
export function formatUsageLog(
  label: string,
  resp: Parameters<typeof anthropicMessageCost>[0],
): string | null {
  const u = resp?.usage;
  if (!u) return null;
  const usd = anthropicMessageCost(resp);
  return (
    `[llm-usage] label=${label} model=${resp.model ?? "?"}` +
    ` in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0}` +
    ` cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0}` +
    ` usd=${usd === null ? "?" : usd.toFixed(6)}`
  );
}

/**
 * Any `PipelineModel` behind the daily cap: the e2e stub models use it,
 * so the stubbed suite can prove that a capped request makes NO model
 * call at all, stub or real. `anthropicModel` guards itself (it has to
 * price the response before its truncation check throws), so it is never
 * wrapped in this as well.
 */
export function budgetedModel(inner: PipelineModel): PipelineModel {
  return {
    name: inner.name,
    complete: (req) =>
      guardedModelCall(req.label, () => inner.complete(req), (r) => r.costUsd, UNPRICED_CALL_USD),
  };
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
      const t0 = Date.now();
      // THE DAILY CAP (2026-09-29). Inside a club's budget scope this
      // reserves before the request and books the priced usage after it,
      // and throws `AiBudgetExceededError` without touching the SDK when
      // the club's cap for today is reached. The response is priced HERE,
      // before the truncation check below can throw, because a truncated
      // response was still billed.
      const resp = await guardedAnthropicCall(req.label, () => client.messages.create({
        model: req.model,
        // Clamped here rather than trusted from the caller, so a new
        // stage cannot reintroduce the 64000 bug by passing its own
        // number. See PIPELINE_MAX_TOKENS_CEILING above.
        max_tokens: Math.min(PIPELINE_MAX_TOKENS_CEILING, req.maxTokens),
        system: systemBlock(req.system, { cache: req.cache }),
        messages: [
          {
            role: "user" as const,
            content: req.images?.length
              ? [
                  ...req.images.map((img) => ({
                    type: "image" as const,
                    source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
                  })),
                  { type: "text" as const, text: req.user },
                ]
              : req.user,
          },
        ],
        ...(req.schema || (req.thinking && req.thinking !== "off")
          ? {
              output_config: {
                ...(req.schema ? { format: { type: "json_schema" as const, schema: req.schema } } : {}),
                ...(req.thinking && req.thinking !== "off" ? { effort: req.thinking.effort } : {}),
              },
            }
          : {}),
        // See `ModelRequest.thinking`. Sent ONLY when the caller asked;
        // an omitted parameter and `{type: "adaptive"}` mean the same
        // thing on sonnet-5, and sending nothing keeps this layer honest
        // about which callers made a decision and which did not.
        ...(req.thinking === "off"
          ? { thinking: { type: "disabled" as const } }
          : req.thinking
            ? { thinking: { type: "adaptive" as const } }
            : {}),
      }));
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
        // Without this a 1-hour write is priced at 1.25x instead of 2x,
        // and the daily cap and this response's `costUsd` would disagree.
        cacheWrite1hTokens: resp.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      };

      return {
        text,
        stopReason: resp.stop_reason ?? null,
        usage,
        costUsd: costOf(req.model, usage),
        ms,
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
