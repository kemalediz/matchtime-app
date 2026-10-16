/**
 * A QUESTION IN A CLUB'S ADMIN GROUP (HQ), ANSWERED BY THE SHARED CODE
 * (2026-10-16).
 *
 * The incident (FNF, 14:29 London): Hamzah wrote "MatchTime who are the
 * admins?". The router returned `help` (Vercel: "routed help by model"),
 * and `help` sent the generic HQ menu; a `question` got one canned line.
 * Neither asked what the question was.
 *
 * Now both go through the players' group's own answering path: the
 * question extractor, the engine and the composer (`runAnswerBatch`), as
 * ONE tagged `question` message, with the organisers as the audience
 * (`AnswerAudience`): the club's setup (admins, money collector, fee,
 * teams time) is answered here, and the squad and bench are shown even
 * when the organisers announce the list to the players. A how-it-works
 * question gets the HQ menu, which is what MatchTime does in this group.
 *
 * Returns null when the shared code answers nothing (a topic it does not
 * answer, a failed call, the asker's own stats link, which is a DM): the
 * caller says its one line. Logs carry ids and counts only.
 */
import { runAnswerBatch, type AnswerBatchDeps } from "./pipeline/answer-batch";
import { enabledStepSevenRoutes } from "./pipeline/route-flags";
import type { SquadState } from "./pipeline/types";

export interface HqQuestionInput {
  orgId: string;
  lang: string | null;
  messageId: string;
  /** The message as the router read it (mentions named). */
  body: string;
  /** Null for someone in HQ MatchTime does not know (2026-10-16). */
  senderUserId: string | null;
  senderName: string | null;
  now: Date;
  /** The recent HQ chat, oldest first; MatchTime's own lines as "MatchTime". */
  history: Array<{ author: string | null; body: string }>;
  /** MatchTime's post in HQ the question is about (the one it replies to,
   *  else its last line there), never the players' group's. */
  lastBotPost: string | null;
  /** The HQ menu, the answer to a how-it-works question here. */
  hqHelp: string;
  deps?: Pick<AnswerBatchDeps, "model" | "loadFeatures" | "loadClub"> & {
    loadState?: (orgId: string, now: Date) => Promise<SquadState>;
  };
}

export async function answerHqQuestion(input: HqQuestionInput): Promise<{ outcome: string; replyText: string } | null> {
  const { orgId, messageId, now } = input;
  const deps = input.deps ?? {};
  let state: SquadState;
  try {
    state = deps.loadState
      ? await deps.loadState(orgId, now)
      : await (await import("./pipeline/load-state")).loadSquadState(orgId, now);
  } catch (err) {
    console.error(`[admin-group] ${messageId}: question state load failed:`, err);
    return null;
  }
  // The extractor's "MatchTime's last post" is HQ's, not the players' group's.
  state = { ...state, lastBotPost: input.lastBotPost };
  const res = await runAnswerBatch({
    orgId,
    now,
    messages: [
      {
        waMessageId: messageId,
        body: input.body,
        authorName: input.senderName,
        senderUserId: input.senderUserId,
        senderName: input.senderName,
        // Routed to MatchTime by the router: addressed to it.
        tagged: true,
        route: "question",
        gated: false,
        ...(input.lastBotPost ? { quotedMatchTime: input.lastBotPost } : {}),
      },
    ],
    history: input.history,
    // The state is loaded once, here, so the two cannot disagree.
    expectedMatchId: state.matchId,
    enabled: enabledStepSevenRoutes(process.env),
    audience: "organisers",
    deps: {
      ...(deps.model ? { model: deps.model } : {}),
      ...(deps.loadFeatures ? { loadFeatures: deps.loadFeatures } : {}),
      ...(deps.loadClub ? { loadClub: deps.loadClub } : {}),
      loadState: async () => state,
      helpReply: () => input.hqHelp,
    },
  });
  const o = res.outcomes.get(messageId);
  console.log(
    `[admin-group] ${messageId}: question ${o?.reply ? `answered (${o.intent})` : "not answered"}, ${res.cost.calls} call(s), ${res.degradations.length} degradation(s)`,
  );
  if (!o?.reply) return null;
  return { outcome: o.intent === "help" ? "hq-help" : "hq-answered", replyText: o.reply };
}
