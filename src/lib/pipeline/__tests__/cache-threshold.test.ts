/**
 * EVERY CALL CARRIES THE CACHE MARKER ON ITS STATIC PREFIX (2026-10-19).
 *
 * What stood here was a size gate, `shouldCachePrompt`: attach the marker
 * only when `floor(system.length / 4)` cleared the model's minimum
 * cacheable prefix. It was wrong twice over, and the audit of 2026-10-19
 * MEASURED both with `count_tokens` on the exact captured request bodies:
 *
 *   - the cached prefix is the system prompt PLUS the structured-output
 *     schema, and the gate looked at the system prompt alone;
 *   - four characters per token is not what these prompts run at (the
 *     router is about 3.5 on Haiku 4.5, the extractors about 2.8 on
 *     Sonnet 5).
 *
 * So on Haiku 4.5 the router (system plus schema about 4,246 tokens,
 * minimum 4,096) and the teams, score and admin extractors on Sonnet 5
 * (1,175, 2,000 and 1,880 tokens, minimum 1,024) all cleared the minimum
 * and were sent with no marker at all, uncached on every call.
 *
 * The API ignores a marker on a prefix below the model's minimum, with no
 * error and no write charge (platform.claude.com, prompt caching). So the
 * robust gate is no gate: every call carries the shared marker, and the
 * API decides. The truth of whether a call cached is what it reports in
 * `usage` (cache_creation_input_tokens, cache_read_input_tokens), which
 * `guardedAnthropicCall` now logs per label (see `llm-usage-log.test.ts`).
 *
 * The one exception is a caller with a measured reason: `cache: false`.
 * The setup reading runs once per club and is never read back within the
 * hour, so a 1-hour write (2x input) would be pure cost.
 */
import { describe, it, expect, vi } from "vitest";
import * as llm from "../llm";
import {
  MIN_CACHEABLE_TOKENS,
  PIPELINE_CACHE_CONTROL,
  anthropicModel,
  systemBlock,
  type MessagesCreateClient,
} from "../llm";
import { routeBatch } from "../router";
import { extractForRoute } from "../extractors";
import type { Route } from "../types";

