/**
 * The question extractor's three new fields (2026-09-23): WHICH table,
 * HOW MANY, and top or BOTTOM. Before this there was nowhere for
 * "ratings" or "10" to go, so they were discarded by construction.
 */
import { describe, expect, it } from "vitest";
import { EXTRACTOR_PROMPTS, factsSchemaFor, parseFacts } from "../extractors";

const parse = (raw: Record<string, unknown>) =>
  parseFacts("question", JSON.stringify({ topic: "stats", personRef: "", statedCount: -1, ...raw }), "m1");

describe("parsing the new fields", () => {
  it("the incident: ratings, ten, top", () => {
    const { facts, degradations } = parse({ table: "ratings", listSize: 10, listEnd: "top" });
    expect(facts).toEqual({
      kind: "question",
      topic: "stats",
      personRef: null,
      statedCount: null,
      table: "ratings",
      listSize: 10,
      listEnd: "top",
      period: null,
    });
    expect(degradations).toEqual([]);
  });

  it("'none' and -1 are the schema's stand-ins for null", () => {
    const { facts } = parse({ table: "none", listSize: -1, listEnd: "top" });
    expect(facts).toMatchObject({ table: null, listSize: null, listEnd: "top" });
  });

  it("every known table survives the round trip", () => {
    for (const t of ["ratings", "appearances", "mom", "elo", "team_of_season", "movers", "chemistry", "mr_reliable", "other"]) {
      expect(parse({ table: t, listSize: -1, listEnd: "top" }).facts, t).toMatchObject({ table: t });
    }
  });

  it("a drifted table is dropped loudly, never coerced into a neighbour", () => {
    const { facts, degradations } = parse({ table: "goals", listSize: -1, listEnd: "top" });
    expect(facts).toMatchObject({ table: null });
    expect(degradations.map((d) => d.detail).join(" ")).toMatch(/goals/);
  });

  it("bottom is kept; anything else is top", () => {
    expect(parse({ table: "ratings", listSize: 5, listEnd: "bottom" }).facts).toMatchObject({ listEnd: "bottom" });
    expect(parse({ table: "ratings", listSize: 5, listEnd: "sideways" }).facts).toMatchObject({ listEnd: "top" });
  });

  it("the size is taken as written; the group cap is the engine's, not the model's", () => {
    expect(parse({ table: "ratings", listSize: 20, listEnd: "top" }).facts).toMatchObject({ listSize: 20 });
    expect(parse({ table: "ratings", listSize: 2.7, listEnd: "top" }).facts).toMatchObject({ listSize: 2 });
    expect(parse({ table: "ratings", listSize: 0, listEnd: "top" }).facts).toMatchObject({ listSize: null });
  });

  it("an older payload with none of the new fields still parses, as 'no table'", () => {
    const { facts } = parseFacts("question", JSON.stringify({ topic: "stats", personRef: "", statedCount: -1 }), "m1");
    expect(facts).toMatchObject({ topic: "stats", table: null, listSize: null, listEnd: "top", period: null });
  });
});

describe("the period (2026-09-23)", () => {
  it("Kemal's question: appearances in the last 1 year", () => {
    const { facts, degradations } = parse({
      table: "appearances",
      listSize: -1,
      listEnd: "top",
      period: "last",
      periodCount: 1,
      periodUnit: "year",
    });
    expect(facts).toMatchObject({ table: "appearances", period: { kind: "last", count: 1, unit: "year" } });
    expect(degradations).toEqual([]);
  });

  it("season, all time, a calendar month", () => {
    const p = (period: string, periodUnit = "none") =>
      parse({ table: "ratings", listSize: -1, listEnd: "top", period, periodCount: -1, periodUnit }).facts;
    expect(p("season")).toMatchObject({ period: { kind: "season" } });
    expect(p("all_time")).toMatchObject({ period: { kind: "all_time" } });
    expect(p("this", "month")).toMatchObject({ period: { kind: "this", unit: "month" } });
    expect(p("none")).toMatchObject({ period: null });
  });

  it("an unreadable period is dropped loudly, and the question is still answered", () => {
    const { facts, degradations } = parse({ table: "ratings", listSize: -1, listEnd: "top", period: "last", periodCount: 2, periodUnit: "none" });
    expect(facts).toMatchObject({ table: "ratings", period: null });
    expect(degradations.map((d) => d.detail).join(" ")).toMatch(/period/);
  });

  it("a period on a question that is not stats is not carried", () => {
    const { facts } = parseFacts(
      "question",
      JSON.stringify({ topic: "count", personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "last", periodCount: 1, periodUnit: "week" }),
      "m1",
    );
    expect(facts).toEqual({ kind: "question", topic: "count", personRef: null, statedCount: null });
  });
});

