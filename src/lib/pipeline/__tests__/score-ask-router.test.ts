/**
 * While MatchTime is waiting to hear which team won, a bare team name
 * reaches the score route (review of PR #214, item 4).
 *
 * To a router that does not know a question is open, "Yellow" is
 * chatter. Without this the bot asked a question nobody could answer in
 * one word, and the result was never recorded.
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

const OPEN = { labels: ["Red", "Yellow"] as const };
const one = (body: string) => [{ id: "m1", authorName: "Elvin", body }];

describe("the answer to 'which team won?' is routed to score", () => {
  it.each(["Yellow", "yellows won", "to the reds", "@Match Time red"])("%s", async (body) => {
    const res = await routeBatch(modelSaying("none"), one(body), { floor: false, scoreAsk: OPEN });
    expect(res.routes[0]).toMatchObject({ route: "score", source: "awaiting", overrodeRoute: "none" });
  });

  it("from whatever the model called it, not only from none", async () => {
    const res = await routeBatch(modelSaying("balancer"), one("Yellow"), { floor: false, scoreAsk: OPEN });
    expect(res.routes[0]).toMatchObject({ route: "score", overrodeRoute: "balancer" });
  });

  it("uses the names of the match the question is about", async () => {
    const lions = { labels: ["Lions", "Tigers"] as const };
    const hit = await routeBatch(modelSaying("none"), one("Tigers"), { floor: false, scoreAsk: lions });
    expect(hit.routes[0].route).toBe("score");
    const miss = await routeBatch(modelSaying("none"), one("Yellow"), { floor: false, scoreAsk: lions });
    expect(miss.routes[0].route).toBe("none");
  });

  it("leaves everything else exactly where the model put it", async () => {
    for (const body of ["good game lads", "put me on Yellow for next week", "yellow were robbed tonight honestly", "Reda"]) {
      const res = await routeBatch(modelSaying("none"), one(body), { floor: false, scoreAsk: OPEN });
      expect(res.routes[0].route, body).toBe("none");
    }
  });

  it("does nothing at all when no question is open", async () => {
    const res = await routeBatch(modelSaying("none"), one("Yellow"), { floor: false });
    expect(res.routes[0].route).toBe("none");
    const explicit = await routeBatch(modelSaying("none"), one("Yellow"), { floor: false, scoreAsk: null });
    expect(explicit.routes[0].route).toBe("none");
  });

  it("the gate passes the open question through, so the answer is not skipped as banter", async () => {
    const g = await gateBatch([{ waMessageId: "m1", authorName: "Elvin", body: "Yellow" } as never], {
      model: modelSaying("none"),
      floor: false,
      scoreAsk: OPEN,
    });
    expect(g.skipped).toEqual([]);
    expect(g.routes[0]).toMatchObject({ route: "score" });
  });
});
