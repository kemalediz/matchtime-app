/**
 * THE UNIFIED ANSWER'S CONTEXT, AS IT WOULD BE BUILT NOW, for one club and
 * place. FREE: a stub model answers both calls, so nothing is spent; reads
 * production through the read-only client (`ab-readonly-db.ts`), writes
 * nothing, sends nothing.
 *
 *   node --env-file=../../../.env ./node_modules/.bin/tsx scripts/ab-dump-context.ts <fnf|sutton|vets> <group|hq> "<question>" [kind]
 */
import "./ab-readonly-db.ts";
import { assertReadOnly } from "./ab-readonly-db.ts";
import { db } from "../src/lib/db.ts";
import type { ModelRequest, PipelineModel } from "../src/lib/pipeline/llm.ts";
import { runAnswerBatch } from "../src/lib/pipeline/answer-batch.ts";
import { enabledStepSevenRoutes } from "../src/lib/pipeline/route-flags.ts";
import { answerHqQuestion } from "../src/lib/admin-group-question.ts";
import { hqHelpGates } from "../src/lib/admin-group-help.ts";
import { loadSquadState } from "../src/lib/pipeline/load-state.ts";
import { asChatLines, loadWeekChat, WEEK_CHAT_MS } from "../src/lib/week-chat.ts";
import { monthNotStartedFor } from "../src/lib/month-not-started.ts";
import type { Route } from "../src/lib/pipeline/types.ts";

const CLUBS: Record<string, string> = { sutton: "cmnnwhdx30000zfr85q18lyy9", fnf: "cmv9nmp81000006l2iau88fig", vets: "cmvzlm8km000707iihou1ut9h" };
const [, , club = "fnf", place = "group", question = "@Match Time who is on the bench?", kind = "other"] = process.argv;
const orgId = CLUBS[club];
const NOW = new Date();

const model: PipelineModel = {
  name: "stub",
  async complete(req: ModelRequest) {
    if (req.label === "unified-answer") {
      console.log("=== SYSTEM chars", req.system.length, "\n=== USER\n" + req.user);
    }
    const text = req.label.startsWith("extractor:question")
      ? JSON.stringify({ kind, personRef: "", feature: "none", badge: "none" })
      : JSON.stringify({ answer: "ok", replies: [] });
    return { text, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
  },
};

async function main() {
  await assertReadOnly();
  const st = await loadSquadState(orgId, NOW);
  const asker = st.roster.find((m) => m.isAdmin) ?? st.roster[0];
  if (place === "hq") {
    const week = asChatLines(await loadWeekChat({ orgId, channel: "hq", since: new Date(NOW.getTime() - WEEK_CHAT_MS), includeMatchTime: true }));
    const org = await db.organisation.findUniqueOrThrow({ where: { id: orgId } });
    const r = await answerHqQuestion({
      orgId, lang: org.language, messageId: "dump", body: question, senderUserId: asker.userId, senderName: asker.name, now: NOW,
      history: week.slice(-8).map((l) => ({ author: l.author, body: l.body })), weekChat: async () => week,
      lastBotPost: null, gates: hqHelpGates(org as never, {}), poolEnv: {}, unified: true, deps: { model },
    });
    console.log("=== HQ reply:", r);
  } else {
    const week = asChatLines(await loadWeekChat({ orgId, channel: "group", since: new Date(NOW.getTime() - WEEK_CHAT_MS), includeMatchTime: true }));
    const res = await runAnswerBatch({
      orgId, now: NOW,
      messages: [{ waMessageId: "dump", body: question, authorName: asker.name, senderUserId: asker.userId, senderName: asker.name, tagged: true, addressed: true, route: "question" as Route, gated: false }],
      history: week.slice(-8).map((l) => ({ author: l.author, body: l.body })), weekChat: async () => week,
      expectedMatchId: st.matchId, enabled: enabledStepSevenRoutes({}), monthNotStarted: st.matchId ? await monthNotStartedFor(st.matchId) : false,
      poolEnv: async () => ({}), unified: true, deps: { model },
    });
    console.log("=== outcome:", res.outcomes.get("dump"), res.degradations);
  }
  await db.$disconnect();
}
main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
