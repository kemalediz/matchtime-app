/**
 * ONE REPLY FOR A CHANGE THAT ALSO ASKS MATCHTIME SOMETHING, IN THE
 * PLAYERS' GROUP (#392 follow-up, Kemal 2026-10-24).
 *
 * "@Match Time I'm out, what's the list?": the attendance engine makes the
 * change and says what it says (a react, sometimes a line); the players'
 * group's question answering (`runAnswerBatch`'s `alsoAsks`) answers the
 * question from the state after the change. This joins the two into the
 * message's ONE reply, change first, answer second, the way the analyze
 * route already joins a squad post to an ack.
 *
 *   - An answer that IS the squad (the list, the count) becomes the
 *     `[SQUAD]` marker after the engine's line, so the batch-final pass
 *     composes the list from the database once, keeps the engine's line as
 *     its lead, and still posts one list per batch.
 *   - An answer that pass must not touch (a stats table, the help
 *     explainer, a team post: `skipsSquadComposition`) is added AFTER that
 *     pass, so a leaderboard is never replaced by the squad.
 *   - Anything else (kickoff, a person's place) is joined now, so the pass
 *     checks it exactly as it checks a standalone answer.
 *
 * Never used for a club whose organisers announce the list: the analyze
 * route asks nothing there, so those clubs hear exactly what they did.
 */
import {
  SQUAD_POST_MARKER,
  displaysSquadState,
  skipsSquadComposition,
  wantsSquadPost,
} from "./group-copy";

export interface AlsoAnswer {
  reply: string | null;
  intent: string;
}

export function joinAlsoAnswered(
  engineReply: string | null,
  answer: AlsoAnswer | null | undefined,
  lang?: string | null,
): { reply: string | null; afterComposition: string | null } {
  if (!answer?.reply) return { reply: engineReply, afterComposition: null };
  if (skipsSquadComposition(answer.intent)) return { reply: engineReply, afterComposition: answer.reply };
  if (!engineReply) return { reply: answer.reply, afterComposition: null };
  const squadShaped = wantsSquadPost(answer.reply) || displaysSquadState(answer.reply, lang);
  return {
    reply: `${engineReply}\n\n${squadShaped ? SQUAD_POST_MARKER : answer.reply}`,
    afterComposition: null,
  };
}

/** The deferred half, after the batch-final squad pass. */
export function appendAfterComposition(reply: string | null, text: string): string {
  return reply ? `${reply}\n\n${text}` : text;
}
