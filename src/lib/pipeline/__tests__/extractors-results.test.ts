/**
 * A `score` question carries a count and a period (2026-09-29), in the
 * SAME fields a stats question uses: `listSize` and `period`. The model
 * reads "the last 5", "son 5 maç", "this season"; code never does.
 */
import { describe, expect, it } from "vitest";
import { EXTRACTOR_PROMPTS, parseFacts } from "../extractors";

const parse = (raw: Record<string, unknown>) =>
  parseFacts(
    "question",
    JSON.stringify({
      topic: "score",
      personRef: "",
      statedCount: -1,
      table: "none",
      listSize: -1,
      listEnd: "top",
      period: "none",
      periodCount: -1,
      periodUnit: "none",
      ...raw,
    }),
    "m1",
  );

describe("a score question's count and period", () => {
  it("the incident: the last 5 matches", () => {
    const { facts, degradations } = parse({ listSize: 5 });
    expect(facts).toEqual({ kind: "question", topic: "score", personRef: null, statedCount: null, listSize: 5, period: null });
    expect(degradations).toEqual([]);
  });

  it("no count and no period parse as null, which is today's answer", () => {
    expect(parse({}).facts).toEqual({ kind: "question", topic: "score", personRef: null, statedCount: null, listSize: null, period: null });
  });

  it("a period is carried", () => {
    expect(parse({ period: "season" }).facts).toMatchObject({ period: { kind: "season" } });
    expect(parse({ period: "this", periodUnit: "month" }).facts).toMatchObject({ period: { kind: "this", unit: "month" } });
    expect(parse({ period: "last", periodCount: 3, periodUnit: "month" }).facts).toMatchObject({
      period: { kind: "last", count: 3, unit: "month" },
    });
  });

  it("an unreadable period is dropped loudly", () => {
    const { facts, degradations } = parse({ period: "last", periodUnit: "fortnight" });
    expect(facts).toMatchObject({ period: null });
    expect(degradations.length).toBe(1);
  });

  it("a score question never carries a stats table", () => {
    expect(parse({ table: "ratings", listSize: 5 }).facts).not.toHaveProperty("table");
  });

  it("other non-stats topics keep their old shape", () => {
    const { facts } = parseFacts(
      "question",
      JSON.stringify({ topic: "fixture", personRef: "", statedCount: -1, listSize: 5, period: "season" }),
      "m1",
    );
    expect(facts).toEqual({ kind: "question", topic: "fixture", personRef: null, statedCount: null });
  });
});

describe("the prompt teaches results questions", () => {
  const p = EXTRACTOR_PROMPTS.question;
  it("carries the incident and its Turkish beside it", () => {
    expect(p).toContain("give us the scores of the last 5 matches");
    expect(p).toContain("son 5 maçın skorları");
  });
  it("defines listSize and period for score as well as stats", () => {
    const listSize = p.slice(p.search(/^listSize\b/m), p.search(/^listEnd\b/m));
    expect(listSize).toMatch(/score/);
    const period = p.slice(p.search(/^period\b/m), p.search(/^CLOSE CALLS/m));
    expect(period).toMatch(/score/);
  });
});
