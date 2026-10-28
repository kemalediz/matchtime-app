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
import { HELP_BADGES, HELP_FEATURES } from "../types";

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
    for (const f of ["availability", "teams", "mom", "ratings", "reminders", "payments", "schedule", "badges", "partners", "pool", "settings"]) {
      expect(parse({ feature: f }).facts).toMatchObject({ feature: f });
    }
  });

  it("none is MatchTime as a whole; an unknown one is read as that, loudly", () => {
    expect(parse({}).facts).toMatchObject({ feature: null });
    const { facts, degradations } = parse({ feature: "parking" });
    expect(facts).toMatchObject({ feature: null });
    expect(degradations.length).toBe(1);
  });

  it("a badges question names its badge; an unknown one is every badge, loudly; other parts carry none (2026-10-28)", () => {
    expect(parse({ feature: "badges", badge: "reliable" }).facts).toMatchObject({ feature: "badges", badge: "reliable" });
    expect(parse({ feature: "badges", badge: "none" }).facts).toMatchObject({ feature: "badges", badge: null });
    const odd = parse({ feature: "badges", badge: "golden-boot" });
    expect(odd.facts).toMatchObject({ badge: null });
    expect(odd.degradations.length).toBe(1);
    expect(parse({ feature: "pool", badge: "reliable" }).facts).not.toHaveProperty("badge");
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
    expect(schema.properties.feature.enum).toEqual([
      "availability", "teams", "mom", "ratings", "reminders", "payments", "schedule", "badges", "partners", "pool", "settings", "none",
    ]);
    expect(schema.properties.badge.enum).toEqual([...HELP_BADGES, "none"]);
    expect(schema.required).toContain("feature");
    expect(schema.required).toContain("badge");
    expect(EXTRACTOR_PROMPTS.question).toMatch(/how_it_works/);
    expect(EXTRACTOR_PROMPTS.question).toMatch(/\nfeature\n/);
    expect(EXTRACTOR_PROMPTS.question).toMatch(/\nbadge\n/);
    // Every topic and badge the schema allows is defined in the prompt.
    for (const f of HELP_FEATURES) expect(EXTRACTOR_PROMPTS.question, f).toMatch(new RegExp(`\\n  ${f} +`));
    for (const b of HELP_BADGES) expect(EXTRACTOR_PROMPTS.question, b).toContain(`${b} (`);
  });
});
