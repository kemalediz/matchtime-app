/**
 * A question in HQ through the players' group's own answering code
 * (2026-10-16, FNF: "MatchTime who are the admins?" got the help menu).
 * The real `runAnswerBatch`, engine and composer; a STUBBED question
 * extractor (what the model would have said) and injected loaders. No
 * database, no real model.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../pipeline/llm";
import type { OrgFeatures } from "../org-features";
import { answerHqQuestion } from "../admin-group-question";
import { NOW, world } from "../pipeline/__tests__/helpers";

const FEATURES = { botEnabled: true, attendance: true, bench: true, teamBalancing: true, statsQa: true, language: "en" } as OrgFeatures;

function extractor(topic: string, calls: ModelRequest[] = []): PipelineModel {
  return {
    name: "stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      calls.push(req);
      return {
        text: JSON.stringify({ topic, personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none" }),
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 0,
      };
    },
  };
}

function ask(topic: string, over: { lastBotPost?: string | null; calls?: ModelRequest[] } = {}) {
  const st = { ...world({ confirmed: ["kemal", "sait"], bench: ["erdal"] }), lastBotPost: "a players' group post" };
  const organisersAnnounce = { ...st, features: { ...st.features, listAnnouncer: "organisers" as const } };
  return answerHqQuestion({
    orgId: "org-1",
    lang: "en",
    messageId: "wa-9",
    body: "MatchTime who are the admins?",
    senderUserId: "u-kemal",
    senderName: "Kemal Ediz",
    now: NOW,
    history: [],
    lastBotPost: over.lastBotPost ?? null,
    hqHelp: "*MatchTime in your admin group*",
    deps: {
      model: extractor(topic, over.calls),
      loadState: async () => organisersAnnounce,
      loadFeatures: async () => FEATURES,
      loadClub: async () => ({ collectorName: "Elvin Aliyev", feePerPlayer: 5, feeSplitTotal: false, teamsReady: "10:00" }),
    },
  });
}

describe("answerHqQuestion", () => {
  it("the incident: a club question names the admins", async () => {
    expect(await ask("club")).toEqual({
      outcome: "hq-answered",
      replyText: "👥 Admins: Kemal Ediz and Elvin Aliyev\n💷 Money collector: Elvin Aliyev\n💷 Match fee: £5 a player\n⚽ Teams ready: 10:00 on match day",
    });
  });

  it("who is on the bench: the bench itself, though the organisers announce the list", async () => {
    const r = await ask("bench");
    expect(r?.outcome).toBe("hq-answered");
    expect(r?.replyText).toContain("Erdal Ozkan");
  });

  it("how many are in: the count", async () => {
    expect((await ask("count"))?.replyText).toMatch(/2/);
  });

  it("what can you do: the HQ menu", async () => {
    expect(await ask("how_it_works")).toEqual({ outcome: "hq-help", replyText: "*MatchTime in your admin group*" });
  });

  it("a topic nothing answers: null, for the caller's one line", async () => {
    expect(await ask("other")).toBeNull();
  });

  it("the extractor is shown MatchTime's post in HQ, never the players' group's", async () => {
    const calls: ModelRequest[] = [];
    await ask("count", { calls, lastBotPost: "📝 *Proposed teams*" });
    expect(calls[0].user).toContain("MATCHTIME'S LAST POST: 📝 *Proposed teams*");
    const none: ModelRequest[] = [];
    await ask("count", { calls: none });
    expect(none[0].user).not.toContain("a players' group post");
  });
});
