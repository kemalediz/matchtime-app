/**
 * A TAGGED MESSAGE MATCHTIME CANNOT ACT ON IS ANSWERED, NOT DEAD-ENDED
 * (2026-11-17).
 *
 * The incident: the Vets organiser tagged MatchTime with something it has
 * no action for, the admin extractor said "other", and MatchTime posted
 * "Sorry, I can't do that one yet." He deleted it twice on 16 Nov. The
 * other dead ends were the same shape: a team change MatchTime cannot make
 * ("can't do that one yet"), and a tagged message nothing came of ("I
 * didn't catch what you'd like me to do. Type @Match Time help...").
 *
 * Each now goes to THE UNIFIED ANSWER (`pipeline/unified-answer.ts`), the
 * one read-only answer over all the club's data, through the shared
 * answering path (`runAnswerBatch` with `deadEnds`), told NOT DONE, why its
 * path stopped when the path said (2026-11-18, Sutton 17 Nov 19:23: "swap
 * Sam with Alex" named nobody in the squad, and without that the answer
 * guessed "I can't swap players from here", which is false), whether the
 * asker is an organiser, and this group's help menu. It can answer what was
 * really asked, say plainly what went wrong and what MatchTime can do
 * instead, or ask one short question. It changes nothing and its grounding
 * check refuses invented facts. The canned line stays only as the fallback:
 * a failed or refused answer, or the daily AI cap.
 *
 * WHICH MESSAGE IS A DEAD END is read from the OUTCOME (its intent), never
 * from the words, and only for a message that really tagged MatchTime:
 * untagged chatter stays silent exactly as before. HQ hands its dead ends
 * to the same answer through `answerHqQuestion` (`admin-group-understand.ts`).
 */
import { runAnswerBatch, type AnswerBatchDeps, type AnswerBatchMessage, type AnswerAudience } from "./pipeline/answer-batch";
import type { Route } from "./pipeline/types";

/** The intents of the canned "can't do that" outcomes: the admin
 *  extractor's "other" (`admin-ops-engine-batch.ts`), a team change this
 *  path cannot make (`team-ops-engine-batch.ts`), and the not-understood
 *  line for a tagged message nothing came of (the analyze route). */
export const DEAD_END_INTENTS: ReadonlySet<string> = new Set(["request_not_handled", "team_request_unsupported", "not_understood"]);

/** PURE. Is this outcome a dead end MatchTime should answer instead? A
 *  canned line was said, for a message that really tagged MatchTime. */
export function isDeadEnd(r: { intent?: string | null; reply?: string | null }, taggedExplicitly: boolean): boolean {
  return taggedExplicitly && !!r.reply && DEAD_END_INTENTS.has(r.intent ?? "");
}

/**
 * The unified answer to each dead end, by message id. NEVER THROWS: a
 * message with no answer here (a failed call, a refused reply, a state that
 * could not be read) is simply absent, and the caller keeps its line.
 */
export async function answerDeadEnds(args: {
  orgId: string;
  now: Date;
  /** Each with why its path stopped, when the path said (`deadEndWhy` on
   *  the team and admin outcomes): a fact the code has, never the words. */
  messages: Array<AnswerBatchMessage & { why?: string | null }>;
  history: Array<{ author: string | null; body: string }>;
  weekChat?: () => Promise<Array<{ author: string | null; body: string; at: Date | null }>>;
  expectedMatchId: string | null;
  enabled: Set<Route>;
  audience?: AnswerAudience;
  monthNotStarted?: boolean;
  poolEnv?: () => Promise<Record<string, string | undefined>>;
  deps?: AnswerBatchDeps;
}): Promise<Map<string, { reply: string; intent: string }>> {
  const out = new Map<string, { reply: string; intent: string }>();
  if (args.messages.length === 0) return out;
  try {
    const res = await runAnswerBatch({
      orgId: args.orgId,
      now: args.now,
      // Each is read as a tagged question: the caller has checked the tag.
      messages: args.messages.map(({ why: _why, ...m }) => ({ ...m, route: "question" as Route, tagged: true, addressed: true, gated: false })),
      history: args.history,
      ...(args.weekChat ? { weekChat: args.weekChat } : {}),
      expectedMatchId: args.expectedMatchId,
      enabled: args.enabled,
      ...(args.audience ? { audience: args.audience } : {}),
      ...(args.monthNotStarted !== undefined ? { monthNotStarted: args.monthNotStarted } : {}),
      ...(args.poolEnv ? { poolEnv: args.poolEnv } : {}),
      deadEnds: new Map(args.messages.map((m) => [m.waMessageId, { why: m.why ?? null }])),
      deps: args.deps ?? {},
    });
    for (const d of res.degradations) console.log(`[dead-end] ${d}`);
    for (const [id, o] of res.outcomes) if (o.reply?.trim()) out.set(id, { reply: o.reply, intent: o.intent });
    // Ids and counts only (Kemal's logging rule).
    console.log(`[dead-end] ${out.size} of ${args.messages.length} answered by the unified answer, ${res.cost.calls} call(s), $${res.cost.usd.toFixed(5)}`);
  } catch (err) {
    console.error("[dead-end] the unified answer for the dead ends failed; their lines stand:", err);
  }
  return out;
}
