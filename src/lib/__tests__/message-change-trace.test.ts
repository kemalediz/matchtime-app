/**
 * AN EDIT PURGES THE TEXT AND KEEPS THE FACTS (2026-11-16, PR #606 round
 * 8): what is left of a stored pipeline trace once its author edits the
 * message. The structured reading that later features act on stays; every
 * free-text field goes. Made-up content.
 */
import { describe, it, expect } from "vitest";
import { heldQuestionOf, isTextFree, sameJson, textFreeTrace, withHeldQuestion } from "../message-change-trace";

const SECRET = "my door code is 4321";

const TRACE = {
  v: 1,
  router: { route: "admin", source: "model", overrodeRoute: "none", model: "haiku", floor: false, degradations: [`router m1: could not read "${SECRET}"`] },
  extractions: [
    {
      owner: "admin_ops",
      route: "admin",
      extractor: "admin",
      model: "haiku",
      client: "anthropic",
      facts: { kind: "admin", action: "recruit", partnerClubs: true, clubRef: "Sutton Lads", pool: true, note: `bring ${SECRET}`, phrase: "on Monday", remindAt: "2026-11-17 18:00" },
      degradations: [`extractor m1: ${SECRET}`],
      calls: [{ ms: 812, stopReason: "end_turn", inputTokens: 3000, cacheReadTokens: 2000, cacheWriteTokens: 0, outputTokens: 90, costUsd: 0.001, raw: `{"note":"${SECRET}"}`, error: `bad JSON: ${SECRET}` }],
      sharedWith: ["team_ops"],
    },
    {
      owner: "team_ops",
      route: "team",
      extractor: "team",
      model: "haiku",
      client: "anthropic",
      facts: { kind: "team", includeRefs: ["Ali"], form: [{ personRef: "Ali", delta: -1, reason: SECRET }] },
      degradations: [],
      calls: [],
    },
  ],
  hqSquadReader: { names: ["Ali"], raw: SECRET },
  truncated: true,
};

describe("textFreeTrace", () => {
  it("keeps the structured reading features act on, and no free text anywhere", () => {
    const out = textFreeTrace(TRACE);
    expect(JSON.stringify(out)).not.toContain("4321");
    expect(out).toEqual({
      v: 1,
      router: { route: "admin", source: "model", overrodeRoute: "none", model: "haiku", floor: false, degradations: [] },
      extractions: [
        {
          owner: "admin_ops",
          route: "admin",
          extractor: "admin",
          model: "haiku",
          client: "anthropic",
          // The refused-ask retry reads kind, action, partnerClubs, clubRef and pool.
          facts: { kind: "admin", action: "recruit", partnerClubs: true, clubRef: "Sutton Lads", pool: true, note: "", phrase: "", remindAt: "2026-11-17 18:00" },
          degradations: [],
          calls: [{ ms: 812, stopReason: "end_turn", inputTokens: 3000, cacheReadTokens: 2000, cacheWriteTokens: 0, outputTokens: 90, costUsd: 0.001 }],
          sharedWith: ["team_ops"],
        },
        {
          owner: "team_ops",
          route: "team",
          extractor: "team",
          model: "haiku",
          client: "anthropic",
          facts: { kind: "team", includeRefs: ["Ali"], form: [{ personRef: "Ali", delta: -1, reason: "" }] },
          degradations: [],
          calls: [],
        },
      ],
      truncated: true,
    });
  });

  it("is idempotent, and null stays null; something that is no trace keeps nothing", () => {
    const once = textFreeTrace(TRACE);
    expect(textFreeTrace(once)).toEqual(once);
    expect(isTextFree(once)).toBe(true);
    expect(isTextFree(TRACE)).toBe(false);
    expect(textFreeTrace(null)).toBeNull();
    expect(isTextFree(null)).toBe(true);
    expect(textFreeTrace("a string")).toEqual({ v: 1, extractions: [] });
  });

  it("a trace read back from Postgres (JSONB orders keys its own way) is still seen as already text-free", () => {
    const once = textFreeTrace(TRACE) as Record<string, unknown>;
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(once).reverse())));
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(once));
    expect(sameJson(reordered, once)).toBe(true);
    expect(isTextFree(reordered)).toBe(true);
  });

  it("a question held for an open 'who do you mean?' is kept only while asked to, then goes", () => {
    const held = withHeldQuestion(textFreeTrace(TRACE), "how many goals has Idirs scored?", new Date("2026-11-16T10:00:00.000Z"));
    expect(heldQuestionOf(held)).toEqual({ text: "how many goals has Idirs scored?", until: new Date("2026-11-16T10:00:00.000Z") });
    expect(isTextFree(held)).toBe(false);
    expect(heldQuestionOf(textFreeTrace(held))).toBeNull();
    expect(heldQuestionOf(null)).toBeNull();
  });
});
