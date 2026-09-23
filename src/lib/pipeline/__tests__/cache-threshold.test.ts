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
    //
    // THE ID BELOW IS FICTIONAL ON PURPOSE and must stay that way: the
    // test is only meaningful while the id is absent from
    // `MIN_CACHEABLE_TOKENS`. It used to read `claude-something-7`,
    // which `MDs/llm-spend-september-2026.md` §1 had to stop and
    // investigate because it reads like a real model id somebody
    // mistyped. Named so nobody spends that time again.
    const UNMEASURED = "not-a-real-model-id";
    expect(MIN_CACHEABLE_TOKENS[UNMEASURED]).toBeUndefined();
    expect(shouldCachePrompt(UNMEASURED, prose(2_000))).toBe(false);
    expect(shouldCachePrompt(UNMEASURED, prose(6_000))).toBe(true);
  });

  it("under-counts rather than over-counts, so a marker is never a fiction", () => {
    // Measured 2026-09-11 with `messages.count_tokens`: this pipeline's
    // prompts run 3.78–5.08 chars/token on Haiku and 2.78–2.98 on
    // Sonnet. Dividing by 4 is at or below the real count on Haiku and
    // well below it on Sonnet — both in the direction that declines a
    // marker it is not sure of.
    // `count_tokens`, claude-haiku-4-5, 2026-09-11: the router prompt was
    // 2,554 tokens and the attendance extractor prompt 1,366.
    // Re-measured 2026-09-16 after the Turkish rule and examples went in
    // (`count_tokens`, same model): router 2,962 (11,233 chars, 3.79
    // chars/token), attendance 1,820 (6,846 chars, 3.76 chars/token). On
    // claude-sonnet-5 the attendance prompt is 2,381. Turkish letters
    // tokenise DENSER than English, so the under-count widens.
    // Re-measured 2026-09-17 after the three personal-stats worked
    // examples (`count_tokens`, claude-haiku-4-5): router 3,003 tokens,
    // 11,455 chars. Still well under Haiku's 4,096, so still no marker.
    //
    // ⚠️ 2026-09-22, THE REPLACEMENT RULES: these two bounds are DERIVED
    // and NOT measured, and that is said out loud rather than dressed up
    // as another `count_tokens` reading. The repo-root `.env` carried no
    // development API key when this shipped, every harness refuses
    // without one, and the production key is not a substitute
    // (`MDs/dev-vs-production-api-keys.md`).
    //
    // The DERIVATION, and why it keeps the property this test is for.
    // Every measurement in the history of these two prompts has run
    // 3.76 to 3.82 chars/token on Haiku, the last pair exactly: router
    // 11,455/3,003 = 3.814 and attendance 6,846/1,820 = 3.762. The
    // estimator divides by 4. While the real ratio stays under 4 the
    // estimate is BELOW the real count by construction, whatever the
    // prompt says, and Turkish letters (which both additions carry)
    // tokenise denser, pushing the ratio further down rather than up.
    // So each bound below is chars / (that prompt's own last measured
    // ratio): a conservative floor for the real count, not a guess at
    // it. Router 12,412 chars -> >= 3,254 real against a 3,103 estimate;
    // attendance 8,562 -> >= 2,275 real against a 2,141 estimate.
    //
    // RE-MEASURE THESE with `count_tokens` on the next change that has a
    // dev key to hand, and put the real figures back.
    expect(estimateTokens(ROUTER_SYSTEM_PROMPT)).toBeLessThanOrEqual(3_254);
    expect(estimateTokens(EXTRACTOR_PROMPTS.attendance)).toBeLessThanOrEqual(2_275);
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

  it("CLAIMS the cache on the question extractor, which crossed the minimum on 2026-09-17", () => {
    // The `my_stats` topic and its examples took the prompt from ~3,900
    // to 4,872 characters. `count_tokens`, claude-sonnet-5, 2026-09-17:
    // 1,598 tokens, over Sonnet 5's 1,024. Probed the same day, two
    // back-to-back live extractions: the first paid a cache write
    // (37 uncached input tokens, $0.0051), the second read it
    // (1,966 input tokens including the cache read, $0.00075). A real
    // cache, so the marker is not a fiction.
    //
    // 2026-09-23: the stats `table` / `listSize` / `listEnd` fields and
    // their English and Turkish examples took it to 9,839 characters.
    // The bound follows the convention the router and attendance bounds
    // above use: chars / this prompt's own last measured ratio
    // (4,872 / 1,598 = 3.049), a conservative floor for the real count:
    // 9,839 -> >= 3,227 real, against a 2,459 estimate. Still cached,
    // and further over Sonnet 5's minimum than before.
    expect(estimateTokens(EXTRACTOR_PROMPTS.question)).toBeLessThanOrEqual(3_227);
    expect(shouldCachePrompt(EXTRACTOR_MODEL, EXTRACTOR_PROMPTS.question)).toBe(true);
  });

  it.each(["teams", "score", "admin"] as const)(
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
