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

describe("the user turn (the context does the work, 2026-10-22)", () => {
  it("gives today's date in London, so a relative one-off date can be worked out", () => {
    expect(buildExtractUserTurn(KNOWN, [{ authorName: "Ali", body: "x" }], NOW)).toContain("Today: Thursday 22 October 2026");
    // 23:30 UTC on the 22nd is already the 23rd in London (BST).
    expect(buildExtractUserTurn(KNOWN, [], new Date("2026-10-22T23:30:00Z"))).toContain("Today: Friday 23 October 2026");
  });

  it("says what MatchTime is asking, from the stage", () => {
    const asking = (stage: string) =>
      buildExtractUserTurn({ ...KNOWN, stage }, [], NOW).split("\n").find((l) => l.startsWith("MatchTime is asking:"));
    expect(asking("features")).toMatch(/which features/);
    expect(asking("details")).toMatch(/when and where/);
    expect(asking("collecting")).toMatch(/setup details/);
    // Only the feature menu is a feature question.
    expect(asking("details")).not.toMatch(/feature/);
    expect(asking("collecting")).not.toMatch(/feature/);
  });

  it("lists what is collected under the answer's own field names, a missing one as not yet", () => {
    const turn = buildExtractUserTurn(KNOWN, [], NOW);
    expect(turn).toContain("- groupName: Thursday Ballers");
    expect(turn).toContain("- playersPerSide: 7");
    expect(turn).toContain("- venue: not yet");
    expect(turn).toContain("- dayOfWeek: not yet");
    expect(buildExtractUserTurn({ ...KNOWN, dayOfWeek: 0 }, [], NOW)).toContain("- dayOfWeek: 0 (Sunday)");
  });


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

  it("defines every output field once, in one place", () => {
    for (const k of ["groupName", "venue", "dayOfWeek", "kickoffTime", "playersPerSide", "recurrence", "oneOffDate", "featureSelection", "confidence"]) {
      expect(EXTRACT_PROMPT.match(new RegExp(`^- ${k}:`, "gm")) ?? [], k).toHaveLength(1);
    }
  });

  it("names each part of the user turn the way the user turn writes it", () => {
    const turn = buildExtractUserTurn(KNOWN, [{ authorName: "Ali", body: "x" }], NOW);
    for (const label of ["Today:", "MatchTime is asking:", "Collected so far:", "New messages"]) {
      expect(turn, label).toContain(label);
      expect(EXTRACT_PROMPT, label).toContain(label);
    }
  });

  it("works a relative date out from today's date, and pairs every Turkish example with an English one", () => {
    expect(EXTRACT_PROMPT).toMatch(/today's date/);
    expect(EXTRACT_PROMPT).toContain("EXAMPLES, ENGLISH / TURKISH");
  });

  it("names every canonical feature key", () => {
    for (const k of ["attendance", "bench", "teamBalancing", "momVoting", "playerRating", "reminders", "statsQa", "paymentTracking"]) {
      expect(EXTRACT_PROMPT, k).toContain(k);
    }
  });
});
