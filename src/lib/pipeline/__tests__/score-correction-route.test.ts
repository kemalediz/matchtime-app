/**
 * A tagged score correction reaches the score route, whatever the router
 * model called it (2026-10-07, after the one approved live run).
 *
 * The live check (94 calls, $0.4118) passed 45 of 47. The score
 * extractor read all 47 correctly. Both failures were the ROUTER, whose
 * prompt this work does not touch, sending a tagged correction to the
 * attendance extractor:
 *
 *   X2  "@Match Time other way round"            -> unsure
 *   T6  "@Match Time yanlış, kırmızı 6 sarı 9"   -> other_att
 *
 * So the correction never happened, and on `other_att` two colour words
 * were handed to the extractor that looks for PEOPLE. The fix is the one
 * used for the one-word answer: a fixed-vocabulary rule decided in code
 * before any model runs (`isScoreCorrectionText`), and the router is
 * handed the ids.
 */
import { describe, it, expect } from "vitest";
import { routeBatch } from "../router";
import { gateBatch } from "../gate";
import { isScoreCorrectionText, mayBeScoreCorrection } from "../score-ask";
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

const EN: [string, string] = ["Red", "Yellow"];
const TR: [string, string] = ["Kırmızı", "Sarı"];

describe("is this text a score correction? (fixed vocabulary, no model)", () => {
  it.each([
    // The two the router lost.
    ["@Match Time other way round", EN],
    ["@Match Time yanlış, kırmızı 6 sarı 9", TR],
    // A swap phrase, alone.
    ["@Match Time wrong way round", EN],
    ["@Match Time it's the other way around", EN],
    ["@Match Time wrong way round, yellows won", EN],
    ["@Match Time tam tersi", TR],
    ["@Match Time tam tersi, sarılar kazandı", TR],
    ["tersi @Match Time", TR],
    // A correction opener with a scoreline.
    ["@Match Time no Yellow 9 - 6 Red", EN],
    ["@Match Time no it was 9-7", EN],
    ["@Match Time wrong, it finished 9-9", EN],
    ["@Match Time that's wrong, 6-9", EN],
    ["@Match Time not right, 6 9 to yellow", EN],
    ["@Match Time hayır 9-6 sarı", TR],
    ["@Match Time öyle değil, 6-9", TR],
    // A correction opener with one of the match's team names.
    ["@Match Time no, yellows won", EN],
    ["@Match Time wrong, reds lost", EN],
    ["@Match Time yanlış, sarılar kazandı", TR],
    ["@Match Time no, the Tigers won", ["Lions", "Tigers"]],
  ] as const)("yes: %s", (body, labels) => {
    expect(mayBeScoreCorrection(body)).toBe(true);
    expect(isScoreCorrectionText(body, labels as [string, string])).toBe(true);
  });

  it.each([
    // Attendance. A PLAYER'S name is not a team name, and there is no scoreline.
    ["@Match Time no, I'm out", EN],
    ["@Match Time hayır gelemiyorum", TR],
    ["@Match Time no Ayoub is in for Kieran", EN],
    ["@Match Time wrong, Najib is out", EN],
    ["@Match Time no", EN],
    ["@Match Time yanlış", TR],
    // Attendance that happens to mention a team: the sender is talking
    // about themselves, and that wins.
    ["@Match Time no I'm out, yellow can have my spot", EN],
    ["@Match Time no, put me on yellow", EN],
    ["@Match Time hayır ben yokum, sarılar eksik kalsın", TR],
    ["@Match Time no I'm in, 9 of us now and 2 more coming", EN],
    // A scoreline with NO correction opener: the model's route stands.
    ["@Match Time 9-6 to yellows", EN],
    ["@Match Time it was 9-6 to yellow", EN],
    ["@Match Time Yellow 9 - 6 Red", EN],
    ["@Match Time last week we lost 9-2", EN],
    // An opener that is not AT THE START is not an opener.
    ["@Match Time yellows won 9-6, no doubt about it", EN],
    ["@Match Time there's no way that was 9-6", EN],
    // A team of some other match, or a colour that is nobody's here.
    ["@Match Time no, Arsenal won", EN],
    ["@Match Time no, yellows won", ["Lions", "Tigers"]],
    // Not about a score at all.
    ["@Match Time what time is kickoff", EN],
    ["@Match Time generate the teams", EN],
    ["", EN],
  ] as const)("no: %s", (body, labels) => {
    expect(isScoreCorrectionText(body, labels as [string, string])).toBe(false);
  });

  it("the cheap first look needs no team names and never says no to a real one", () => {
    // It only decides whether the match is worth loading.
    expect(mayBeScoreCorrection("@Match Time no, I'm out")).toBe(true); // an opener: look closer
    expect(mayBeScoreCorrection("@Match Time 9-6 to yellows")).toBe(false);
    expect(mayBeScoreCorrection("in")).toBe(false);
  });
});

describe("the router sends a recognised correction to score, on every path", () => {
  const X2 = { id: "x2", authorName: "Kemal Ediz", body: "@Match Time other way round" };
  const T6 = { id: "t6", authorName: "Kemal Ediz", body: "@Match Time yanlış, kırmızı 6 sarı 9" };
  const OUT = { id: "out", authorName: "Kemal Ediz", body: "@Match Time no, I'm out" };
  const ids = new Set(["x2", "t6"]);

  it('X2: the model said "unsure", exactly as it did live', async () => {
    const res = await routeBatch(modelSaying("unsure"), [X2, OUT], { floor: false, scoreCorrectionIds: ids });
    expect(res.routes.find((r) => r.messageId === "x2")).toMatchObject({
      route: "score",
      source: "awaiting",
      overrodeRoute: "unsure",
    });
    expect(res.routes.find((r) => r.messageId === "out")?.route).toBe("unsure");
    expect(res.degradations.map((d) => d.detail).join(" ")).toMatch(/score correction.*unsure → score/);
  });

  it('T6: the model said "other_att", exactly as it did live', async () => {
    const res = await routeBatch(modelSaying("other_att"), [T6, OUT], { floor: false, scoreCorrectionIds: ids });
    expect(res.routes.find((r) => r.messageId === "t6")).toMatchObject({ route: "score", overrodeRoute: "other_att" });
    expect(res.routes.find((r) => r.messageId === "out")?.route).toBe("other_att");
  });

  it("when the router call fails, and at the daily cap", async () => {
    const failed = await routeBatch(brokenModel, [X2, OUT], { floor: false, scoreCorrectionIds: ids });
    expect(failed.routes.find((r) => r.messageId === "x2")?.route).toBe("score");
    expect(failed.routes.find((r) => r.messageId === "out")?.route).toBe("unsure");
    const capped = await routeBatch(brokenModel, [X2, OUT], { capped: true, scoreCorrectionIds: ids });
    expect(capped.routes.find((r) => r.messageId === "x2")?.route).toBe("score");
  });

  it("through the gate, so it is not skipped and not double routed", async () => {
    const g = await gateBatch(
      [X2, OUT].map((m) => ({ waMessageId: m.id, authorName: m.authorName, body: m.body }) as never),
      { model: modelSaying("none"), floor: false, scoreCorrectionIds: ids },
    );
    expect(g.routes.find((r) => r.messageId === "x2")).toMatchObject({ route: "score" });
    expect(g.skipped).toEqual(["out"]);
  });

  it("nothing changes when no id is handed over", async () => {
    const res = await routeBatch(modelSaying("unsure"), [X2, T6], { floor: false });
    expect(res.routes.map((r) => r.route)).toEqual(["unsure", "unsure"]);
  });
});
