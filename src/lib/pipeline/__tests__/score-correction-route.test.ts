/**
 * SCORE ANSWERS AND CORRECTIONS ARE ROUTED BY THE MODEL, SHOWN THE FACTS
 * (2026-10-30, "no string parsing"; replaces score-ask-router.test.ts and
 * the word-list half of this file).
 *
 * Until today two word tests picked the messages that answered "which
 * team won?" (`scoreAnswerSide`) or corrected a recorded result
 * (`isScoreCorrectionText`) and forced them to `score` before the router
 * ran. Now code decides only WHO may answer or correct (facts:
 * `scoreRouteOverrides`), the router is shown that as a line above the
 * message, and its route stands. These tests pin that: the line is in the
 * turn for exactly the ids named, and nothing overrides the model.
 */
import { describe, it, expect } from "vitest";
import { routeBatch, scoreContextLine } from "../router";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import type { Route } from "../types";

function modelSaying(route: Route): PipelineModel & { users: string[] } {
  const users: string[] = [];
  return {
    name: "fake",
    users,
    async complete(req: ModelRequest): Promise<ModelResponse> {
      users.push(req.user);
      const ids = [...req.user.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]);
      return {
        text: JSON.stringify({ routes: ids.map((id) => ({ id, route, to_bot: true })) }),
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0001,
        ms: 5,
      };
    },
  };
}

const X2 = { id: "x2", authorName: "Kemal Ediz", body: "@Match Time other way round" };
const OUT = { id: "out", authorName: "Kemal Ediz", body: "@Match Time no, I'm out" };
const YELLOW = { id: "y", authorName: "Elvin", body: "Yellow" };

describe("the router is shown who may correct or answer, and routes on the words", () => {
  it("a correction candidate carries the RECORDED line; the model's route stands", async () => {
    const m = modelSaying("unsure");
    const res = await routeBatch(m, [X2, OUT], { scoreCorrectionIds: new Set(["x2"]) });
    expect(m.users[0]).toContain(`${scoreContextLine("recorded")}\n[m1] Kemal Ediz: @Match Time other way round`);
    expect(m.users[0].split(scoreContextLine("recorded")).length - 1).toBe(1);
    expect(res.routes.map((r) => [r.route, r.source])).toEqual([
      ["unsure", "model"],
      ["unsure", "model"],
    ]);
  });

  it("an answer candidate carries the WAITING line, and wins over the correction line", async () => {
    const m = modelSaying("score");
    const res = await routeBatch(m, [YELLOW], { scoreAnswerIds: new Set(["y"]), scoreCorrectionIds: new Set(["y"]) });
    expect(m.users[0]).toContain(`${scoreContextLine("which_team")}\n[m1] Elvin: Yellow`);
    expect(m.users[0]).not.toContain(scoreContextLine("recorded"));
    expect(res.routes[0]).toMatchObject({ route: "score", source: "model" });
  });

  it("a failed router call does not force anything to score: the whole batch goes to the extractor", async () => {
    const broken: PipelineModel = { name: "broken", async complete() { throw new Error("529 Overloaded"); } };
    const res = await routeBatch(broken, [YELLOW], { scoreAnswerIds: new Set(["y"]) });
    expect(res.routes[0]).toMatchObject({ route: "unsure", source: "fallback" });
  });

  it("no ids, no line", async () => {
    const m = modelSaying("none");
    await routeBatch(m, [YELLOW]);
    expect(m.users[0]).not.toMatch(/MATCHTIME (IS WAITING|HAS RECORDED)/);
  });

  it("the lines carry no dashes", () => {
    expect(scoreContextLine("which_team") + scoreContextLine("recorded")).not.toMatch(/[–—]/);
  });
});
