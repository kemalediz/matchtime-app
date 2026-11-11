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

/**
 * Round 2 (2026-11-11): the A/B saw "which squad list to accept? Could you
 * mention it again?" read as help and "make the list" read as anything
 * else. The prompt now defines list by wanting to SEE the list, in any
 * words, and teaches both shapes in English and Turkish. A pin on the
 * prompt's examples; the model's reading is checked by the paid A/B.
 */
describe("round 2: the list is defined by wanting to see it", () => {
  const listExamples = UNIFIED_QUESTION_PROMPT.slice(UNIFIED_QUESTION_PROMPT.indexOf("The list:"), UNIFIED_QUESTION_PROMPT.indexOf("Help:"));
  it("teaches 'make the list' and 'which list is right, share it again' as list, in both languages", () => {
    expect(listExamples).toMatch(/make the list.*listeyi yap.*-> list/);
    expect(listExamples).toMatch(/which squad list is right, can you share it again\?.*-> list/);
  });

  it("help never covers a request to see today's names", () => {
    expect(UNIFIED_QUESTION_PROMPT).toMatch(/help {6}[^\n]*Never a request to see today's names/);
  });

  it("asking MatchTime whether it will be at the match is anything else, never help", () => {
    expect(UNIFIED_QUESTION_PROMPT).toMatch(/will we see you there\?.*-> other/);
  });
});

describe("round 2, pass 2a: 'squad status' is a count, not the list", () => {
  it("is taught as other in both languages", () => {
    expect(UNIFIED_QUESTION_PROMPT).toMatch(/what's the squad status\?.*kadro durumu ne\?.*-> other/);
  });
});

describe("round 3: a question about what happens at the club is other, never help (FNF HQ 'what happens if 14 don't confirm?')", () => {
  it("help is defined as how to use MatchTime, and never covers what happens at this club", () => {
    const help = UNIFIED_QUESTION_PROMPT.slice(UNIFIED_QUESTION_PROMPT.indexOf("  help "), UNIFIED_QUESTION_PROMPT.indexOf("  my_stats "));
    expect(help).toMatch(/how to use MatchTime/);
    expect(help).toMatch(/Never a question about what happens or will happen at this club/);
  });

  it("is taught as other in both languages", () => {
    expect(UNIFIED_QUESTION_PROMPT).toMatch(/"@Match Time what happens if we don't fill the squad\?" \| "@Match Time kadro dolmazsa ne olur\?" -> other/);
  });
});
