/**
 * The prepared live check is self-consistent, proved without a model.
 *
 * `score-live-cases.ts` lists what the real extractor will be asked and
 * what must come out. This runs each case's "correct extraction" through
 * the real parser and the real team resolver and checks it lands on the
 * stated outcome. If it did not, the live run would be grading the model
 * against a plan that was itself wrong.
 *
 * It also pins the two facts about the PROMPT that are testable for
 * free: every example message in it is a case here or in the engine
 * suite, and its size stays where the batch runner expects.
 */
import { describe, it, expect } from "vitest";
import { EXTRACTOR_PROMPTS, factsSchemaFor, parseFacts } from "../extractors";
import { EXTRACTOR_MODEL, estimateTokens, shouldCachePrompt } from "../llm";
import { resolveScoreResult } from "../score-teams";
import { SCORE_LIVE_CASES } from "../score-live-cases";

describe("the prepared live check for the score extractor", () => {
  it("has a unique id per case and covers history, the incident, new forms, corrections and Turkish", () => {
    const ids = SCORE_LIVE_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const prefix of ["H", "I", "N", "C", "T"]) {
      expect(ids.some((i) => i.startsWith(prefix))).toBe(true);
    }
  });

  it.each(SCORE_LIVE_CASES.map((c) => [c.id, c] as const))(
    "%s: a correct extraction produces the stated outcome",
    (_id, c) => {
      // Through the parser, as a model response would arrive: every
      // schema field present, "" for a team the message does not name.
      const wire = {
        first: c.facts.first,
        second: c.facts.second,
        firstTeam: c.facts.firstTeam ?? "",
        secondTeam: c.facts.secondTeam ?? "",
        winner: c.facts.winner ?? "",
        loser: c.facts.loser ?? "",
        correction: c.facts.correction ?? false,
      };
      const { facts, degradations } = parseFacts("score", JSON.stringify(wire), c.id);
      expect(degradations).toEqual([]);
      if (facts.kind !== "score") throw new Error("not score facts");
      expect(facts.correction ?? false).toBe(c.correction ?? false);

      const res = resolveScoreResult({
        facts,
        labels: c.labels ?? ["Red", "Yellow"],
        senderTeam: c.senderTeam ?? null,
      });
      if (c.expect === "ask") expect(res.kind).toBe("ask");
      else expect(res).toEqual({ kind: "resolved", ...c.expect });
    },
  );
});

describe("the score extractor's schema and prompt", () => {
  it("the schema carries the teams as text and admits no decision", () => {
    const schema = factsSchemaFor("score") as {
      properties: Record<string, { type: string; enum?: unknown }>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["correction", "first", "firstTeam", "loser", "second", "secondTeam", "winner"].sort(),
    );
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
    // Free text, never an enum of RED / YELLOW: which side is Red is
    // code's to decide, from the club's own team names.
    for (const k of ["firstTeam", "secondTeam", "winner", "loser"]) {
      expect(schema.properties[k]).toEqual({ type: "string" });
    }
    expect(JSON.stringify(schema)).not.toMatch(/RED|YELLOW/);
  });

  it("the prompt names every field once as a heading and never names a colour as an answer", () => {
    const p = EXTRACTOR_PROMPTS.score;
    for (const heading of ["first, second\n", "firstTeam, secondTeam\n", "winner\n", "loser\n", "correction\n"]) {
      expect(p.split(`\n${heading}`).length).toBe(2);
    }
    expect(p).not.toMatch(/RED|YELLOW/);
    expect(p).not.toMatch(/[–—]/);
  });

  it("stays under Sonnet 5's cache minimum, so score extractions are not sequenced behind a warm-up", () => {
    // 193 characters before the rewrite, about 2,900 after. The batch
    // runner warms a CACHEABLE prompt with one call before fanning out
    // (`fan-out.ts`); a prompt under the minimum carries no marker and
    // all its calls start at once, which `score-engine-batch.test.ts`
    // pins. A score is reported a few times a WEEK, so a cache with a
    // one hour life would never be read: staying under is right, and
    // this fails the day somebody grows the prompt past the line
    // without deciding that on purpose.
    expect(EXTRACTOR_PROMPTS.score.length).toBeGreaterThan(2_000);
    expect(EXTRACTOR_PROMPTS.score.length).toBeLessThan(4_096);
    expect(estimateTokens(EXTRACTOR_PROMPTS.score)).toBeLessThan(1_024);
    expect(shouldCachePrompt(EXTRACTOR_MODEL, EXTRACTOR_PROMPTS.score)).toBe(false);
  });
});

describe("the score parser", () => {
  it("drops an unnamed team rather than carrying an empty string", () => {
    const { facts } = parseFacts(
      "score",
      '{"first":9,"second":6,"firstTeam":"","secondTeam":"","winner":" yellows ","loser":"","correction":false}',
      "wa-1",
    );
    expect(facts).toEqual({ kind: "score", first: 9, second: 6, winner: "yellows" });
  });

  it("still reads the old two-number shape, as a result that names no team", () => {
    const { facts } = parseFacts("score", '{"first":5,"second":3}', "wa-1");
    expect(facts).toEqual({ kind: "score", first: 5, second: 3 });
  });

  it("only a literal true is a correction", () => {
    const one = parseFacts("score", '{"first":1,"second":0,"correction":"yes"}', "wa-1").facts;
    expect(one).not.toHaveProperty("correction");
    const two = parseFacts("score", '{"first":1,"second":0,"correction":true}', "wa-1").facts;
    expect(two).toMatchObject({ correction: true });
  });
});
