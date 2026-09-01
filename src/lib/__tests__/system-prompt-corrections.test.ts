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
import { SYSTEM_PROMPT, type AnalysisIntent } from "@/lib/message-analyzer";

/**
 * Every value `AnalysisIntent` admits, written out.
 *
 * The `satisfies` clause is the load-bearing part: TypeScript erases the
 * union at runtime, so this array is the only way a test can see it — and the
 * annotation makes the compiler fail the build if a new intent is added to the
 * type and not to this list. That is what stops the prompt's schema and the
 * server's accepted set drifting apart again (§3.4.2: the prompt listed 12,
 * `normaliseVerdict` accepted 13, for nearly four months).
 */
const ALL_INTENTS = [
  "in",
  "out",
  "replacement_request",
  "conditional_in",
  "question",
  "score",
  "generate_teams_request",
  "show_teams_request",
  "bring_guests_vague",
  "bulk_payment_credit",
  "reminder_request",
  "noise",
  "unclear",
] as const satisfies readonly AnalysisIntent[];

/** The quoted values on the schema's `"intent":` line, in order. */
function promptIntentEnum(): string[] {
  const line = SYSTEM_PROMPT.split("\n").find((l) => l.trim().startsWith('"intent":'));
  if (!line) throw new Error('no "intent" line in the output schema');
  return [...line.slice(line.indexOf(":") + 1).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

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

describe("§3.4.2 — the prompt's output schema matches what the server accepts", () => {
  it("offers every AnalysisIntent, including bulk_payment_credit", () => {
    expect(promptIntentEnum()).toEqual([...ALL_INTENTS]);
  });

  it("offers no intent the server would throw away", () => {
    for (const intent of promptIntentEnum()) {
      expect(ALL_INTENTS as readonly string[]).toContain(intent);
    }
  });

  it("does not teach a section whose intent the schema omits", () => {
    // S21 spends ~459 tokens on bulk_payment_credit. Before this fix the
    // schema three sections earlier did not admit it, and the section worked
    // only because the model ignored the schema line.
    expect(SYSTEM_PROMPT).toContain('"bulk_payment_credit"');
    expect(promptIntentEnum()).toContain("bulk_payment_credit");
  });

  it("keeps the other schema enums in step with AnalysisVerdict", () => {
    // Checked at the same time as the intent enum, because §3.4.2's lesson is
    // that a drifted enum goes unnoticed for months. These are the remaining
    // closed sets in the schema block. All four were verified correct when
    // this was written; they are here so the next drift is caught on the
    // first run rather than the next cold read.
    expect(SYSTEM_PROMPT).toContain('"registerAttendance": "IN" | "OUT" | "BENCH" | null');
    expect(SYSTEM_PROMPT).toContain('"benchConfirmation": "yes" | "no" | null');
    expect(SYSTEM_PROMPT).toContain('"team": "RED" | "YELLOW"');
    expect(SYSTEM_PROMPT).toContain('"action": "IN" | "OUT" | "BENCH"');
    expect(SYSTEM_PROMPT).toContain('"recruitRequest": true | false');
  });
});
