/**
 * THE ROSTER CHECK-IN CLASSIFIER (2026-10-19, Haiku 5.5 trial).
 *
 * "Evet bu ay varım" (yes, I'm in this month) came back `maybe`, and so
 * did the English "yes I'm in this month": the old prompt defined "in" as
 * an open-ended weekly commitment and pushed any time word towards
 * `maybe`, so a yes for a stated stretch lost its yes. The prompt was
 * rewritten whole; the live check is `scripts/dryrun-roster-survey.ts`.
 * These tests pin the shape, offline, with the model injected.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ROSTER_SURVEY_SYSTEM_PROMPT,
  buildRosterSurveyUserTurn,
  classifyRosterReply,
} from "../roster-survey-classifier";
import { HAIKU_MODEL } from "../models";
import { MIN_CACHEABLE_TOKENS, estimateTokens, shouldCachePrompt } from "../pipeline/llm";

const answer = (category: string, confidence = 0.9) =>
  JSON.stringify({ category, confidence, reasoning: "test" });

describe("the prompt", () => {
  it("stays over Haiku's prompt-cache floor, so the cached system block is really cached", () => {
    expect(estimateTokens(ROSTER_SURVEY_SYSTEM_PROMPT)).toBeGreaterThanOrEqual(MIN_CACHEABLE_TOKENS[HAIKU_MODEL]);
    expect(shouldCachePrompt(HAIKU_MODEL, ROSTER_SURVEY_SYSTEM_PROMPT)).toBe(true);
  });

  it("carries no em or en dash", () => {
    expect(ROSTER_SURVEY_SYSTEM_PROMPT).not.toMatch(/[—–]/);
  });

  it("says a yes for a stated stretch is still in", () => {
    expect(ROSTER_SURVEY_SYSTEM_PROMPT).toMatch(/still "in"/);
  });

  it("names no club and no match day: the check-in goes to every club", () => {
    expect(ROSTER_SURVEY_SYSTEM_PROMPT).not.toMatch(/Tuesday|Sutton/);
  });

  it("gives its examples in English and Turkish side by side", () => {
    expect(ROSTER_SURVEY_SYSTEM_PROMPT).toContain('"yes" | "evet"');
  });
});

describe("the user turn", () => {
  it("is the club, the player and the reply, in that order", () => {
    expect(buildRosterSurveyUserTurn("Evet bu ay varım", { clubName: "Sutton FC", playerName: "Ali" })).toBe(
      'Club: Sutton FC\nPlayer: Ali\nReply: "Evet bu ay varım"',
    );
  });

  it("drops a missing name rather than printing it empty", () => {
    expect(buildRosterSurveyUserTurn("yes", {})).toBe('Reply: "yes"');
  });
});

describe("classifyRosterReply", () => {
  it("sends the system prompt and the user turn, and reads the answer", async () => {
    const call = vi.fn(async () => answer("in"));
    const r = await classifyRosterReply("Evet bu ay varım", { clubName: "Sutton FC", playerName: "Ali" }, call);
    expect(r.category).toBe("in");
    expect(call).toHaveBeenCalledWith(
      ROSTER_SURVEY_SYSTEM_PROMPT,
      buildRosterSurveyUserTurn("Evet bu ay varım", { clubName: "Sutton FC", playerName: "Ali" }),
    );
  });

  it("turns a wobbly answer into unclear, so the player is asked again", async () => {
    const r = await classifyRosterReply("yes", {}, async () => answer("in", 0.6));
    expect(r.category).toBe("unclear");
  });

  it("turns an unknown category into unclear", async () => {
    const r = await classifyRosterReply("yes", {}, async () => answer("sometimes"));
    expect(r.category).toBe("unclear");
  });

  it("is unclear when the model call throws", async () => {
    const r = await classifyRosterReply("yes", {}, async () => {
      throw new Error("overloaded");
    });
    expect(r).toMatchObject({ category: "unclear", confidence: 0 });
  });

  it("is unclear when there is no model at all", async () => {
    const r = await classifyRosterReply("yes", {}, null);
    expect(r).toMatchObject({ category: "unclear", confidence: 0 });
  });
});
