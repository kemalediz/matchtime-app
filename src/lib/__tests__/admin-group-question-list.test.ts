/**
 * "Can you show me the list" in HQ (FNF, 2026-10-20 10:23 UTC, Raihan).
 *
 * Squad 17 of 18, bench empty. "Anyone on the bench? Can you show me the
 * list please" (a reply to "Done: Naim out. 17 of 18.") and then "What's
 * the list" were both answered "Nobody's on the bench right now.", and
 * the list was never shown.
 *
 * Traced and reproduced on the dev key (6 of 6 on 1af87e60, which was
 * live, and 6 of 6 on 5e54fc2c, #341): the router sent both to `question`,
 * and the question extractor returned topic `bench` for both, with the
 * exact token counts production logged (in=118/99, out=76). The engine and
 * composer then did what `bench` asks. Without the earlier message in the
 * recent chat, "What's the list" alone came back `squad` (2 of 2), so the
 * second miss was the first one's bench question read into "the list".
 *
 * The real `answerHqQuestion` -> `runAnswerBatch` -> engine -> composer,
 * with the question extractor stubbed by the RAW output captured live.
 * No database, no real model.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../pipeline/llm";
import type { OrgFeatures } from "../org-features";
import { answerHqQuestion } from "../admin-group-question";
import { runAnswerBatch } from "../pipeline/answer-batch";
import { enabledStepSevenRoutes } from "../pipeline/route-flags";
import { NOW, SUTTON, world } from "../pipeline/__tests__/helpers";

/** The question extractor's raw output on both messages, captured live. */
const RAW_BENCH =
  '{"topic":"bench","personRef":"","statedCount":-1,"table":"none","listSize":-1,"listEnd":"top","period":"none","periodCount":-1,"periodUnit":"none","feature":"none"}';
const RAW_SQUAD = RAW_BENCH.replace('"bench"', '"squad"');

function stub(text: string, calls: ModelRequest[] = []): PipelineModel {
  return {
    name: "stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      calls.push(req);
      return { text, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
    },
  };
}

// FNF: 18 a side total, 17 in, nobody on the bench; the organisers announce the list.
const IN17 = SUTTON.slice(0, 17);
function fnf(over: { bench?: string[]; lang?: "en" | "tr"; teams?: Record<string, "RED" | "YELLOW"> } = {}) {
  const st = world({ confirmed: IN17, bench: over.bench ?? [], maxPlayers: 18, teams: over.teams });
  return { ...st, features: { ...st.features, listAnnouncer: "organisers" as const, language: over.lang ?? "en" } };
}

function hq(raw: string, body: string, over: Parameters<typeof fnf>[0] = {}) {
  const lang = over.lang ?? "en";
  return answerHqQuestion({
    orgId: "org-fnf",
    lang,
    messageId: "wa-raihan",
    body,
    senderUserId: "u-kemal",
    senderName: "Raihan",
    now: NOW,
    history: [{ author: null, body: "Naim out" }],
    lastBotPost: null,
    hqHelp: "*MatchTime in your admin group*",
    deps: {
      model: stub(raw),
      loadState: async () => fnf(over),
      loadFeatures: async () => ({ botEnabled: true, attendance: true, bench: true, teamBalancing: true, statsQa: true, language: lang }) as OrgFeatures,
    },
  });
}

describe("HQ: show me the list (FNF 2026-10-20)", () => {
  it("as it ran: the extractor said bench, so only the bench line came back", async () => {
    const r = await hq(RAW_BENCH, "Anyone on the bench? Can you show me the list please");
    expect(r).toEqual({ outcome: "hq-answered", replyText: "Nobody's on the bench right now." });
  });

  it("the list in HQ shows the squad AND says the bench is empty", async () => {
    const r = await hq(RAW_SQUAD, "Anyone on the bench? Can you show me the list please");
    expect(r?.outcome).toBe("hq-answered");
    expect(r?.replyText).toContain("*17/18*");
    expect(r?.replyText).toContain("1. Kemal");
    expect(r?.replyText).toContain("17. ");
    expect(r?.replyText).toContain("Nobody's on the bench right now.");
  });

  it("Turkish: the list and the empty bench line in Turkish", async () => {
    const r = await hq(RAW_SQUAD, "Yedekte kimse var mı? Listeyi atar mısın", { lang: "tr" });
    expect(r?.replyText).toContain("*17/18*");
    expect(r?.replyText).toContain("Şu an yedekte kimse yok.");
    expect(r?.replyText).not.toContain("Nobody's on the bench");
  });

  it("a bench with people on it is listed once, under the squad", async () => {
    const r = await hq(RAW_SQUAD, "What's the list", { bench: [SUTTON[17]] });
    const text = r?.replyText ?? "";
    expect(text).toContain("*Bench (1):*");
    expect(text).not.toContain("Nobody's on the bench");
    expect(text.match(/On the bench:/g)).toBeNull();
  });

  it("with the teams made, the line-ups and then the bench", async () => {
    const teams = Object.fromEntries(IN17.map((k, i) => [k, i % 2 ? "YELLOW" : "RED"])) as Record<string, "RED" | "YELLOW">;
    const r = await hq(RAW_SQUAD, "What's the list", { teams });
    expect(r?.replyText).toContain("Red");
    expect(r?.replyText).toContain("Nobody's on the bench right now.");
  });

  it("the players' group squad answer is unchanged: no empty bench line", async () => {
    const st = world({ confirmed: IN17, maxPlayers: 18 });
    const res = await runAnswerBatch({
      orgId: "org-fnf",
      now: NOW,
      messages: [
        { waMessageId: "p1", body: "@Match Time who's in?", authorName: "Kemal Ediz", senderUserId: "u-kemal", senderName: "Kemal Ediz", tagged: true, route: "question", gated: false },
      ],
      history: [],
      expectedMatchId: st.matchId,
      enabled: enabledStepSevenRoutes({}),
      deps: { model: stub(RAW_SQUAD), loadState: async () => st, loadFeatures: async () => ({ botEnabled: true, attendance: true, bench: true, statsQa: true, language: "en" }) as OrgFeatures },
    });
    const reply = res.outcomes.get("p1")?.reply ?? "";
    expect(reply).toContain("*17/18*");
    expect(reply).not.toContain("Nobody's on the bench");
  });
});
