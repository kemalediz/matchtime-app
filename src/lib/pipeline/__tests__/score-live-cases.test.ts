/**
 * The prepared live check is self-consistent, proved without a model.
 *
 * `score-live-cases.ts` lists what the real extractor will be asked and
 * what must come out. This runs each case's "correct extraction" through
 * the real parser and the real ENGINE and checks it lands on the stated
 * outcome. If it did not, the live run would be grading the model
 * against a plan that was itself wrong.
 *
 * It also pins what is testable for free about the PROMPT and the
 * schema: the fields, that no field admits a decision, and the size the
 * batch runner relies on.
 */
import { describe, it, expect } from "vitest";
import { EXTRACTOR_PROMPTS, factsSchemaFor, parseFacts } from "../extractors";
import { EXTRACTOR_MODEL, estimateTokens, shouldCachePrompt } from "../llm";
import { SCORE_LIVE_CASES, runScoreCase } from "./score-live-cases";

/** A case's facts as the model would send them: every schema field
 *  present, "" for a team not named, zeros when there is no scoreline. */
function wire(f: (typeof SCORE_LIVE_CASES)[number]["facts"]) {
  const hasScore = f.first !== null && f.second !== null;
  return {
    hasScore,
    first: hasScore ? f.first : 0,
    second: hasScore ? f.second : 0,
    firstTeam: f.firstTeam ?? "",
    secondTeam: f.secondTeam ?? "",
    winner: f.winner ?? "",
    loser: f.loser ?? "",
    correction: f.correction ?? false,
    swapped: f.swapped ?? false,
    otherGame: f.otherGame ?? false,
  };
}

describe("the prepared live check for the score extractor", () => {
  it("has a unique id per case and covers every group the review asked for", () => {
    const ids = SCORE_LIVE_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    // History, incident, new forms, lone names, corrections, numberless
    // corrections, tag-is-not-a-correction, the one-word answer, Turkish.
    for (const prefix of ["H", "I", "N", "L", "C", "X", "G", "A", "T"]) {
      expect(ids.some((i) => i.startsWith(prefix)), prefix).toBe(true);
    }
    const bodies = SCORE_LIVE_CASES.map((c) => c.body).join("\n");
    for (const must of [
      "wrong way round, yellows won",
      "tam tersi, sarılar kazandı",
      "Reds 3-5",
      "last week we lost 9-2",
      "10-7",
    ]) {
      expect(bodies).toContain(must);
    }
    expect(SCORE_LIVE_CASES.some((c) => c.body === "Yellow" && c.pending)).toBe(true);
  });

  it.each(SCORE_LIVE_CASES.map((c) => [c.id, c] as const))(
    "%s: a correct extraction produces the stated outcome",
    (_id, c) => {
      const { facts, degradations } = parseFacts("score", JSON.stringify(wire(c.facts)), c.id);
      expect(degradations).toEqual([]);
      if (facts.kind !== "score") throw new Error("not score facts");
      expect(runScoreCase(c, facts)).toEqual(c.expect);
    },
  );

  it("NO case can be satisfied by recording 0-0", () => {
    for (const c of SCORE_LIVE_CASES) {
      if (typeof c.expect === "string") continue;
      expect(c.expect.red + c.expect.yellow, c.id).toBeGreaterThan(0);
    }
  });
});

