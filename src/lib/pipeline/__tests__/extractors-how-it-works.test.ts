/**
 * "HOW DOES THIS WORK?" IS A QUESTION THE BOT CAN ANSWER (2026-10-16, FNF).
 *
 * "Bench? We do bench now?", a reply to MatchTime's own "the bench is
 * open" post, asks how the bench works here. The question extractor had no
 * topic for it ("other", which nobody answers), so the model now names the
 * topic `how_it_works` and WHICH part of MatchTime, in the help menu's own
 * words; code answers with the help explainer for this club's settings.
 */
import { describe, expect, it } from "vitest";
import { EXTRACTOR_PROMPTS, factsSchemaFor, parseFacts } from "../extractors";

const parse = (raw: Record<string, unknown>) =>
  parseFacts(
    "question",
    JSON.stringify({
      topic: "how_it_works",
      personRef: "",
      statedCount: -1,
      table: "none",
      listSize: -1,
      listEnd: "top",
      period: "none",
      periodCount: -1,
      periodUnit: "none",
      feature: "none",
      ...raw,
    }),
    "m1",
  );

describe("a how-it-works question", () => {
  it("names the part of MatchTime it asks about", () => {
    const { facts, degradations } = parse({ feature: "availability" });
    expect(facts).toEqual({ kind: "question", topic: "how_it_works", personRef: null, statedCount: null, feature: "availability" });
    expect(degradations).toEqual([]);
  });

  it("every help topic is readable", () => {
    for (const f of ["availability", "teams", "mom", "ratings", "reminders", "payments"]) {
      expect(parse({ feature: f }).facts).toMatchObject({ feature: f });
    }
  });

  it("none is MatchTime as a whole; an unknown one is read as that, loudly", () => {
    expect(parse({}).facts).toMatchObject({ feature: null });
    const { facts, degradations } = parse({ feature: "parking" });
    expect(facts).toMatchObject({ feature: null });
    expect(degradations.length).toBe(1);
  });

  it("other topics never carry a feature", () => {
    const { facts } = parseFacts(
      "question",
      JSON.stringify({ topic: "bench", personRef: "", statedCount: -1, feature: "availability" }),
      "m1",
    );
    expect(facts).not.toHaveProperty("feature");
  });

  it("the schema and the prompt both know the topic and the field", () => {
    const schema = factsSchemaFor("question") as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(schema.properties.topic.enum).toContain("how_it_works");
    expect(schema.properties.feature.enum).toEqual(["availability", "teams", "mom", "ratings", "reminders", "payments", "none"]);
    expect(schema.required).toContain("feature");
    expect(EXTRACTOR_PROMPTS.question).toMatch(/how_it_works/);
    expect(EXTRACTOR_PROMPTS.question).toMatch(/\nfeature\n/);
  });
});
