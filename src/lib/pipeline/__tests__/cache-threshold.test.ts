/**
 * §3.3 of `MDs/router-accuracy-2026-09-11.md` — THE MINIMUM CACHEABLE
 * PREFIX IS A TOKEN COUNT, AND IT IS PER MODEL.
 *
 * `MIN_CACHEABLE_CHARS = 4_000` was one number, in the wrong unit,
 * derived from Sonnet. Two things follow from that and both are
 * measured, not argued:
 *
 *   - **Haiku 4.5's minimum is 4,096 TOKENS**, roughly 15,500 characters
 *     of this pipeline's English. Probed live on 2026-09-11 with the
 *     candidate router prompt (9,608 chars / 2,554 tokens) and a marker
 *     attached: `cache_creation=0 cache_read=0` on both of two
 *     back-to-back calls. Under the character rule that prompt reports
 *     `cacheAttempted: true` and caches nothing — `cacheAttempted` would
 *     mean "we asked", never "it happened", which is §8.5's audit note
 *     re-armed.
 *   - **Sonnet 5's is 1,024 tokens**, and `EXTRACTOR_PROMPTS.attendance`
 *     (5,261 chars / 1,778 Sonnet tokens) is comfortably over it. Probed
 *     the same day: `cache_creation=1773` then `cache_read=1773`. It
 *     caches today and it must keep caching after this change — the
 *     session brief believed this prompt was a silent no-op and the
 *     probe says it is not, so the regression to guard against here is
 *     LOSING a real cache, not removing a fake one.
 *
 * Official minimums (anthropic.com, prompt-caching): Opus 5 512, Sonnet
 * 5 / Sonnet 4.5 1,024, Haiku 4.5 4,096. They are NOT monotone across
 * generations, which is exactly why one constant cannot serve.
 */
import { describe, it, expect } from "vitest";
import {
  EXTRACTOR_MODEL,
  MIN_CACHEABLE_TOKENS,
  ROUTER_MODEL,
  anthropicModel,
  estimateTokens,
  shouldCachePrompt,
  type MessagesCreateClient,
} from "../llm";
import { ROUTER_SYSTEM_PROMPT } from "../router";
import { EXTRACTOR_PROMPTS } from "../extractors";

/** `n` tokens' worth of prose by the estimator's own reckoning. */
const prose = (tokens: number) => "word ".repeat(Math.ceil((tokens * 4) / 5));

describe("the minimum cacheable prefix is a token count, per model", () => {
  it("knows the published minimum for every model this pipeline pins", () => {
    expect(MIN_CACHEABLE_TOKENS["claude-haiku-4-5"]).toBe(4_096);
    expect(MIN_CACHEABLE_TOKENS["claude-sonnet-5"]).toBe(1_024);
    expect(MIN_CACHEABLE_TOKENS["claude-opus-5"]).toBe(512);
  });

  it.each([
    ["claude-haiku-4-5", 2_000, false],
    ["claude-haiku-4-5", 6_000, true],
    ["claude-sonnet-5", 500, false],
    ["claude-sonnet-5", 2_000, true],
    ["claude-opus-5", 300, false],
    ["claude-opus-5", 900, true],
  ])("%s · ~%i estimated tokens → marker %s", (model, tokens, expected) => {
    expect(shouldCachePrompt(model, prose(tokens))).toBe(expected);
  });

  it("treats an unpinned model as the most demanding one it knows", () => {
    // A model id nobody has measured must never be told "we cached" on
    // the strength of a guess. 2,000 tokens clears Sonnet and Opus and
    // does not clear Haiku; the unknown gets Haiku's answer.
    expect(shouldCachePrompt("claude-something-7", prose(2_000))).toBe(false);
    expect(shouldCachePrompt("claude-something-7", prose(6_000))).toBe(true);
  });

  it("under-counts rather than over-counts, so a marker is never a fiction", () => {
    // Measured 2026-09-11 with `messages.count_tokens`: this pipeline's
    // prompts run 3.78–5.08 chars/token on Haiku and 2.78–2.98 on
    // Sonnet. Dividing by 4 is at or below the real count on Haiku and
    // well below it on Sonnet — both in the direction that declines a
    // marker it is not sure of.
    // `count_tokens`, claude-haiku-4-5, 2026-09-11: the router prompt is
    // 2,554 tokens and the attendance extractor prompt 1,366.
    expect(estimateTokens(ROUTER_SYSTEM_PROMPT)).toBeLessThanOrEqual(2_554);
    expect(estimateTokens(EXTRACTOR_PROMPTS.attendance)).toBeLessThanOrEqual(1_366);
  });
});

describe("the prompts this pipeline actually sends", () => {
  it("does NOT claim a cache for the router prompt on Haiku — it would not get one", () => {
    // The whole point of §3.3. The router prompt after §3.1 is ~9.6k
    // characters, which is over the old 4,000-char rule and a long way
    // under Haiku's 4,096-token minimum. Probed: caches nothing.
    expect(ROUTER_SYSTEM_PROMPT.length).toBeGreaterThan(4_000);
    expect(shouldCachePrompt(ROUTER_MODEL, ROUTER_SYSTEM_PROMPT)).toBe(false);
  });

  it("KEEPS the cache on the attendance extractor, which really does cache", () => {
    expect(shouldCachePrompt(EXTRACTOR_MODEL, EXTRACTOR_PROMPTS.attendance)).toBe(true);
  });

  it.each(["question", "teams", "score", "admin"] as const)(
    "does not claim a cache for the %s extractor",
    (kind) => {
      expect(shouldCachePrompt(EXTRACTOR_MODEL, EXTRACTOR_PROMPTS[kind])).toBe(false);
    },
  );
});

describe("the marker reaches the request, or does not", () => {
  function spyClient() {
    const bodies: any[] = [];
    const client: MessagesCreateClient = {
      messages: {
        async create(body: any) {
          bodies.push(body);
          return {
            content: [{ type: "text", text: "{}" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          } as any;
        },
      },
    };
    return { client, bodies };
  }

  it("attaches cache_control when the prompt clears the model's minimum", async () => {
    const { client, bodies } = spyClient();
    const model = anthropicModel({ apiKey: "test", client });
    const res = await model.complete({
      model: "claude-sonnet-5",
      system: prose(2_000),
      user: "hi",
      maxTokens: 64,
      label: "probe",
    });
    expect(bodies[0].system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(res.cacheAttempted).toBe(true);
  });

  it("attaches nothing when it does not", async () => {
    const { client, bodies } = spyClient();
    const model = anthropicModel({ apiKey: "test", client });
    const res = await model.complete({
      model: "claude-haiku-4-5",
      system: prose(2_000),
      user: "hi",
      maxTokens: 64,
      label: "probe",
    });
    expect(bodies[0].system[0].cache_control).toBeUndefined();
    expect(res.cacheAttempted).toBe(false);
  });
});