describe("the score extractor's schema and prompt", () => {
  const FIELDS = [
    "hasScore",
    "first",
    "second",
    "firstTeam",
    "secondTeam",
    "winner",
    "loser",
    "correction",
    "swapped",
    "otherGame",
  ];

  it("the schema carries the teams as text and admits no decision", () => {
    const schema = factsSchemaFor("score") as {
      properties: Record<string, { type: string; enum?: unknown }>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual([...FIELDS].sort());
    expect([...schema.required].sort()).toEqual([...FIELDS].sort());
    // Free text, never an enum of RED / YELLOW: which side is Red is
    // code's to decide, from the club's own team names.
    for (const k of ["firstTeam", "secondTeam", "winner", "loser"]) {
      expect(schema.properties[k]).toEqual({ type: "string" });
    }
    expect(JSON.stringify(schema)).not.toMatch(/RED|YELLOW/);
  });

  it("the prompt defines every field once, as a heading", () => {
    const p = EXTRACTOR_PROMPTS.score;
    for (const heading of [
      "hasScore\n",
      "first, second\n",
      "firstTeam, secondTeam\n",
      "winner\n",
      "loser\n",
      "correction\n",
      "swapped\n",
      "otherGame\n",
    ]) {
      expect(p.split(`\n${heading}`).length, heading).toBe(2);
    }
    expect(p).not.toMatch(/RED|YELLOW/);
    expect(p).not.toMatch(/[–—]/);
  });

  it("the prompt no longer says a lone team name beside a scoreline is the winner (review item 5)", () => {
    const p = EXTRACTOR_PROMPTS.score;
    expect(p).not.toMatch(/on its own beside a scoreline/);
    expect(p).toMatch(/"Reds 3-5" -> first 3, second 5, firstTeam "Reds", winner ""/);
  });

  it("stays under Sonnet 5's cache minimum, so score extractions are not sequenced behind a warm-up", () => {
    // 193 characters before any of this, about 4,000 now. The batch
    // runner warms a CACHEABLE prompt with one call before fanning out
    // (`fan-out.ts`); a prompt under the minimum carries no marker and
    // all its calls start at once, which `score-engine-batch.test.ts`
    // pins. A score is reported a few times a WEEK, so a cache with a
    // one hour life would never be read: staying under is right, and
    // this fails the day somebody grows the prompt past the line
    // without deciding that on purpose. THERE IS LITTLE ROOM LEFT: the
    // next field means either moving over the line deliberately (and
    // updating the batch test) or cutting examples.
    expect(EXTRACTOR_PROMPTS.score.length).toBeGreaterThan(2_000);
    expect(EXTRACTOR_PROMPTS.score.length).toBeLessThan(4_096);
    expect(estimateTokens(EXTRACTOR_PROMPTS.score)).toBeLessThan(1_024);
    expect(shouldCachePrompt(EXTRACTOR_MODEL, EXTRACTOR_PROMPTS.score)).toBe(false);
  });
});

describe("the score parser", () => {
  const base = { firstTeam: "", secondTeam: "", winner: "", loser: "", correction: false, swapped: false, otherGame: false };

  it("NO NUMBERS IS NOT 0-0: hasScore false arrives as nulls, whatever the numbers say (review item 3)", () => {
    const { facts, degradations } = parseFacts(
      "score",
      JSON.stringify({ ...base, hasScore: false, first: 0, second: 0, winner: "yellows", correction: true, swapped: true }),
      "wa-1",
    );
    expect(degradations).toEqual([]);
    expect(facts).toEqual({ kind: "score", first: null, second: null, winner: "yellows", correction: true, swapped: true });
    // Even a model that contradicts itself cannot smuggle a score in.
    const odd = parseFacts("score", JSON.stringify({ ...base, hasScore: false, first: 3, second: 1 }), "wa-1").facts;
    expect(odd).toEqual({ kind: "score", first: null, second: null });
  });

  it("a position needs a number: firstTeam is dropped when there is no scoreline", () => {
    const { facts } = parseFacts(
      "score",
      JSON.stringify({ ...base, hasScore: false, first: 0, second: 0, firstTeam: "Yellow" }),
      "wa-1",
    );
    expect(facts).toEqual({ kind: "score", first: null, second: null });
  });

  it("drops an unnamed team rather than carrying an empty string", () => {
    const { facts } = parseFacts(
      "score",
      JSON.stringify({ ...base, hasScore: true, first: 9, second: 6, winner: " yellows " }),
      "wa-1",
    );
    expect(facts).toEqual({ kind: "score", first: 9, second: 6, winner: "yellows" });
  });

  it("still reads the old two-number shape, as a result that names no team", () => {
    const { facts } = parseFacts("score", '{"first":5,"second":3}', "wa-1");
    expect(facts).toEqual({ kind: "score", first: 5, second: 3 });
  });

  it("hasScore true with no numbers is unreadable, not a score", () => {
    const r = parseFacts("score", JSON.stringify({ ...base, hasScore: true, first: "lots", second: 3 }), "wa-1");
    expect(r.facts.kind).toBe("none");
    expect(r.degradations).toHaveLength(1);
  });

  it("only a literal true sets a flag", () => {
    const one = parseFacts("score", '{"first":1,"second":0,"correction":"yes","swapped":1,"otherGame":"true"}', "wa-1").facts;
    expect(one).toEqual({ kind: "score", first: 1, second: 0 });
    const two = parseFacts("score", '{"first":1,"second":0,"correction":true,"otherGame":true}', "wa-1").facts;
    expect(two).toMatchObject({ correction: true, otherGame: true });
  });
});
