import { describe, expect, it, vi } from "vitest";
import {
  PICTURE_READING_MAX_TOKENS,
  PICTURE_READING_MODEL,
  PICTURE_READING_SYSTEM_PROMPT,
  PICTURE_READING_USER_TEXT,
} from "../picture-prompt";
import { SETUP_LEARNING_MODEL } from "../setup-learning/prompt";
import { anthropicModel, costOf, PIPELINE_MAX_TOKENS_CEILING, type MessagesCreateClient } from "../pipeline/llm";

describe("the picture reading prompt", () => {
  it("uses the cheap vision-capable model the setup reading already uses (Haiku 4.5), which is priced", () => {
    expect(PICTURE_READING_MODEL).toBe(SETUP_LEARNING_MODEL);
    expect(PICTURE_READING_MODEL).toBe("claude-haiku-5-5");
    expect(costOf(PICTURE_READING_MODEL, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).not.toBeNull();
  });

  it("has room for thinking plus a short answer, under the pipeline ceiling", () => {
    expect(PICTURE_READING_MAX_TOKENS).toBeLessThanOrEqual(PIPELINE_MAX_TOKENS_CEILING);
    // The answer is short (a poster of 18 names is ~180 tokens on Haiku
    // 5.5), but thinking shares the budget: room for both.
    expect(PICTURE_READING_MAX_TOKENS).toBeGreaterThanOrEqual(2_048);
  });

  it("names the three kinds of answer and the refusal phrase the parser keys on", () => {
    expect(PICTURE_READING_SYSTEM_PROMPT).toContain("Poster:");
    expect(PICTURE_READING_SYSTEM_PROMPT).toContain("Team sheet:");
    expect(PICTURE_READING_SYSTEM_PROMPT).toContain("Not about the game");
    expect(PICTURE_READING_USER_TEXT.length).toBeGreaterThan(0);
  });

  it("never asks for bank details or phone numbers to be copied", () => {
    expect(PICTURE_READING_SYSTEM_PROMPT).toMatch(/bank/i);
    expect(PICTURE_READING_SYSTEM_PROMPT).toMatch(/phone/i);
  });

  // The 2026-10-14 paid check: an "I'M BACK" poster with 18 numbered names
  // in two columns came back as "Team sheet". One list is a Poster, whatever
  // it looks like; only names split into named sides is a Team sheet.
  it("defines a Poster as ONE list of players, however it is numbered, titled or laid out", () => {
    const p = PICTURE_READING_SYSTEM_PROMPT;
    expect(p).toMatch(/ONE list of players/);
    expect(p).toMatch(/numbered or not/i);
    expect(p).toMatch(/any number of columns/i);
    expect(p).toMatch(/any title/i);
    expect(p).toMatch(/columns are not teams/i);
  });

  it("defines a Team sheet as names split into two or more named sides, teams or colours", () => {
    expect(PICTURE_READING_SYSTEM_PROMPT).toMatch(/split into two or more named sides, teams or colours/i);
  });

  it("copies the date, time, venue and price from anywhere on the picture into the first line, for both shapes", () => {
    const p = PICTURE_READING_SYSTEM_PROMPT;
    expect(p).toMatch(/date, time, venue and price/i);
    expect(p).toMatch(/header, footer, corner/i);
    expect(p).toMatch(/both shapes/i);
    expect(p).toContain("Poster: <date>, <time>, <venue>, <price>: 1. <name> 2. <name>");
    expect(p).toContain("Team sheet: <date>, <time>, <venue>, <price>: <team>: <name>, <name>");
  });

  it("has an invented worked example: a three-column poster with its footer and corner price copied", () => {
    expect(PICTURE_READING_SYSTEM_PROMPT).toContain("Poster: Sun 2 Nov, 10:00, Hackney Marshes, £6: 1. Dele 2. Marco 3. Tunde");
  });

  it("does not leak the paid check's pictures (the FNF poster and team sheet) into the prompt", () => {
    for (const leak of [/I'M BACK/i, /Harris/i, /Merton/i, /9 October/i, /8:30/, /Shehryar/i, /\bImz\b/i, /Naim/i, /Hamzah/i, /FNF/i]) {
      expect(PICTURE_READING_SYSTEM_PROMPT).not.toMatch(leak);
    }
  });

  it("has no em or en dashes", () => {
    expect(PICTURE_READING_SYSTEM_PROMPT).not.toMatch(/[–—]/);
  });
});

describe("anthropicModel with images (request shape only, injected client, no network)", () => {
  function client() {
    const create = vi.fn(async (_body: unknown) => ({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text: "Poster: x" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 10 },
    }));
    return { create, client: { messages: { create } } as unknown as MessagesCreateClient };
  }

  it("puts each image before the text in the one user message", async () => {
    const { create, client: c } = client();
    await anthropicModel({ apiKey: "test", client: c }).complete({
      model: PICTURE_READING_MODEL,
      system: "s",
      user: "read it",
      maxTokens: 100,
      label: "picture-reading",
      images: [{ mediaType: "image/jpeg", data: "AAAA" }],
    });
    const body = create.mock.calls[0][0] as { messages: Array<{ content: unknown }> };
    expect(body.messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
      { type: "text", text: "read it" },
    ]);
  });

  it("without images the request is byte for byte what it was", async () => {
    const { create, client: c } = client();
    await anthropicModel({ apiKey: "test", client: c }).complete({
      model: PICTURE_READING_MODEL,
      system: "s",
      user: "plain",
      maxTokens: 100,
      label: "x",
    });
    const body = create.mock.calls[0][0] as { messages: Array<{ content: unknown }> };
    expect(body.messages[0].content).toBe("plain");
  });
});
