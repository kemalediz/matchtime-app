/**
 * THE RATING ADJUSTER'S CONTRACT (2026-10-20 rewrite).
 *
 * The prompt is judged by the paid check (`scripts/live-check-rating-
 * adjuster.ts`); these pin what code owns: the request it sends (through
 * the pipeline, structured output, the shipped model), the context it
 * gives (the match day and time, each chat line's day and time, the
 * rating scale), and what it does with the answer (only players with a
 * reason come back from the model; code fills everyone else with zero,
 * clamps, drops unknown ids and low confidence, and fails open).
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../pipeline/llm";
import { HAIKU_CALL } from "../pipeline/llm";
import { HAIKU_SHORT_ANSWER_MAX_TOKENS } from "../models";
import {
  adjustRatings,
  NO_SIGNAL_REASON,
  RATING_ADJUSTER_CALL,
  RATING_ADJUSTER_SYSTEM,
  type AdjusterInput,
} from "../rating-adjuster";

const KICKOFF = new Date("2026-10-17T09:00:00.000Z"); // Sat 10:00 London (BST)
const INPUT: AdjusterInput = {
  sportName: "Football",
  matchDate: KICKOFF,
  players: [
    { id: "p-pete", name: "Pete Hall", baseRating: 6.9 },
    { id: "p-mark", name: "Mark Long", baseRating: 6.4 },
    { id: "p-rob", name: "Rob Lane", baseRating: 6.2 },
  ],
  messages: [
    { authorName: "Mark Long", body: "not played since July", timestamp: new Date("2026-10-14T08:00:00.000Z") },
    { authorName: "Pete Hall", body: "on a stag do tonight", timestamp: new Date("2026-10-16T21:00:00.000Z") },
  ],
};

function stub(text: string | Error) {
  const reqs: ModelRequest[] = [];
  const model: PipelineModel = {
    name: "stub",
    async complete(req): Promise<ModelResponse> {
      reqs.push(req);
      if (text instanceof Error) throw text;
      return {
        text,
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 1,
      };
    },
  };
  return { model, reqs };
}

const answer = (adjustments: unknown[]) => JSON.stringify({ adjustments });

describe("the request", () => {
  it("goes through the pipeline model, with structured output, on the shipped call", async () => {
    const { model, reqs } = stub(answer([]));
    await adjustRatings(INPUT, { model });
    expect(reqs).toHaveLength(1);
    const r = reqs[0];
    expect(r.label).toBe("rating-adjuster");
    expect(r.model).toBe(RATING_ADJUSTER_CALL.model);
    expect(r.thinking).toEqual(RATING_ADJUSTER_CALL.thinking);
    expect(r.system).toBe(RATING_ADJUSTER_SYSTEM);
    expect((r.schema as { properties: Record<string, unknown> }).properties).toHaveProperty("adjustments");
  });

  it("has room for Haiku's thinking, and does not grow with the roster", async () => {
    const { model, reqs } = stub(answer([]));
    await adjustRatings(INPUT, { model });
    const many = { ...INPUT, players: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, name: `P ${i}`, baseRating: 6 })) };
    await adjustRatings(many, { model });
    expect(reqs[0].maxTokens).toBe(reqs[1].maxTokens);
    if (RATING_ADJUSTER_CALL.model === HAIKU_CALL.model) {
      expect(reqs[0].maxTokens).toBeGreaterThanOrEqual(HAIKU_SHORT_ANSWER_MAX_TOKENS);
    }
  });

  it("states the match's own day and time, and each chat line's, in London time", async () => {
    const { model, reqs } = stub(answer([]));
    await adjustRatings(INPUT, { model });
    const user = reqs[0].user;
    expect(user).toContain("Saturday 17 October 2026, 10:00");
    expect(user).toContain("[Fri 16 Oct 22:00] Pete Hall: on a stag do tonight");
    expect(user).toContain("Pete Hall (id p-pete): rating 6.9");
  });

  it("the prompt states the rating scale, never assumes the match is tonight, and names no real player", () => {
    expect(RATING_ADJUSTER_SYSTEM).toMatch(/1 to 10/);
    expect(RATING_ADJUSTER_SYSTEM).not.toMatch(/TONIGHT|tonight's match|for tonight/);
    expect(RATING_ADJUSTER_SYSTEM).not.toMatch(/Wasim|Sait/);
    expect(RATING_ADJUSTER_SYSTEM).not.toMatch(/EVERY player/i);
    expect(RATING_ADJUSTER_SYSTEM).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("the answer", () => {
  it("only the players the model names change; everyone else is zero with the no-signal reason", async () => {
    const { model } = stub(answer([{ playerId: "p-pete", delta: -1, reason: "stag do the night before", confidence: 0.8 }]));
    const out = await adjustRatings(INPUT, { model });
    expect(out.get("p-pete")).toEqual({ playerId: "p-pete", delta: -1, reason: "stag do the night before", confidence: 0.8 });
    expect(out.get("p-mark")).toEqual({ playerId: "p-mark", delta: 0, reason: NO_SIGNAL_REASON, confidence: 0 });
    expect(out.size).toBe(3);
  });

  it("clamps to plus or minus 2, zeroes a guess, drops an id it was not given, and strips dashes", async () => {
    const { model } = stub(
      answer([
        { playerId: "p-pete", delta: -5, reason: "ill \u2014 still coming", confidence: 0.9 },
        { playerId: "p-mark", delta: -1, reason: "rusty", confidence: 0.2 },
        { playerId: "p-zack", delta: -2, reason: "broken wrist", confidence: 0.9 },
      ]),
    );
    const out = await adjustRatings(INPUT, { model });
    expect(out.get("p-pete")?.delta).toBe(-2);
    expect(out.get("p-pete")?.reason).not.toMatch(/[\u2013\u2014]/);
    expect(out.get("p-mark")?.delta).toBe(0);
    expect(out.has("p-zack")).toBe(false);
  });

  it("fails open: a thrown call or an unreadable body changes nobody", async () => {
    expect((await adjustRatings(INPUT, { model: stub(new Error("overloaded")).model })).size).toBe(0);
    expect((await adjustRatings(INPUT, { model: stub("").model })).size).toBe(0);
    expect((await adjustRatings(INPUT, { model: stub("not json").model })).size).toBe(0);
  });

  it("no chat in the week: no call, everyone zero", async () => {
    const { model, reqs } = stub(answer([]));
    const out = await adjustRatings({ ...INPUT, messages: [] }, { model });
    expect(reqs).toHaveLength(0);
    expect([...out.values()].every((a) => a.delta === 0)).toBe(true);
  });
});
