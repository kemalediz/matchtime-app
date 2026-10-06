/**
 * The answers to MatchTime's open "which team won?" reach the score
 * route, whatever the router did (second review of PR #214, M2).
 *
 * WHICH messages are answers is decided by the caller, before any model
 * is asked, from who sent each message, whether it tags the bot and how
 * long ago the question was asked (`isScoreAnswer`, tested in
 * `score-ask.test.ts`). The router is handed the ids. So these tests are
 * about one thing: an id on that list ends up on `score` on EVERY path a
 * batch can take, including the ones where the model said nothing.
 */
import { describe, it, expect } from "vitest";
import { routeBatch } from "../router";
import { gateBatch } from "../gate";
import type { ModelResponse, PipelineModel } from "../llm";
import type { Route } from "../types";

function modelSaying(route: Route): PipelineModel {
  return {
    name: "fake",
    async complete(req): Promise<ModelResponse> {
      const ids = [...req.user.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]);
      return {
        text: JSON.stringify({ routes: ids.map((id) => ({ id, route })) }),
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0001,
        ms: 5,
      };
    },
  };
}
const brokenModel: PipelineModel = {
  name: "broken",
  async complete() {
    throw new Error("529 Overloaded");
  },
};
const neverCalled: PipelineModel = {
  name: "never",
  async complete() {
    throw new Error("the model must not be called");
  },
};

const batch = [
  { id: "m1", authorName: "Elvin", body: "Yellow" },
  { id: "m2", authorName: "Sait", body: "Yellow" },
];
const ANSWERS = new Set(["m1"]);
const routeOf = (res: { routes: Array<{ messageId: string; route: string }> }, id: string) =>
  res.routes.find((r) => r.messageId === id)?.route;

describe("an answer to 'which team won?' is routed to score", () => {
  it("from whatever the model called it, and ONLY the ids the caller named", async () => {
    for (const said of ["none", "balancer", "self_att"] as Route[]) {
      const res = await routeBatch(modelSaying(said), batch, { floor: false, scoreAnswerIds: ANSWERS });
      expect(routeOf(res, "m1")).toBe("score");
      // The same word from somebody whose message is not an answer is
      // left exactly where the model put it.
      expect(routeOf(res, "m2")).toBe(said);
    }
  });

  it("records what it overrode", async () => {
    const res = await routeBatch(modelSaying("none"), batch, { floor: false, scoreAnswerIds: ANSWERS });
    expect(res.routes.find((r) => r.messageId === "m1")).toMatchObject({
      route: "score",
      source: "awaiting",
      overrodeRoute: "none",
    });
    expect(res.degradations.map((d) => d.detail).join(" ")).toMatch(/none → score/);
  });

  it("when the router call FAILS, the answer is not lost with it", async () => {
    const res = await routeBatch(brokenModel, batch, { floor: false, scoreAnswerIds: ANSWERS });
    expect(routeOf(res, "m1")).toBe("score");
    expect(routeOf(res, "m2")).toBe("unsure"); // the ordinary fallback
  });

  it("at the daily AI cap, with no model call at all", async () => {
    const res = await routeBatch(neverCalled, batch, { capped: true, scoreAnswerIds: ANSWERS });
    expect(routeOf(res, "m1")).toBe("score");
    expect(routeOf(res, "m2")).toBe("none");
  });

  it("does nothing at all when no message is an answer", async () => {
    for (const opts of [{}, { scoreAnswerIds: new Set<string>() }]) {
      const res = await routeBatch(modelSaying("none"), batch, { floor: false, ...opts });
      expect(res.routes.map((r) => r.route)).toEqual(["none", "none"]);
    }
  });

  it("the gate passes the ids through, so the answer is not skipped as banter", async () => {
    const g = await gateBatch(
      batch.map((m) => ({ waMessageId: m.id, authorName: m.authorName, body: m.body }) as never),
      { model: modelSaying("none"), floor: false, scoreAnswerIds: ANSWERS },
    );
    expect(g.skipped).toEqual(["m2"]);
    expect(g.routes.find((r) => r.messageId === "m1")).toMatchObject({ route: "score" });
  });

  it("...and at the cap", async () => {
    const g = await gateBatch(
      batch.map((m) => ({ waMessageId: m.id, authorName: m.authorName, body: m.body }) as never),
      { model: neverCalled, capped: true, scoreAnswerIds: ANSWERS },
    );
    expect(g.routes.find((r) => r.messageId === "m1")).toMatchObject({ route: "score" });
    expect(g.skipped).not.toContain("m1");
  });
});