function spyClient() {
  const bodies: any[] = [];
  const client: MessagesCreateClient = {
    messages: {
      async create(body: any) {
        bodies.push(body);
        return {
          content: [{ type: "text", text: '{"routes":[]}' }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        } as any;
      },
    },
  };
  return { client, bodies };
}

describe("the shared marker", () => {
  it("documents the published minimums, for reading a usage log (not a gate)", () => {
    // A marker below these is ignored by the API: no write, no read, no
    // charge. Haiku 5.5 probed on the dev key 2026-10-19: a 505-token
    // prefix wrote nothing, a 541-token one wrote 541 then read 541.
    expect(MIN_CACHEABLE_TOKENS["claude-haiku-4-5"]).toBe(4_096);
    expect(MIN_CACHEABLE_TOKENS["claude-haiku-5-5"]).toBe(512);
    expect(MIN_CACHEABLE_TOKENS["claude-sonnet-5"]).toBe(1_024);
    expect(MIN_CACHEABLE_TOKENS["claude-opus-5"]).toBe(512);
  });

  it("is one hour, not five minutes", () => {
    // The Pi flushes every ten minutes, so a five-minute entry had always
    // expired before the next batch: Sutton's 13 extractions on the
    // morning of 2026-09-29 each paid a fresh write and read nothing.
    expect(PIPELINE_CACHE_CONTROL).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("systemBlock wraps a system prompt as one text block carrying it, or not with cache: false", () => {
    expect(systemBlock("STATIC")).toEqual([
      { type: "text", text: "STATIC", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    expect(systemBlock("STATIC", { cache: false })).toEqual([{ type: "text", text: "STATIC" }]);
  });

  it("the size gate is gone: no predicate second-guesses the API", () => {
    expect((llm as Record<string, unknown>).shouldCachePrompt).toBeUndefined();
    expect((llm as Record<string, unknown>).DEFAULT_MIN_CACHEABLE_TOKENS).toBeUndefined();
  });
});

describe("the marker reaches every pipeline request", () => {
  it("on a short prompt too: a marker under the minimum is ignored by the API at no cost", async () => {
    const { client, bodies } = spyClient();
    await anthropicModel({ apiKey: "test", client }).complete({
      model: "claude-haiku-5-5",
      system: "short",
      user: "hi",
      maxTokens: 64,
      label: "probe",
    });
    expect(bodies[0].system).toEqual(systemBlock("short"));
  });

  it("the router's real request carries it, on the system prompt before the schema and the turn", async () => {
    // MEASURED 2026-10-19 (`count_tokens`, dev key, the captured body):
    // about 4,246 tokens on Haiku 4.5 with the schema, 5,148 on Haiku 5.5;
    // the router was uncached on Haiku 4.5 only because of the size gate.
    const { client, bodies } = spyClient();
    await routeBatch(anthropicModel({ apiKey: "test", client }), [
      { id: "w1", authorName: "Ali", body: "anyone for padel later?" },
    ], { floor: false });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].system).toHaveLength(1);
    expect(bodies[0].system[0].cache_control).toEqual(PIPELINE_CACHE_CONTROL);
    // Nothing variable sits in the cached block: the turn is the user message.
    expect(bodies[0].system[0].text).not.toContain("padel");
  });

  it.each([
    ["self_att", "attendance"],
    ["question", "question"],
    ["balancer", "teams"],
    ["score", "score"],
    ["admin_ops", "admin"],
  ] as Array<[Route, string]>)(
    "the %s extractor's real request carries it (extractor:%s)",
    async (route) => {
      const { client, bodies } = spyClient();
      await extractForRoute(anthropicModel({ apiKey: "test", client }), route, {
        id: "w1",
        body: "Reds won 3-2",
        authorName: "Ali",
        tagged: true,
        history: [],
        lastBotPost: null,
      });
      expect(bodies.length).toBeGreaterThanOrEqual(1);
      expect(bodies[0].system[0].cache_control).toEqual(PIPELINE_CACHE_CONTROL);
      expect(bodies[0].system[0].text).not.toContain("Reds won 3-2");
      expect(bodies[0].output_config.format.schema).toBeTruthy();
    },
  );

  it("needs no beta header for the 1-hour TTL: the body is the whole request", async () => {
    // `ttl` is GA in @anthropic-ai/sdk 0.90 (`CacheControlEphemeral.ttl`).
    const { client, bodies } = spyClient();
    const create = vi.spyOn(client.messages, "create");
    await anthropicModel({ apiKey: "test", client }).complete({
      model: "claude-sonnet-5",
      system: "S",
      user: "hi",
      maxTokens: 64,
      label: "probe",
    });
    expect(create.mock.calls[0]).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("betas");
  });

  it("attaches nothing when the caller says cache: false", async () => {
    // The setup reading: once per club, never read back within the hour.
    const { client, bodies } = spyClient();
    await anthropicModel({ apiKey: "test", client }).complete({
      model: "claude-haiku-5-5",
      system: "S",
      user: "hi",
      maxTokens: 64,
      label: "probe",
      cache: false,
    });
    expect(bodies[0].system).toEqual([{ type: "text", text: "S" }]);
  });

  it("reports the 1-hour write it was billed for, and prices it at 2x", async () => {
    const client: MessagesCreateClient = {
      messages: {
        async create() {
          return {
            model: "claude-sonnet-5",
            content: [{ type: "text", text: "{}" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 500,
              output_tokens: 100,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 3_500,
              cache_creation: { ephemeral_1h_input_tokens: 3_500, ephemeral_5m_input_tokens: 0 },
            },
          } as any;
        },
      },
    };
    const res = await anthropicModel({ apiKey: "test", client }).complete({
      model: "claude-sonnet-5",
      system: "S",
      user: "hi",
      maxTokens: 64,
      label: "probe",
    });
    expect(res.usage).toMatchObject({ cacheWriteTokens: 3_500, cacheWrite1hTokens: 3_500 });
    // Sonnet 5 at $2/$10 per MTok: 500 + 3,500 x 2 input, 100 output.
    expect(res.costUsd).toBeCloseTo(((500 + 3_500 * 2) * 2 + 100 * 10) / 1_000_000, 10);
  });
});
