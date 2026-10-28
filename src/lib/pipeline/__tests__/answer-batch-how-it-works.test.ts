/**
 * `runAnswerBatch` on a HOW-IT-WORKS question (2026-10-16, FNF): "Bench?
 * We do bench now?", a WhatsApp reply to MatchTime's own "the bench is
 * open" post. The answer is the help explainer for this club's settings
 * (the same copy "@Match Time help availability" sends), and the extractor
 * is shown the post the message replies to.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import { runAnswerBatch, type AnswerBatchMessage } from "../answer-batch";
import type { OrgFeatures } from "../../org-features";
import type { Route } from "../types";
import { NOW, fullName, world } from "./helpers";

const FEATURES = {
  botEnabled: true,
  attendance: true,
  bench: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  reminders: true,
  statsQa: true,
  paymentTracking: false,
  paymentCollection: false,
  squadFromList: false,
  benchPickMode: "organiser",
  language: "en",
} as OrgFeatures;

const BENCH_POST = "Football 9-a-side is full at 18 of 18, but the bench is open. Say IN to go on the bench.";
const BODY = "Bench? We do bench now?";

function stubModel(calls: ModelRequest[], feature = "availability", badge = "none"): PipelineModel {
  return {
    name: "stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      calls.push(req);
      return {
        text: JSON.stringify({
          topic: "how_it_works",
          personRef: "",
          statedCount: -1,
          table: "none",
          listSize: -1,
          listEnd: "top",
          period: "none",
          periodCount: -1,
          periodUnit: "none",
          feature,
          badge,
        }),
        stopReason: "end_turn",
        usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.002,
        ms: 10,
      };
    },
  };
}

const message = (over: Partial<AnswerBatchMessage> = {}): AnswerBatchMessage => ({
  waMessageId: "wa-1",
  body: BODY,
  authorName: fullName("sait"),
  senderUserId: "u-sait",
  senderName: fullName("sait"),
  tagged: true,
  route: "question" as Route,
  gated: false,
  reply: { author: null, at: null, text: BENCH_POST, topic: null, matchId: null, match: null, found: false },
  ...over,
});

async function run(m: AnswerBatchMessage, calls: ModelRequest[], feature?: string, badge?: string) {
  const st = world({ confirmed: ["kemal", "sait"] });
  const asked: Array<{ topic: string | null; picks: string | undefined; admin?: boolean; badge?: string | null }> = [];
  const res = await runAnswerBatch({
    orgId: "org-1",
    now: NOW,
    messages: [m],
    history: [{ author: "MatchTime", body: "an older post" }],
    expectedMatchId: st.matchId,
    enabled: new Set<Route>(["question"]),
    deps: {
      model: stubModel(calls, feature, badge),
      loadState: async () => st,
      loadFeatures: async () => FEATURES,
      helpReply: async (req, features, asker) => {
        asked.push({ topic: req.topic, picks: features.benchPickMode, ...(asker.admin ? { admin: true } : {}), ...(req.badge ? { badge: req.badge } : {}) });
        return `HELP ${req.topic ?? "menu"}`;
      },
    },
  });
  return { res, asked };
}

describe("a how-it-works question through the whole batch", () => {
  it("answers with the help explainer for this club's settings, labelled help", async () => {
    const calls: ModelRequest[] = [];
    const { res, asked } = await run(message(), calls);
    expect(asked).toEqual([{ topic: "availability", picks: "organiser" }]);
    const o = res.outcomes.get("wa-1");
    expect(o?.reply).toBe("HELP availability");
    // `help` keeps the organisers-mode net and the squad-composition pass
    // off the explainer, as they are kept off "@Match Time help".
    expect(o?.intent).toBe("help");
    expect(res.writes).toEqual([]);
  });

  it("the extractor is shown the MatchTime post the message replies to, beside MatchTime's last post (slice S4)", async () => {
    const calls: ModelRequest[] = [];
    await run(message(), calls);
    expect(calls[0].user).toContain(`THEY ARE REPLYING TO a MatchTime message (when it was sent is not known):\n${JSON.stringify(BENCH_POST)}`);
    expect(calls[0].user).toContain("MATCHTIME'S LAST POST: an older post");
    expect(calls[0].user).toContain("who tagged the bot");
  });

  it("a reply to a member's question is shown as theirs", async () => {
    const calls: ModelRequest[] = [];
    await run(message({ body: "@Match Time same question", reply: { author: { name: "Kemal", userId: "u-kemal" }, at: null, text: "how does the bench work?", topic: null, matchId: null, match: null, found: true } }), calls);
    expect(calls[0].user).toContain(`THEY ARE REPLYING TO Kemal's message (when it was sent is not known):\n"how does the bench work?"`);
  });

  it("not a reply: the extractor sees MatchTime's last post, as before", async () => {
    const calls: ModelRequest[] = [];
    await run(message({ reply: undefined }), calls);
    expect(calls[0].user).toContain("MATCHTIME'S LAST POST: an older post");
    expect(calls[0].user).not.toContain("THEY ARE REPLYING TO");
    expect(calls[0].user).toContain("NOW: ");
  });

  it("the player pool, asked in any words: the pool's help (2026-10-28)", async () => {
    const calls: ModelRequest[] = [];
    const { res, asked } = await run(message({ body: "@Match Time how do I turn on the player pool?", reply: undefined }), calls, "pool");
    expect(asked).toEqual([{ topic: "pool", picks: "organiser" }]);
    expect(res.outcomes.get("wa-1")?.reply).toBe("HELP pool");
  });

  it("an organiser asking in the players' group is answered as one (how to switch it)", async () => {
    const calls: ModelRequest[] = [];
    const { asked } = await run(message({ senderUserId: "u-kemal", reply: undefined }), calls, "pool");
    // `world()` makes kemal the admin.
    expect(asked).toEqual([{ topic: "pool", picks: "organiser", admin: true }]);
  });

  it("a badge question carries the badge", async () => {
    const calls: ModelRequest[] = [];
    const { asked } = await run(message({ body: "@Match Time help badges Mr Reliable", reply: undefined }), calls, "badges", "reliable");
    expect(asked).toEqual([{ topic: "badges", picks: "organiser", badge: "reliable" }]);
  });

  it("no part named: the help menu", async () => {
    const calls: ModelRequest[] = [];
    const { res, asked } = await run(message(), calls, "none");
    expect(asked).toEqual([{ topic: null, picks: "organiser" }]);
    expect(res.outcomes.get("wa-1")?.reply).toBe("HELP menu");
  });
});
