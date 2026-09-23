/**
 * A STATS ANSWER IS NEVER REPLACED BY THE SQUAD LIST (2026-09-23).
 *
 * `route.ts` runs `composeSquadStateReply` over every owner reply and
 * REPLACES anything that looks like a roster with the upcoming squad.
 * A numbered list of players is exactly what a leaderboard looks like,
 * and "top 3 most consistent" turning into the squad list is the
 * 2026-05-14 incident. Two guards, either sufficient:
 *
 *   1. BY INTENT, the way the two team posts are skipped: every stats
 *      answer carries one of `STATS_ANSWER_INTENTS`, and the route skips
 *      those before it looks at the text. Pinned here, including the
 *      wiring in `route.ts`, because a guard nobody calls is a comment.
 *   2. BY SHAPE: every rendered table row carries one of
 *      `isLeaderboardLine`'s markers (`stats-answer.test.ts` asserts
 *      `displaysSquadState` is false for each, in both languages).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STATS_ANSWER_INTENTS, displaysSquadState, skipsSquadComposition } from "../group-copy";

describe("by intent", () => {
  it("every stats-answer intent is skipped", () => {
    expect([...STATS_ANSWER_INTENTS].sort()).toEqual(
      ["stats_clarification", "stats_clarified", "stats_generic", "stats_table"].sort(),
    );
    for (const i of STATS_ANSWER_INTENTS) expect(skipsSquadComposition(i), i).toBe(true);
  });
  it("the team posts are skipped, as they always were", () => {
    expect(skipsSquadComposition("generate_teams_request")).toBe(true);
    expect(skipsSquadComposition("show_teams_request")).toBe(true);
  });
  it("an ordinary question or attendance reply is still recomposed", () => {
    for (const i of ["question", "attendance", "self_att", null]) expect(skipsSquadComposition(i), String(i)).toBe(false);
  });
  it("route.ts asks this function, in the composition pass", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../app/api/whatsapp/analyze/route.ts"), "utf8");
    expect(src).toMatch(/if \(skipsSquadComposition\(r\.intent\)\) continue;/);
  });
});

describe("why the intent guard is needed at all", () => {
  it("a generic, model-written list with no markers WOULD be read as a squad", () => {
    expect(displaysSquadState("Top two:\n1. Sait Demir\n2. Idris Bello", "en")).toBe(true);
  });
});
