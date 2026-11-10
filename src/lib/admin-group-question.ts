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
 * question about MatchTime as a whole gets the short HQ menu, which is what
 * MatchTime does in this group; one about a part gets that part's HQ lines
 * and its help, worded for the organisers (2026-10-28; 2026-11-10,
 * admin-group-help.ts `hqHelpTopicReply`).
 *
 * Returns null when the shared code answers nothing (a topic it does not
 * answer, a failed call, the asker's own stats link, which is a DM): the
 * caller says its one line. Logs carry ids and counts only.
 */
import type { QuotedGroupMessage } from "./reply-context";
import { runAnswerBatch, type AnswerBatchDeps } from "./pipeline/answer-batch";
import { enabledStepSevenRoutes } from "./pipeline/route-flags";
import type { SquadState } from "./pipeline/types";
import { hqHelpMenu, hqHelpTopicReply, type HqHelpGates } from "./admin-group-help";
import type { HelpClubFacts } from "./help-club-facts";

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
  /** HQ's week of chat, for an open question (`week-chat.ts`
   *  `hqWeekChat`): read only when one is asked. */
  weekChat?: () => Promise<Array<{ author: string | null; body: string; at: Date | null }>>;
  /** MatchTime's last line in HQ, never the players' group's. */
  lastBotPost: string | null;
  /** The message the question is a WhatsApp reply to (slice S4), whoever
   *  wrote it, as `admin-group-understand.ts` resolved it. */
  reply?: QuotedGroupMessage | null;
  /** Which HQ commands the club gets (`hqHelpGates`): the short HQ menu,
   *  the answer to "what can you do?" here, and each topic's lines on
   *  "help <topic>" (2026-11-10). A question about one part ("how do I turn
   *  on the pool?") gets that part's help for the organisers (2026-10-28). */
  gates: HqHelpGates;
  /** The pool switch as the request read it, for the pool's help. */
  poolEnv?: Record<string, string | undefined>;
  /** UNIFIED_ANSWERS as the route read it. Absent: the environment's flag. */
  unified?: boolean;
  deps?: Pick<
    AnswerBatchDeps,
    "model" | "loadFeatures" | "loadClub" | "loadStats" | "loadStatsPeriod" | "loadChemistry" | "loadResults" | "loadPayments" | "loadRatingProgress"
  > & {
    loadState?: (orgId: string, now: Date) => Promise<SquadState>;
    /** The club's pool and partner clubs, for the help (tests). */
    loadClubFacts?: () => Promise<HelpClubFacts>;
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
        ...(input.reply ? { reply: input.reply } : {}),
      },
    ],
    history: input.history,
    ...(input.weekChat ? { weekChat: input.weekChat } : {}),
    // The state is loaded once, here, so the two cannot disagree.
    expectedMatchId: state.matchId,
    enabled: enabledStepSevenRoutes(process.env),
    audience: "organisers",
    ...(input.unified !== undefined ? { unified: input.unified } : {}),
    // Read by the unified answer's pool facts only; the help below is HQ's own.
    ...(input.poolEnv ? { poolEnv: async () => input.poolEnv! } : {}),
    deps: {
      ...(deps.model ? { model: deps.model } : {}),
      ...(deps.loadFeatures ? { loadFeatures: deps.loadFeatures } : {}),
      ...(deps.loadClub ? { loadClub: deps.loadClub } : {}),
      ...(deps.loadStats ? { loadStats: deps.loadStats } : {}),
      ...(deps.loadStatsPeriod ? { loadStatsPeriod: deps.loadStatsPeriod } : {}),
      ...(deps.loadChemistry ? { loadChemistry: deps.loadChemistry } : {}),
      ...(deps.loadResults ? { loadResults: deps.loadResults } : {}),
      ...(deps.loadPayments ? { loadPayments: deps.loadPayments } : {}),
      ...(deps.loadRatingProgress ? { loadRatingProgress: deps.loadRatingProgress } : {}),
      // The unified answer's pool and partner facts: the help's own read.
      ...(deps.loadClubFacts ? { loadClubFacts: async () => deps.loadClubFacts!() } : {}),
      loadState: async () => state,
      // The menu for MatchTime as a whole; one part's help, for the
      // organisers, with public links (a group), for a part.
      helpReply: async (req, features) => {
        const club = deps.loadClubFacts ? await deps.loadClubFacts() : undefined;
        const common = { orgId, lang: input.lang, gates: input.gates, features, ...(input.poolEnv ? { poolEnv: input.poolEnv } : {}), ...(club ? { club } : {}) };
        if (req.topic === null) return hqHelpMenu(common);
        return hqHelpTopicReply({ ...common, req: { ...req, topic: req.topic } });
      },
    },
  });
  const o = res.outcomes.get(messageId);
  console.log(
    `[admin-group] ${messageId}: question ${o?.reply ? `answered (${o.intent})` : "not answered"}, ${res.cost.calls} call(s), ${res.degradations.length} degradation(s)`,
  );
  if (!o?.reply) return null;
  return { outcome: o.intent === "help" ? "hq-help" : "hq-answered", replyText: o.reply };
}
