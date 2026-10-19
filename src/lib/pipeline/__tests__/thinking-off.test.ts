/**
 * THE EXTRACTORS MUST NOT THINK, AND IT IS NOT A COST ARGUMENT.
 *
 * ─────────────────────────────────────────────────────────────────────
 * MEASURED ON A REAL MESSAGE, 5 RUNS OF 5, 2026-09-06
 * ─────────────────────────────────────────────────────────────────────
 *
 * The §10 step 8 dry run (`TEAMS=1`, case T5) put this through the live
 * pipeline against the real Sutton FC squad:
 *
 *   "@Match Time show us the teams again without regenerating
 *    replacing Ehtisham with Najib"
 *
 * and got, 5 times out of 5:
 *
 *   teams extractor failed: the model hit max_tokens (1024) and the
 *   response is cut off. Refusing to parse a truncated body.
 *
 * Raising the cap does not fix it. Probed directly at `max_tokens:
 * 2048` and again at `4096`, the response came back
 * `stop_reason: max_tokens`, `output_tokens: 2048` / `4096`, and
 * **content blocks: `thinking` only. Zero text blocks. Length 0.**
 *
 * `claude-sonnet-5` runs ADAPTIVE THINKING when the `thinking` parameter
 * is omitted. T5 is a self-contradictory instruction — "show the teams
 * again WITHOUT REGENERATING" and "REPLACING Ehtisham with Najib" cannot
 * both be honoured — so the model deliberates, and on a hard enough
 * message it spends the entire budget deliberating and never emits the
 * JSON at all.
 *
 * Three neighbouring phrasings prove it is the ambiguity and not the
 * length: "generate the teams" -> 41 output tokens, text block, clean;
 * "show us the teams again without regenerating" -> 40 tokens, clean;
 * T5 with "without regenerating" removed -> 616 tokens, thinking THEN
 * text, clean. Only the contradictory one runs away.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THIS IS A STEP 8 BUG EVEN THOUGH THE CONFIG PREDATES STEP 8
 * ─────────────────────────────────────────────────────────────────────
 *
 * The behaviour is not new — the extractors have been on `sonnet-5`
 * since step 6. What changed is the CONSEQUENCE. Before step 8 a
 * truncated extraction handed the message to the analyzer. Now it means
 * MatchTime says nothing, and on an attendance route it means a player
 * who said IN is not in the squad. Step 8's retry does not save it
 * either: the failure is deterministic, so the second attempt burns the
 * same budget the same way (measured 5/5).
 *
 * The fix is to stop asking for something the extractor was never meant
 * to do. §6.2 is explicit about the job: return "FACTS about the text
 * only… No intent. No `registerAttendance`. No reply. No emoji. No
 * `reasoning` prose." A model deliberating about what SHOULD happen is
 * the mega-prompt's failure mode reappearing one layer down, and
 * `output_config.format` already constrains the answer to a shape that
 * has nowhere to put a deliberation.
 */
import { describe, expect, it, vi } from "vitest";
import { anthropicModel, EXTRACTOR_MODEL, ROUTER_MODEL } from "../llm";
import { extractForRoute } from "../extractors";
import { routeBatch } from "../router";
import { HAIKU_EFFORT } from "../../models";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PipelineModel, ModelRequest } from "../llm";

function capturing(): PipelineModel & { reqs: ModelRequest[] } {
  const reqs: ModelRequest[] = [];
  return {
    name: "capture",
    reqs,
    async complete(req) {
      reqs.push(req);
      return {
        text: '{"claims":[],"affirmation":null,"sideRequests":[]}',
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 1,
      };
    },
  };
}

const MSG = {
  id: "wa-1",
  body: "in",
  authorName: "Ali",
  tagged: false,
  history: [] as Array<{ author: string | null; body: string }>,
  lastBotPost: null,
};

describe("every extractor asks for thinking to be OFF", () => {
  it.each(["self_att", "other_att", "offer", "unsure", "question", "balancer", "score", "admin_ops"] as const)(
    "%s",
    async (route) => {
      const model = capturing();
      await extractForRoute(model, route, MSG);
      expect(model.reqs).toHaveLength(1);
      expect(
        model.reqs[0].thinking,
        `the ${route} extractor left thinking adaptive; on sonnet-5 that can spend ` +
          `the whole max_tokens budget and return no text at all`,
      ).toBe("off");
    },
  );
});

