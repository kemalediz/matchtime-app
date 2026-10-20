/**
 * CACHE USAGE IS LOGGED PER CALL LABEL (2026-10-19).
 *
 * Until now the only record of whether a call read or wrote the prompt
 * cache was the response itself, and nothing kept it: OrgAiUsage has no
 * label and no cache split. So hit rates could only be guessed. Every
 * real Anthropic response goes through `guardedAnthropicCall` (the
 * pipeline's `anthropicModel` and every raw classifier site), so that is
 * where one line per call is logged: label, model, input, output, cache
 * write, cache read, cost. Never any message text.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicModel, formatUsageLog, guardedAnthropicCall, type MessagesCreateClient } from "../llm";

const SECRET = "Ahmet says he is IN for Tuesday";

const response = {
  model: "claude-haiku-5-5",
  content: [{ type: "text", text: `{"echo":"${SECRET}"}` }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 40,
    output_tokens: 120,
    cache_read_input_tokens: 5_148,
    cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  },
};

afterEach(() => vi.restoreAllMocks());

describe("one usage line per model call", () => {
  it("formats label, model, tokens, cache write and read, and cost", () => {
    const line = formatUsageLog("router", response);
    expect(line).toBe(
      "[llm-usage] label=router model=claude-haiku-5-5 in=40 out=120 cache_write=0 cache_read=5148 usd=0.000115",
    );
  });

  it("says usd=? for a model with no rate rather than inventing one", () => {
    expect(formatUsageLog("x", { ...response, model: "not-a-real-model-id" })).toMatch(/ usd=\?$/);
  });

  it("guardedAnthropicCall logs it, with no message text", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await guardedAnthropicCall("dm-intent", async () => response);
    const lines = log.mock.calls.map((c) => c.join(" "));
    expect(lines).toEqual([expect.stringContaining("[llm-usage] label=dm-intent ")]);
    expect(lines.join("\n")).not.toContain("Ahmet");
  });

  it("the pipeline model logs through the same path, under its own label", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const client: MessagesCreateClient = { messages: { create: async () => response as never } };
    await anthropicModel({ apiKey: "test", client }).complete({
      model: "claude-haiku-5-5",
      system: "S",
      user: SECRET,
      maxTokens: 64,
      label: "router",
    });
    const lines = log.mock.calls.map((c) => c.join(" "));
    expect(lines).toEqual([expect.stringMatching(/^\[llm-usage\] label=router .* cache_read=5148 /)]);
    expect(lines.join("\n")).not.toContain("Ahmet");
  });

  it("a response with no usage logs nothing and does not throw", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await guardedAnthropicCall("x", async () => ({}) as never);
    expect(log).not.toHaveBeenCalled();
  });
});
