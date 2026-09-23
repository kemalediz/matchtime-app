/**
 * A STATS CLARIFICATION IS AN OPEN QUESTION (2026-09-23).
 *
 * Kemal: "if it can't recognise a name or something, i think it should
 * honestly ask the person who posted that message in the group". The
 * question MatchTime asks is recorded as an `AnalyzedMessage` with the
 * `stats_clarification` intent, and it rides the SAME open-question
 * mechanism as a bench offer: the same one-hour TTL, the same router
 * override site, the same `awaiting` source label on the route. Two
 * differences, both narrowing: it rescues only the ASKER's reply, and
 * only a reply that reads as a name.
 */
import { describe, expect, it } from "vitest";
import {
  GROUP_QUESTION_TTL_MS,
  openStatsClarifications,
  type StatsClarificationRow,
} from "../awaiting-answer";
import { routeBatch } from "../router";
import { gateBatch } from "../gate";
import type { ModelResponse, PipelineModel } from "../llm";
import type { Route } from "../types";

const NOW = new Date("2026-09-23T19:00:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60 * 1000);

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

const row = (over: Partial<StatsClarificationRow>): StatsClarificationRow => ({
  id: "am-1",
  orgId: "org-1",
  intent: "stats_clarification",
  authorUserId: "u-kemal",
  authorName: "Kemal Ediz",
  body: "@Match Time Zork's chemistry",
  createdAt: ago(5),
  ...over,
});

describe("which clarifications are open", () => {
  it("one asked five minutes ago is open", () => {
    const open = openStatsClarifications([row({})], "org-1", NOW);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ askerUserId: "u-kemal", questionBody: "@Match Time Zork's chemistry" });
  });
  it("closes after the same hour a bench offer gets", () => {
    expect(GROUP_QUESTION_TTL_MS).toBe(60 * 60 * 1000);
    expect(openStatsClarifications([row({ createdAt: ago(61) })], "org-1", NOW)).toEqual([]);
  });
  it("closes once the asker answered it", () => {
    const rows = [row({}), row({ id: "am-2", intent: "stats_clarified", body: "Idris", createdAt: ago(2) })];
    expect(openStatsClarifications(rows, "org-1", NOW)).toEqual([]);
  });
  it("somebody else's answer does not close it", () => {
    const rows = [row({}), row({ id: "am-2", intent: "stats_clarified", authorUserId: "u-sait", createdAt: ago(2) })];
    expect(openStatsClarifications(rows, "org-1", NOW)).toHaveLength(1);
  });
  it("a newer question from the same asker replaces the older one", () => {
    const rows = [row({ createdAt: ago(20) }), row({ id: "am-3", body: "@Match Time Mo's stats", createdAt: ago(3) })];
    const open = openStatsClarifications(rows, "org-1", NOW);
    expect(open).toHaveLength(1);
    expect(open[0].questionBody).toBe("@Match Time Mo's stats");
  });
  it("another org's row is never this org's question", () => {
    expect(openStatsClarifications([row({ orgId: "org-2" })], "org-1", NOW)).toEqual([]);
  });
});

describe("the router, told a clarification is open", () => {
  const open = openStatsClarifications([row({})], "org-1", NOW);

  it("the asker's bare name is routed to the question owner, not dropped as banter", async () => {
    const res = await routeBatch(modelSaying("none"), [{ id: "m1", authorName: "Kemal Ediz", body: "Idris" }], {
      floor: false,
      clarifications: open,
    });
    expect(res.routes[0]).toMatchObject({ route: "question", source: "awaiting", overrodeRoute: "none" });
  });

  it("even when the router read the bare name as an attendance claim", async () => {
    const res = await routeBatch(modelSaying("other_att"), [{ id: "m1", authorName: "Kemal Ediz", body: "I mean Idris" }], {
      floor: false,
      clarifications: open,
    });
    expect(res.routes[0].route).toBe("question");
  });

  it("anybody else's message is left exactly as routed", async () => {
    const res = await routeBatch(modelSaying("none"), [{ id: "m1", authorName: "Sait Demir", body: "Idris" }], {
      floor: false,
      clarifications: open,
    });
    expect(res.routes[0]).toMatchObject({ route: "none", source: "model" });
  });

  it("the asker saying something that is not a name is left exactly as routed", async () => {
    const res = await routeBatch(modelSaying("self_att"), [{ id: "m1", authorName: "Kemal Ediz", body: "I'm in" }], {
      floor: false,
      clarifications: open,
    });
    expect(res.routes[0].route).toBe("self_att");
  });

  it("the gate passes it through and counts it as forced by an open question", async () => {
    const g = await gateBatch([{ waMessageId: "m1", authorName: "Kemal Ediz", body: "Idris" } as never], {
      model: modelSaying("none"),
      floor: false,
      clarifications: open,
    });
    expect(g.awaitingForced).toEqual(["m1"]);
    expect(g.skipped).toEqual([]);
  });
});