describe("the schema and the prompt", () => {
  it("the schema asks for every field, as enums and numbers", () => {
    const schema = factsSchemaFor("question") as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(schema.required).toEqual(expect.arrayContaining(["table", "listSize", "listEnd", "period", "periodCount", "periodUnit"]));
    expect(schema.properties.period.enum).toEqual(["none", "last", "this", "season", "all_time"]);
    expect(schema.properties.periodUnit.enum).toEqual(["none", "day", "week", "month", "year"]);
    expect(schema.properties.table.enum).toEqual(
      expect.arrayContaining(["ratings", "appearances", "mom", "elo", "team_of_season", "movers", "chemistry", "mr_reliable", "other", "none"]),
    );
    expect(schema.properties.listEnd.enum).toEqual(["top", "bottom"]);
  });

  it("carries Kemal's rulings: a bare leaderboard is ratings, Mr Reliable is the badge", () => {
    const p = EXTRACTOR_PROMPTS.question;
    expect(p).toMatch(/leaderboard.*ratings/i);
    expect(p).toMatch(/mr_reliable[^\n]*Mr Reliable/i);
    expect(p).toMatch(/sıralama/);
  });

  it("Kemal's exact message and its Turkish equivalent are worked examples", () => {
    const p = EXTRACTOR_PROMPTS.question;
    expect(p).toContain("who has played most matches in the last 1 year?");
    expect(p).toContain("son 1 yılda en çok maç oynayan kim?");
    expect(p).toMatch(/bu sezon/);
    expect(p).toMatch(/geçen ay/);
  });
});

/**
 * THE PROMPT IS ONE DOCUMENT, NOT A PILE (Kemal, 2026-09-23): "do not
 * make the prompt bigger and huge by always adding to the end, redo the
 * entire prompt and make it clearer". These pin the shape of the rewrite
 * so the next change has to keep it: every field defined once, in one
 * place, in the order the schema lists them; the rulings stated once.
 */
describe("the question prompt's structure", () => {
  const p = EXTRACTOR_PROMPTS.question;
  const FIELDS = ["topic", "personRef", "statedCount", "table", "listSize", "listEnd", "period"] as const;

  it("defines each field exactly once, as a line-leading heading, in schema order", () => {
    const at = FIELDS.map((f) => {
      const heads = [...p.matchAll(new RegExp(`^${f}\\b`, "gm"))];
      expect(heads, f).toHaveLength(1);
      return heads[0].index!;
    });
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("states each ruling once", () => {
    const count = (re: RegExp) => (p.match(re) ?? []).length;
    expect(count(/bare "leaderboard"/gi)).toBe(1);
    expect(count(/never appearances/gi)).toBe(1);
  });

  it("names every topic and every table the parser accepts", () => {
    for (const t of ["squad", "bench", "count", "person_status", "phones", "fixture", "payments", "score", "rating_progress", "my_stats", "stats", "options", "other"]) {
      expect(p, t).toMatch(new RegExp(`^  ${t}\\b`, "m"));
    }
    for (const t of ["ratings", "appearances", "mom", "elo", "team_of_season", "movers", "chemistry", "mr_reliable"]) {
      expect(p, t).toMatch(new RegExp(`^  ${t}\\b`, "m"));
    }
  });

  it("has Turkish beside English for every group of examples", () => {
    const examples = p.slice(p.indexOf("EXAMPLES"));
    const groups = examples.split(/\n(?=[A-Z][^\n]*:\n)/).slice(1);
    expect(groups.length).toBeGreaterThanOrEqual(5);
    for (const g of groups) expect(g, g.split("\n")[0]).toMatch(/[çğıöşüİ]/);
  });
});
