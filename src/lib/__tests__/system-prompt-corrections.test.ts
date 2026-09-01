/**
 * SYSTEM_PROMPT hygiene — the model reads all of it, so a wrong line is a
 * behaviour bug with a token bill attached.
 *
 * Every assertion here comes from analyzer-redesign-2026-08-31.md §3.4,
 * "Category E — things that are simply wrong". Each was found by reading the
 * prompt end to end, which is the point: nobody can any more, so the checks
 * that a human would have caught live here instead.
 */
import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT } from "@/lib/message-analyzer";

/** Non-trivial lines of the prompt, trimmed, with their 1-based numbers. */
function promptLines(): Array<{ n: number; text: string }> {
  return SYSTEM_PROMPT.split("\n")
    .map((text, i) => ({ n: i + 1, text: text.trim() }))
    .filter((l) => l.text.length >= 40);
}

describe("§3.4.1 — no paragraph is sent twice", () => {
  it("has no byte-identical duplicated line", () => {
    const seen = new Map<string, number[]>();
    for (const { n, text } of promptLines()) {
      seen.set(text, [...(seen.get(text) ?? []), n]);
    }
    const dupes = [...seen.entries()]
      .filter(([, at]) => at.length > 1)
      .map(([text, at]) => `lines ${at.join(" + ")}: ${text.slice(0, 90)}…`);
    expect(dupes).toEqual([]);
  });

  it("states the BENCH-questions rule exactly once", () => {
    const hits = SYSTEM_PROMPT.split("\n").filter((l) => l.includes("For BENCH questions"));
    expect(hits).toHaveLength(1);
  });

  it("still states it — deleting the duplicate must not delete the rule", () => {
    expect(SYSTEM_PROMPT).toContain("For BENCH questions");
    expect(SYSTEM_PROMPT).toContain("Bench is empty — no standby players.");
    // The 2026-04-28 hallucination the rule exists to stop.
    expect(SYSTEM_PROMPT).toContain("(5-a-side bench if we downgrade)");
  });
});