describe("the model layer turns that into the parameter the API wants", () => {
  it("sends thinking: {type: 'disabled'} when the caller asks for it", async () => {
    const create = vi.fn(async (_a: unknown) => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create };
      },
    }));
    vi.resetModules();
    const { anthropicModel: fresh } = await import("../llm");
    await fresh({ apiKey: "k" }).complete({
      model: EXTRACTOR_MODEL,
      system: "s",
      user: "u",
      maxTokens: 1024,
      label: "extractor:test",
      thinking: "off",
    });
    expect(create.mock.calls[0][0]).toMatchObject({ thinking: { type: "disabled" } });
    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });

  it("sends adaptive thinking with output_config.effort, beside the schema, when the caller asks for an effort", async () => {
    const create = vi.fn(async (_a: unknown) => ({
      stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "{}" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create };
      },
    }));
    vi.resetModules();
    const { anthropicModel: fresh } = await import("../llm");
    const res = await fresh({ apiKey: "k" }).complete({
      model: ROUTER_MODEL,
      system: "s",
      user: "u",
      maxTokens: 2048,
      label: "router",
      schema: { type: "object" },
      thinking: { effort: "medium" },
    });
    expect(create.mock.calls[0][0]).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: { type: "object" } } },
    });
    // The thinking block is skipped; only text is the answer.
    expect(res.text).toBe("{}");
    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });

  it("omits the parameter entirely when the caller does not ask", async () => {
    // Not `{type: "adaptive"}` — OMITTED. The two are equivalent on
    // sonnet-5, and sending nothing keeps this layer honest about which
    // callers made a decision and which did not.
    const create = vi.fn(async (_a: unknown) => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create };
      },
    }));
    vi.resetModules();
    const { anthropicModel: fresh } = await import("../llm");
    await fresh({ apiKey: "k" }).complete({
      model: ROUTER_MODEL,
      system: "s",
      user: "u",
      maxTokens: 1024,
      label: "router",
    });
    expect(create.mock.calls[0][0]).not.toHaveProperty("thinking");
    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });
});

describe("every Haiku pipeline caller thinks at the shared effort", () => {
  // Haiku 5.5 (2026-10-19) runs adaptive thinking when the parameter is
  // omitted; Haiku 4.5, which these callers were written for, did not.
  // Measured on the dev key: the router prompt with the parameter
  // omitted came back thinking (81 thinking tokens) before its JSON.
  // Turning it off keeps the model change a model change.
  it("the router", async () => {
    const reqs: ModelRequest[] = [];
    const model: PipelineModel = {
      name: "capture",
      async complete(req) {
        reqs.push(req);
        return {
          text: '{"routes":[{"id":"m1","route":"none"}]}',
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 1,
        };
      },
    };
    await routeBatch(model, [{ id: "wa-1", authorName: "Ali", body: "anyone watching the game tonight?" }], { floor: false });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].model).toBe(ROUTER_MODEL);
    expect(reqs[0].thinking).toEqual({ effort: HAIKU_EFFORT });
    // Room for thinking on top of the routes (measured: up to 520 output
    // tokens at medium effort on one message).
    expect(reqs[0].maxTokens).toBeGreaterThanOrEqual(2_048);
  });

  it.each(["src/lib/picture-reading.ts", "src/lib/setup-learning/run.ts"])("%s", (file) => {
    // Both build their request inline around a DB-backed flow, so the
    // request object is read from source: the one `complete({` call names
    // the Haiku pin and says `thinking: "off"`.
    const src = readFileSync(path.resolve(__dirname, "../../../..", file), "utf8");
    const at = src.indexOf(".complete({");
    expect(at, `${file} has no .complete({ call`).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("})", at));
    expect(body).toMatch(/model:\s*(PICTURE_READING_MODEL|SETUP_LEARNING_MODEL)/);
    expect(body).toMatch(/thinking:\s*\{\s*effort:\s*HAIKU_EFFORT\s*\}/);
  });
});

describe("the models this rests on are still the ones that were measured", () => {
  it("pins the extractor and router model ids", () => {
    // §11.3: "model ids are pinned… the corpus runs against any
    // candidate model before it goes live". The thinking-off decision
    // above is a property of `claude-sonnet-5`'s adaptive default; a
    // different model id needs the T5 probe re-run before this file's
    // reasoning transfers.
    expect(EXTRACTOR_MODEL).toBe("claude-sonnet-5");
    expect(ROUTER_MODEL).toBe("claude-haiku-5-5");
    expect(typeof anthropicModel).toBe("function");
  });
});
