/**
 * The question extractor under UNIFIED_ANSWERS (`unified-question.ts`): four
 * kinds instead of fifteen topics, read as the topics the engine knows; and
 * with the flag off, the old prompt, schema and label exactly as before.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import { MIN_CACHEABLE_TOKENS } from "../llm";
import { EXTRACTOR_PROMPTS, extractForRoute, factsSchemaFor } from "../extractors";
import { parseUnifiedQuestion, UNIFIED_QUESTION_PROMPT, UNIFIED_QUESTION_SCHEMA } from "../unified-question";

function stub(reply: Record<string, unknown>) {
  const reqs: ModelRequest[] = [];
  const model: PipelineModel = {
    name: "stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      reqs.push(req);
      return {
        text: JSON.stringify(reply),
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0001,
        ms: 1,
      };
    },
  };
  return { model, reqs };
}

const MSG = { id: "wa-1", body: "@Match Time what's the list?", authorName: "Ali Kaya", tagged: true, history: [], lastBotPost: null };

describe("the prompt", () => {
  it("is above Haiku 5.5's cache floor (at the measured 2.6 characters a token)", () => {
    expect(UNIFIED_QUESTION_PROMPT.length / 2.6).toBeGreaterThan(MIN_CACHEABLE_TOKENS["claude-haiku-5-5"] * 1.5);
  });

  it("is much smaller than the prompt it replaces with the flag on", () => {
    expect(UNIFIED_QUESTION_PROMPT.length).toBeLessThan(EXTRACTOR_PROMPTS.question.length * 0.75);
  });

  it("has English and Turkish examples side by side for each kind", () => {
    for (const k of ["-> list", "-> help", "-> my_stats", "-> other"]) expect(UNIFIED_QUESTION_PROMPT).toContain(k);
    expect(UNIFIED_QUESTION_PROMPT).toContain('"@Match Time liste ne?"');
    expect(UNIFIED_QUESTION_PROMPT).toContain('"@Match Time istatistiklerim"');
    expect(UNIFIED_QUESTION_PROMPT).not.toMatch(/[–—]/);
  });

  it("its schema asks for the kind and the fields those need, nothing else", () => {
    expect(UNIFIED_QUESTION_SCHEMA.required).toEqual(["kind", "personRef", "feature", "badge"]);
    expect(UNIFIED_QUESTION_SCHEMA.properties.kind.enum).toEqual(["list", "help", "my_stats", "other"]);
  });
});

describe("reading the reply as the engine's topics", () => {
  it("list is the squad post, help the help, my_stats the stats link, other the unified answer", () => {
    expect(parseUnifiedQuestion({ kind: "list", personRef: "", feature: "none", badge: "none" }).facts).toEqual({
      kind: "question",
      topic: "squad",
      personRef: null,
      statedCount: null,
    });
    expect(parseUnifiedQuestion({ kind: "help", personRef: "", feature: "teams", badge: "none" }).facts).toMatchObject({
      topic: "how_it_works",
      feature: "teams",
    });
    expect(parseUnifiedQuestion({ kind: "help", personRef: "", feature: "badges", badge: "reliable" }).facts).toMatchObject({
      feature: "badges",
      badge: "reliable",
    });
    expect(parseUnifiedQuestion({ kind: "help", personRef: "", feature: "none", badge: "none" }).facts.feature).toBeNull();
    expect(parseUnifiedQuestion({ kind: "my_stats", personRef: "", feature: "none", badge: "none" }).facts.topic).toBe("my_stats");
    expect(parseUnifiedQuestion({ kind: "other", personRef: "Idris", feature: "none", badge: "none" }).facts).toEqual({
      kind: "question",
      topic: "other",
      personRef: "Idris",
      statedCount: null,
    });
  });

  it("a person is kept only on other", () => {
    expect(parseUnifiedQuestion({ kind: "list", personRef: "Idris", feature: "none", badge: "none" }).facts.personRef).toBeNull();
  });

  it("an unknown kind is answered as anything else, and said", () => {
    const r = parseUnifiedQuestion({ kind: "stats", personRef: "", feature: "none", badge: "none" });
    expect(r.facts.topic).toBe("other");
    expect(r.problems.join(" ")).toMatch(/unknown question kind/);
  });
});

describe("the extractor call", () => {
  it("with the flag on: the small prompt, its schema and its own label", async () => {
    const { model, reqs } = stub({ kind: "list", personRef: "", feature: "none", badge: "none" });
    const res = await extractForRoute(model, "question", { ...MSG, unified: true });
    expect(res.facts).toMatchObject({ kind: "question", topic: "squad" });
    expect(reqs[0].system).toBe(UNIFIED_QUESTION_PROMPT);
    expect(reqs[0].schema).toEqual(UNIFIED_QUESTION_SCHEMA);
    expect(reqs[0].label).toBe("extractor:question-unified");
  });

  it("with the flag off: the old prompt, schema and label, exactly", async () => {
    const { model, reqs } = stub({
      topic: "squad",
      personRef: "",
      statedCount: -1,
      table: "none",
      listSize: -1,
      listEnd: "top",
      period: "none",
      periodCount: -1,
      periodUnit: "none",
      feature: "none",
      badge: "none",
      answersClarification: false,
    });
    await extractForRoute(model, "question", MSG);
    expect(reqs[0].system).toBe(EXTRACTOR_PROMPTS.question);
    expect(reqs[0].schema).toEqual(factsSchemaFor("question"));
    expect(reqs[0].label).toBe("extractor:question");
  });

  it("the flag never changes another extractor", async () => {
    const { model, reqs } = stub({ claims: [], affirmation: "none", sideRequests: [] });
    await extractForRoute(model, "self_att", { ...MSG, body: "in", unified: true });
    expect(reqs[0].system).toBe(EXTRACTOR_PROMPTS.attendance);
    expect(reqs[0].label).toBe("extractor:attendance");
  });
});
