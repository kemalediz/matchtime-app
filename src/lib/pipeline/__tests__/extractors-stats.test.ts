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
    expect(facts).toMatchObject({ topic: "stats", table: null, listSize: null, listEnd: "top" });
  });
});

describe("the schema and the prompt", () => {
  it("the schema asks for all three, as enums and a number", () => {
    const schema = factsSchemaFor("question") as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(schema.required).toEqual(expect.arrayContaining(["table", "listSize", "listEnd"]));
    expect(schema.properties.table.enum).toEqual(
      expect.arrayContaining(["ratings", "appearances", "mom", "elo", "team_of_season", "movers", "chemistry", "mr_reliable", "other", "none"]),
    );
    expect(schema.properties.listEnd.enum).toEqual(["top", "bottom"]);
  });

  it("carries Kemal's rulings: a bare leaderboard is ratings, Mr Reliable is the badge", () => {
    const p = EXTRACTOR_PROMPTS.question;
    expect(p).toMatch(/leaderboard.*ratings/i);
    expect(p).toMatch(/Mr\.? Reliable.*mr_reliable/i);
    expect(p).toMatch(/sıralama/);
  });
});
