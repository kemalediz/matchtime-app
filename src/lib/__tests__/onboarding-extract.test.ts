/**
 * THE SETUP-ANSWER READING (onboarding-conversation.ts, 2026-10-22): the
 * request it sends, the prompt's shape, and what the code does with the
 * answer. No model is called: the pipeline model is a stub that records
 * the request and returns a canned body.
 *
 * It was the last prompt called with the raw SDK; it now goes through
 * `pipeline/llm.ts` with `ONBOARDING_EXTRACT_CALL = HAIKU_CALL`, keeping
 * the same label (the club's budget), max_tokens and cache marker.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens, HAIKU_CALL, MIN_CACHEABLE_TOKENS, type ModelRequest, type PipelineModel } from "../pipeline/llm";
import { HAIKU_SHORT_ANSWER_MAX_TOKENS } from "../models";
import {
  buildExtractUserTurn,
  EXTRACT_PROMPT,
  extractSetupAnswers,
  ONBOARDING_EXTRACT_CALL,
  type KnownSetup,
} from "../onboarding-conversation";
import { regexExtract } from "../onboarding-parse";

vi.mock("../db", () => ({ db: {} }));

function stub(body: unknown | Error): { model: PipelineModel; reqs: ModelRequest[] } {
  const reqs: ModelRequest[] = [];
  return {
    reqs,
    model: {
      name: "stub",
      async complete(req) {
        reqs.push(req);
        if (body instanceof Error) throw body;
        return {
          text: typeof body === "string" ? body : JSON.stringify(body),
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          ms: 1,
        };
      },
    },
  };
}

const KNOWN: KnownSetup = {
  groupName: "Thursday Ballers",
  venue: null,
  dayOfWeek: null,
  kickoffTime: null,
  playersPerSide: 7,
  recurrence: null,
  oneOffDate: null,
  stage: "collecting",
};
const NULLS = {
  groupName: null,
  venue: null,
  dayOfWeek: null,
  kickoffTime: null,
  playersPerSide: null,
  recurrence: null,
  oneOffDate: null,
  featureSelection: null,
};
const NOW = new Date("2026-10-22T11:00:00Z"); // Thursday, 12:00 London

afterEach(() => vi.unstubAllEnvs());

describe("the request", () => {
  it("goes through the shared caller on Haiku 5.5, as before: same label, max_tokens and cache marker", async () => {
    const { model, reqs } = stub({ ...NULLS, confidence: 0.2 });
    await extractSetupAnswers(KNOWN, [{ authorName: "Ali", body: "hi" }], { model, now: NOW });
    expect(reqs).toHaveLength(1);
    const r = reqs[0];
    expect(ONBOARDING_EXTRACT_CALL).toBe(HAIKU_CALL);
    expect(r.model).toBe("claude-haiku-5-5");
    expect(r.thinking).toEqual({ effort: "medium" });
    expect(r.label).toBe("onboarding-extract");
    expect(r.maxTokens).toBe(HAIKU_SHORT_ANSWER_MAX_TOKENS);
    expect(r.system).toBe(EXTRACT_PROMPT);
    // The marker stays: this prompt is read by every onboarding turn.
    expect(r.cache).toBeUndefined();
    // Prompt-and-parse, as before: the contract has nulls, which a
    // structured-output schema cannot carry.
    expect(r.schema).toBeUndefined();
  });

  it("the file makes no raw SDK call any more", () => {
    const src = readFileSync(path.join(__dirname, "..", "onboarding-conversation.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/messages\.create\(/);
    expect(src).not.toMatch(/from "@anthropic-ai\/sdk"/);
    expect(src).toMatch(/anthropicModel\(/);
  });

  it("makes no call with no key, and reads the messages with the regex instead", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const msgs = [{ authorName: "Ali", body: "thursdays 8pm, 7 a side" }];
    expect(await extractSetupAnswers(KNOWN, msgs)).toEqual(regexExtract(msgs));
  });
});

describe("what the code does with the answer", () => {
  it("backfills a field the model left null from the regex pass", async () => {
    const { model } = stub({ ...NULLS, venue: "Goals Sutton", confidence: 0.9 });
    const ex = await extractSetupAnswers(KNOWN, [{ authorName: "Ali", body: "thursdays at Goals Sutton" }], { model, now: NOW });
    expect(ex.venue).toBe("Goals Sutton");
    expect(ex.dayOfWeek).toBe(4);
    expect(ex.confidence).toBe(0.9);
  });

  it("falls back to the regex when the call fails or the answer is not JSON", async () => {
    const msgs = [{ authorName: "Ali", body: "tuesdays 9pm" }];
    for (const body of [new Error("529 overloaded"), "sorry, I cannot help", ""]) {
      const { model } = stub(body);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await extractSetupAnswers(KNOWN, msgs, { model, now: NOW })).toEqual(regexExtract(msgs));
      err.mockRestore();
    }
  });

  it("reads a JSON object wrapped in prose or a fence", async () => {
    const { model } = stub('```json\n{"groupName":null,"venue":"Sim Arena","dayOfWeek":5,"kickoffTime":"21:30","playersPerSide":7,"recurrence":"weekly","oneOffDate":null,"featureSelection":null,"confidence":0.9}\n```');
    const ex = await extractSetupAnswers(KNOWN, [{ authorName: "Ali", body: "x" }], { model, now: NOW });
    expect(ex).toMatchObject({ venue: "Sim Arena", dayOfWeek: 5, kickoffTime: "21:30" });
  });
});

describe("the user turn", () => {
  it("shows each message as author: text, cut at 400 characters", () => {
    const turn = buildExtractUserTurn(KNOWN, [
      { authorName: "Ali", body: "thursdays" },
      { authorName: null, body: "x".repeat(500) },
    ], NOW);
    expect(turn).toContain("Ali: thursdays");
    expect(turn).toContain(`?: ${"x".repeat(400)}`);
    expect(turn).not.toContain("x".repeat(401));
  });
});

describe("the prompt", () => {
  it("carries no em or en dash", () => {
    expect(EXTRACT_PROMPT).not.toMatch(/[—–]/);
  });

  it("is long enough for its cache marker to do something on Haiku 5.5", () => {
    expect(estimateTokens(EXTRACT_PROMPT)).toBeGreaterThanOrEqual(MIN_CACHEABLE_TOKENS["claude-haiku-5-5"]);
  });

  it("names every canonical feature key", () => {
    for (const k of ["attendance", "bench", "teamBalancing", "momVoting", "playerRating", "reminders", "statsQa", "paymentTracking"]) {
      expect(EXTRACT_PROMPT, k).toContain(k);
    }
  });
});
