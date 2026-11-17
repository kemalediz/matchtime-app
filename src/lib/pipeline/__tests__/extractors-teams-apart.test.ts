/**
 * THE TEAMS EXTRACTOR READS "APART" (2026-11-16, the Vets: "@Match Time
 * generate the teams, put Dan and Craig in separate teams please" came back
 * as a plain generate with empty pairings: the prompt could say "together"
 * and had no way to say "apart", so the request was silently ignored).
 *
 * `apart` is the other half of `pairings`: one array per group of people
 * who must be split between the teams. Defined once in the prompt, beside
 * pairings, with EN and TR examples for a new build, a rebuild and the
 * teams as they stand.
 */
import { describe, expect, it } from "vitest";
import { EXTRACTOR_PROMPTS, factsSchemaFor, parseFacts } from "../extractors";
import type { TeamFacts } from "../types";

const base = { includeRefs: [], teamNames: [], swaps: [], moves: [], pairings: [], swapSides: false, toMatchTime: true, form: [] };

describe("teams extractor: apart", () => {
  it("parses apart groups, trimmed, dropping a group of fewer than two", () => {
    const raw = JSON.stringify({ ...base, action: "generate", apart: [["Dan", " Craig "], ["Sam"], []] });
    const facts = parseFacts("teams", raw, "wa-1").facts as TeamFacts;
    expect(facts).toMatchObject({ kind: "teams", action: "generate", apart: [["Dan", "Craig"]] });
  });

  it("an older stub with no apart parses to an empty list", () => {
    const facts = parseFacts("teams", JSON.stringify({ ...base, action: "generate" }), "wa-1").facts as TeamFacts;
    expect(facts.apart).toEqual([]);
  });

  it("apart and pairings are read side by side, on a swap too", () => {
    const raw = JSON.stringify({ ...base, action: "swap", pairings: [["Ali", "Habib"]], apart: [["Dan", "Craig"]] });
    expect(parseFacts("teams", raw, "wa-1").facts).toMatchObject({ action: "swap", pairings: [["Ali", "Habib"]], apart: [["Dan", "Craig"]] });
  });

  it("the schema requires apart, an array of arrays of names", () => {
    const schema = factsSchemaFor("balancer") as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toContain("apart");
    expect(schema.properties.apart).toEqual({ type: "array", items: { type: "array", items: { type: "string" } } });
  });

  it("the prompt defines pairings and apart once each, at the start of their own lines", () => {
    const p = EXTRACTOR_PROMPTS.teams;
    for (const field of ["pairings", "apart"]) expect(p.split(`\n${field}\n`).length, field).toBe(2);
  });

  it("the prompt's examples teach apart for a new build, a rebuild and the teams as they stand, EN and TR", () => {
    const p = EXTRACTOR_PROMPTS.teams;
    expect(p).toMatch(/"generate the teams, put Dan and Craig in separate teams please"[^\n]*-> generate, apart \[\["Dan","Craig"\]\]/);
    expect(p).toMatch(/"regenerate the teams, Dan and Craig on different teams"[^\n]*-> generate, apart/);
    expect(p).toMatch(/"keep Dan and Craig apart"[^\n]*-> swap, apart \[\["Dan","Craig"\]\]/);
    expect(p).toMatch(/"takımları kur, Dan ile Craig ayrı takımlarda olsun"[^\n]*-> generate, apart/);
    expect(p).toMatch(/"Dan ile Craig'i ayır"[^\n]*-> swap, apart/);
  });

  it("the prompt has no em or en dashes", () => {
    expect(EXTRACTOR_PROMPTS.teams).not.toMatch(/[–—]/);
  });
});
