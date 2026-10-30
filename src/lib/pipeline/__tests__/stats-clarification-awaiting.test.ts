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
import { clarificationLine, routeBatch } from "../router";
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

describe("the router, told a clarification is open (2026-10-30: shown, not forced)", () => {
  const open = openStatsClarifications([row({})], "org-1", NOW);
  const spy = (route: Route) => {
    const users: string[] = [];
    const m = modelSaying(route);
    return { users, model: { ...m, complete: (req: Parameters<PipelineModel["complete"]>[0]) => (users.push(req.user), m.complete(req)) } as PipelineModel };
  };

  it("the asker's message carries the MATCHTIME ASKED line with their original question", async () => {
    const { users, model } = spy("question");
    const res = await routeBatch(model, [{ id: "m1", authorName: "Kemal Ediz", body: "Idris" }], { clarifications: open });
    expect(users[0]).toContain(`${clarificationLine(open[0].questionBody)}\n[m1] Kemal Ediz: Idris`);
    expect(res.routes[0]).toMatchObject({ route: "question", source: "model" });
  });

  it("the model's route stands: a reply it reads as attendance stays attendance", async () => {
    const res = await routeBatch(modelSaying("self_att"), [{ id: "m1", authorName: "Kemal Ediz", body: "I'm in" }], { clarifications: open });
    expect(res.routes[0]).toMatchObject({ route: "self_att", source: "model" });
  });

  it("anybody else's message gets no line", async () => {
    const { users, model } = spy("none");
    await routeBatch(model, [{ id: "m1", authorName: "Sait Demir", body: "Idris" }], { clarifications: open });
    expect(users[0]).not.toContain("MATCHTIME ASKED");
  });

  it("the line carries no dashes", () => {
    expect(clarificationLine("x")).not.toMatch(/[\u2013\u2014]/);
  });
});
